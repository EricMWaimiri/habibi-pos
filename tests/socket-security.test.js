'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { secureSockets, VALIDATION_INTERVAL_MS, VERIFICATION_TIMEOUT_MS } = require('../src/sockets/security');
const { socketClient, event, connected } = require('./socket-client');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
let server, io, service, base, users, clients, db, broken;
const token = (id = 'staff', extra = {}, expiresIn = '1h') => jwt.sign({ id, sessionVersion: users[id].sessionVersion, transport:'cookie-v1',jti:require('node:crypto').randomUUID(), ...extra }, process.env.JWT_SECRET, { expiresIn,audience:new URL(base).host });
const client = value => { const socket = socketClient(base, value); clients.push(socket); return socket; };
beforeEach(async () => {
  clients = []; broken = false;
  users = { staff: { id: 'staff', role: 'WAITER', isActive: true, sessionVersion: 0 }, manager: { id: 'manager', role: 'MANAGER', isActive: true, sessionVersion: 0 } };
  db = { userCustomRole: {findUnique:async()=>null}, user: { async findUnique({ where }) { if (broken) throw Error('private connection data'); return users[where.id] ? { ...users[where.id] } : null; } },
    rolePermission: { async findMany({ where }) { return where.role === 'MANAGER' ? [{ permission: 'sales.view_all' }] : []; } } };
  server = http.createServer((req, res) => res.end('test')); io = new Server(server); service = secureSockets(io, db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
});
afterEach(async () => { clients.forEach(socket => socket.close()); await new Promise(resolve => io.close(resolve)); });

for (const scenario of ['missing', 'malformed', 'expired', 'legacy', 'negative', 'fractional', 'revoked', 'inactive', 'database']) {
  test('socket auth: rejects ' + scenario + ' with generic errors and no broadcasts', async () => {
    let value = token();
    if (scenario === 'missing') value = undefined;
    if (scenario === 'malformed') value = 'invalid';
    if (scenario === 'expired') value = token('staff', {}, -1);
    if (scenario === 'legacy') value = jwt.sign({ id: 'staff' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    if (scenario === 'negative') value = token('staff', { sessionVersion: -1 });
    if (scenario === 'fractional') value = token('staff', { sessionVersion: 0.5 });
    if (scenario === 'revoked') users.staff.sessionVersion++;
    if (scenario === 'inactive') users.staff.isActive = false;
    if (scenario === 'database') broken = true;
    const socket = client(value), failure = event(socket, 'connect_error'); let received = 0;
    socket.on('permissions:changed', () => received++); socket.connect();
    const error = await failure;
    assert.equal(error.message, 'Please log in again'); assert.deepEqual(error.data, { code: 'SESSION_INVALID' });
    await service.publish('permissions:changed'); assert.equal(received, 0); assert.equal(io.of('/').sockets.size, 0);
  });
}

test('socket auth: valid signed identity receives only minimal authenticated notices', async () => {
  const socket = await connected(client(token('staff', { role: 'MANAGER' })));
  const notice = event(socket, 'permissions:changed');
  await service.publish('permissions:changed', { token: 'private', role: 'MANAGER', pinHash: 'private' });
  const value = await notice; assert.deepEqual(Object.keys(value), ['at']);
  assert.equal(socket.io.opts.query?.token, undefined);
  const serverSocket = [...io.of('/').sockets.values()][0]; assert.deepEqual(serverSocket.data, {}); assert.equal(serverSocket.handshake.auth.token, undefined);
});

test('socket auth: a correctly shaped JWT with a forged signature is rejected', async () => {
  const value = jwt.sign({ id: 'staff', sessionVersion: 0 }, 'different-fixture-key', { expiresIn: '1h' });
  const socket = client(value), failure = event(socket, 'connect_error'); socket.connect();
  assert.equal((await failure).message, 'Please log in again');
});

test('socket auth: client roles and permission claims cannot supplement the handshake contract', async () => {
  const socket = client(token()); socket.auth.role = 'MANAGER'; socket.auth.permissions = ['sales.view_all'];
  const failure = event(socket, 'connect_error'); socket.connect(); assert.equal((await failure).message, 'Please log in again');
});

test('socket auth: query-string credentials are refused even alongside valid auth', async () => {
  const socket = client(token()); socket.io.opts.query = { token: 'must-not-be-authority' };
  const failure = event(socket, 'connect_error'); socket.connect(); assert.equal((await failure).message, 'Please log in again');
});

for (const name of ['join', 'subscribe', 'permissions:update', 'sale:create']) test('socket auth: rejects unauthorized client event ' + name, async () => {
  const socket = await connected(client(token())); const closed = event(socket, 'disconnect');
  const serverSocket = [...io.of('/').sockets.values()][0];
  socket.emit(name, { room: 'another-user', role: 'MANAGER', permissions: ['permissions.manage'] });
  await closed; assert.equal(serverSocket.rooms.size, 0);
});

test('socket auth: docket isolation uses fresh grants and never forwards financial/staff payloads', async () => {
  const manager = await connected(client(token('manager'))), staff = await connected(client(token()));
  let leaks = 0; staff.on('docket:created', () => leaks++);
  const notice = event(manager, 'docket:created'); await service.publish('docket:created', { saleId: 'sale', cost: 500, pinHash: 'secret', commission: 20 });
  assert.deepEqual(await notice, { saleId: 'sale' }); assert.equal(leaks, 0);
  db.rolePermission.findMany = async () => []; // No permission cache.
  let later = 0; manager.on('docket:created', () => later++);
  await service.publish('docket:created', { saleId: 'sale' }); assert.equal(later, 0);
  await service.publish('docket:unknown', { saleId: 'sale' }); await service.publish('docket:created', { saleId: {} });
});

for (const action of ['logout', 'PIN reset', 'role change', 'deactivation']) test('socket revoke: post-commit ' + action + ' disconnects and rejects old reconnect', async () => {
  const old = token(), socket = await connected(client(old)), closed = event(socket, 'disconnect');
  users.staff.sessionVersion++; if (action === 'role change') users.staff.role = 'CASHIER'; if (action === 'deactivation') users.staff.isActive = false;
  const began = Date.now(); await service.revalidateUser('staff'); await closed;
  assert(Date.now() - began < VERIFICATION_TIMEOUT_MS + 1000);
  const stale = client(old), error = event(stale, 'connect_error'); stale.connect(); assert.equal((await error).message, 'Please log in again');
  users.staff.isActive = true; const fresh = await connected(client(token())); assert(fresh.connected);
});

test('socket revoke: periodic fresh validation observes remote-instance revocation within the documented bound', async () => {
  const socket = await connected(client(token())), closed = event(socket, 'disconnect');
  const began = Date.now(); users.staff.sessionVersion++; await closed;
  const elapsed = Date.now() - began; console.log('# Socket periodic revocation observed in ' + elapsed + ' ms');
  assert(elapsed <= VALIDATION_INTERVAL_MS + VERIFICATION_TIMEOUT_MS + 1000);
});

test('socket revoke: expiry disconnects without another request or broadcast', async () => {
  const socket = await connected(client(token('staff', {}, 2))), closed = event(socket, 'disconnect'); await closed; assert.equal(socket.connected, false);
});

test('socket revoke: database errors and stalled verification disconnect fail closed', async () => {
  const socket = await connected(client(token())), closed = event(socket, 'disconnect'); broken = true;
  await service.publish('permissions:changed'); await closed;
  broken = false; const next = await connected(client(token())), dropped = event(next, 'disconnect');
  db.user.findUnique = () => new Promise(() => {});
  const began = Date.now(); await service.publish('permissions:changed'); await dropped;
  assert(Date.now() - began <= VERIFICATION_TIMEOUT_MS + 1000);
});

test('socket revoke: no notice passes a revocation during an in-flight authorization read', async () => {
  const socket = await connected(client(token())); await new Promise(resolve => setTimeout(resolve, 10));
  let release, started; const held = new Promise(resolve => { started = resolve; });
  const original = db.user.findUnique;
  db.user.findUnique = async args => { const result = await original(args); started(); await new Promise(resolve => { release = resolve; }); return result; };
  let count = 0; socket.on('permissions:changed', () => count++);
  const publishing = service.publish('permissions:changed'); await held;
  db.user.findUnique = original; users.staff.sessionVersion++;
  const revoked = service.revalidateUser('staff'); release(); await Promise.all([publishing, revoked]); assert.equal(count, 0);
});
