'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');
const sessions = require('../src/utils/session-version');
const tokens = require('../src/utils/jwt');
const web=require('../src/utils/web-session');
const { hashPin } = require('../src/utils/pin');
function load(file, deps) {
  const m = { exports: {} };
  new Function('require', 'module', 'process', fs.readFileSync(file, 'utf8'))(name => {
    if (Object.hasOwn(deps, name)) return deps[name]; throw Error('Unexpected unit dependency');
  }, m, process);
  return m.exports;
}
const claims = (sessionVersion = 0) => { const iat = Math.floor(Date.now() / 1000); return { id: 'actor', sessionVersion, iat, exp: iat + 3600 }; };
const user = () => ({ id: 'actor', name: 'Fixture', role: 'CASHIER', isActive: true, sessionVersion: 0, pinHash: hashPin('123456', process.env.PIN_PEPPER) });
function response() { return { cookies:{},cookie(name,value){this.cookies[name]=value;return this;},clearCookie(name){delete this.cookies[name];return this;},statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; }, set() { return this; }, end() { this.ended = true; } }; }
function controller({ beforeGuard, failWrite = false } = {}) {
  let row = user(), guards = 0, writes = 0;
  const db = { user: {
    async findUnique({ where }) { return where.id === row.id || where.pinHash === row.pinHash ? { ...row } : null; },
    async update({ data }) { writes++; if (failWrite) throw Error('simulated rollback'); row = { ...row, sessionVersion: row.sessionVersion + data.sessionVersion.increment }; },
  } };
  const auth = load('src/controllers/auth.controller.js', {
    '../utils/web-session':web, '../config/prisma': db, '../utils/responses': require('../src/utils/responses'), '../utils/jwt': tokens,
    '../utils/pin': { hashPin }, '../utils/asyncHandler': fn => fn, '../middlewares/validate': { z: require('zod').z },
    '../utils/admin-transactions': { async withAdminTransaction(client, options, work) { guards++; if (beforeGuard) beforeGuard(row); return work(db); } },
    '../utils/session-version': sessions,
    '../sockets/security': { notifySessionChange() {} },
  });
  return { auth, db, get: () => row, counts: () => ({ guards, writes }) };
}

test('session auth: new JWT includes explicit version, with immutable internal claims and no role authority', () => {
  const token = tokens.signToken(user()), verified = tokens.verifyToken(token);
  assert.equal(verified.sessionVersion, 0); assert.equal(verified.id, 'actor'); assert(Object.isFrozen(verified));
  assert.equal(verified.role, undefined); assert.throws(() => tokens.signToken({ id: 'actor', role: 'MANAGER' }), e => e.status === 401);
});

test('session auth: versionless, expired, malformed and wrong-algorithm JWTs reject', () => {
  const examples = [
    jwt.sign({ id: 'actor' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
    jwt.sign({ ...claims(), sessionVersion: '0' }, process.env.JWT_SECRET),
    jwt.sign({ ...claims(), exp: 1 }, process.env.JWT_SECRET),
    jwt.sign(claims(), process.env.JWT_SECRET, { algorithm: 'HS384' }), 'invalid',
  ];
  for (const token of examples) assert.throws(() => tokens.verifyToken(token));
});

test('session auth: existing lifetime config is respected with an enforced 12-hour ceiling', () => {
  const old = process.env.JWT_EXPIRES_IN;
  try {
    process.env.JWT_EXPIRES_IN = '12h'; const c = tokens.verifyToken(tokens.signToken(user())); assert.equal(c.exp - c.iat, 43200);
    process.env.JWT_EXPIRES_IN = '13h'; assert.throws(() => tokens.signToken(user()), e => e.status === 401);
  } finally { if (old === undefined) delete process.env.JWT_EXPIRES_IN; else process.env.JWT_EXPIRES_IN = old; }
});

test('session auth: guarded assertions recheck expiry after waiting and never read on malformed context', async () => {
  let reads = 0; const db = { user: { async findUnique() { reads++; return user(); } } };
  await assert.rejects(sessions.assertCurrentSession(db, { ...claims(), exp: 1 }), e => e.status === 401);
  await assert.rejects(sessions.assertCurrentSession(db, undefined), e => e.status === 401); assert.equal(reads, 0);
  await sessions.assertCurrentSession(db, claims()); assert.equal(reads, 1);
});

test('session auth: HTTP uses fresh role/version identity and generic denial without credentials', async () => {
  let row = user(); const db = { user: { async findUnique() { return row; } } };
  const middleware = load('src/middlewares/auth.middleware.js', { '../utils/web-session':web,'../utils/jwt': tokens, '../utils/session-version': sessions, '../config/prisma': db });
  const req = { headers: { host:'pos.test',cookie:web.SESSION+'='+tokens.signToken(row,'pos.test') } }; let nexts = 0;
  middleware.authenticate(req, response(), () => nexts++);
  await middleware.requireActiveUser(req, response(), e => { assert.ifError(e); nexts++; }); assert.equal(nexts, 2);
  assert.equal(req.user.pinHash, undefined); assert.equal(req.user.sessionVersion, undefined); assert.equal(req.user.name, 'Fixture');
  row = { ...row, sessionVersion: 1 }; let error;
  await middleware.requireActiveUser(req, response(), e => { error = e; }); assert.equal(error.status, 401);
  for (const authorization of ['', 'Bearer invalid']) { const res = response(); middleware.authenticate({ headers: { authorization } }, res, () => assert.fail()); assert.equal(res.statusCode, 401); assert.equal(res.data.message, 'Please log in again'); }
});

test('session auth: middleware database failures deny access without credentials or a cache fallback', async () => {
  const db = { user: { async findUnique() { throw Object.assign(Error('private database URL'), { code: 'P1001' }); } } };
  const middleware = load('src/middlewares/auth.middleware.js', { '../utils/web-session':web,'../utils/jwt': tokens, '../utils/session-version': sessions, '../config/prisma': db });
  await middleware.requireActiveUser({ auth: claims() }, response(), e => { assert.equal(e.status, 503); assert.equal(e.message, 'Authentication temporarily unavailable'); });
});

test('session auth: login signs only the revalidated guarded user and never exposes version outside JWT', async () => {
  const b = controller(), res = response(); await b.auth.login({ body: { pin: '123456' },headers:{host:'pos.test'} }, res);
  assert.equal(res.statusCode, 200); assert.equal(tokens.verifyToken(res.cookies[web.SESSION],'pos.test').sessionVersion, 0);
  assert.equal(res.data.token,undefined); assert.deepEqual(res.data.user, { id: 'actor', name: 'Fixture', role: 'CASHIER' }); assert.equal(b.counts().guards, 1);
});

test('session auth: completed invalidation between credential proof and guarded issuance prevents stale token issuance', async () => {
  for (const change of [row => row.sessionVersion++, row => { row.isActive = false; row.sessionVersion++; }, row => { row.pinHash = 'changed'; row.sessionVersion++; }]) {
    const b = controller({ beforeGuard: change });
    await assert.rejects(b.auth.login({ body: { pin: '123456' } }, response()), e => e.status === 401);
  }
});

test('session auth: logout returns empty 204 once, old claims cannot increment twice', async () => {
  const b = controller(), req = { user: { id: 'actor' }, auth: claims(), body: {}, query: {} }, res = response();
  await b.auth.logout(req, res); assert.equal(res.statusCode, 204); assert(res.ended); assert.equal(res.data, undefined); assert.equal(b.get().sessionVersion, 1);
  await assert.rejects(b.auth.logout(req, response()), e => e.status === 401); assert.equal(b.counts().writes, 1);
});

test('session auth: logout rejects payload selectors, overflow and write failure without successful increment', async () => {
  const b = controller(), req = { user: { id: 'actor' }, auth: claims(), body: { id: 'other' }, query: {} }, res = response();
  await b.auth.logout(req, res); assert.equal(res.statusCode, 400); assert.equal(b.counts().writes, 0);
  const max = controller({ beforeGuard: row => { row.sessionVersion = 2147483647; } });
  await assert.rejects(max.auth.logout({ ...req, body: {}, auth: claims(2147483647) }, response()), e => e.status === 409); assert.equal(max.counts().writes, 0);
  const fail = controller({ failWrite: true }); await assert.rejects(fail.auth.logout({ ...req, body: {} }, response()), /simulated rollback/); assert.equal(fail.get().sessionVersion, 0);
});
