'use strict';
const { verifyToken } = require('../utils/jwt');
const { assertCurrentSession, assertSessionClaims } = require('../utils/session-version');
const { effectivePermissions } = require('../utils/admin-policy');

const VALIDATION_INTERVAL_MS = 5000;
const VERIFICATION_TIMEOUT_MS = 2000;
const denied = () => Object.assign(new Error('Please log in again'), { data: { code: 'SESSION_INVALID' } });

// No DB/config imports: callers must supply the primary client. No session cache.
function secureSockets(io, primary) {
  const records = new Map();
  const pending = new WeakMap();
  async function bounded(work) {
    let timer;
    try {
      return await Promise.race([work(), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(denied()), VERIFICATION_TIMEOUT_MS);
      })]);
    } finally { clearTimeout(timer); }
  }
  function disconnect(socket) {
    if (socket.connected) { socket.emit('session:invalid'); socket.disconnect(true); }
  }
  async function check(socket, record, permissions = false) {
    const fence = record.fence;
    try {
      const result = await bounded(async () => {
        const user = await assertCurrentSession(primary, record.claims);
        const rows = permissions ? await primary.rolePermission.findMany({ where: { role: user.role, enabled: true }, select: { permission: true } }) : [];
        assertSessionClaims(record.claims); // Expiry may pass while awaiting DB.
        return { user, grants: permissions ? await require('../utils/custom-role-policy').resolveUserPermissions(primary,user) : [] };
      });
      if (!socket.connected || fence !== record.fence) return null;
      return result;
    } catch { disconnect(socket); return null; }
  }
  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth;
      const session = require('../utils/web-session');
      if (!auth || Object.keys(auth).length !== 1 || typeof auth.csrfToken !== 'string' || socket.handshake.query.token || !session.validProof(socket.request, auth.csrfToken)) throw denied();
      const token = session.sessionToken(socket.request);
      if (!token) throw denied();
      const claims = verifyToken(token, socket.request.headers.host);
      await bounded(() => assertCurrentSession(primary, claims));
      assertSessionClaims(claims);
      // Do not retain the bearer token or put private claims in socket.data.
      delete socket.handshake.auth.csrfToken;
      delete socket.handshake.headers.cookie;
      delete socket.request.headers.cookie;
      pending.set(socket, { claims, fence: 0 });
      next();
    } catch { next(denied()); }
  });
  io.on('connection', socket => {
    const record = pending.get(socket);
    if (!record) { socket.disconnect(true); return; }
    pending.delete(socket); records.set(socket, record);
    // No client-originated business/subscription/room events exist. Deny all.
    socket.use((packet, next) => { disconnect(socket); });
    const interval = setInterval(() => { void check(socket, record); }, VALIDATION_INTERVAL_MS);
    const expiry = setTimeout(() => disconnect(socket), Math.max(0, record.claims.exp * 1000 - Date.now()));
    interval.unref?.(); expiry.unref?.();
    socket.on('disconnect', () => { clearInterval(interval); clearTimeout(expiry); records.delete(socket); });
    // Close the handshake/connection scheduling gap before any application send.
    void check(socket, record);
  });
  const service = {
    async revalidateUser(id) {
      await Promise.all([...records].filter(([, record]) => record.claims.id === id).map(([socket, record]) => {
        ++record.fence; return check(socket, record);
      }));
    },
    async publish(event, payload) {
      const permissionNotice = event === 'permissions:changed';
      if (!permissionNotice && !['docket:created', 'docket:updated', 'docket:cancelled'].includes(event)) return;
      if (!permissionNotice && (!payload || typeof payload.saleId !== 'string' || !payload.saleId.trim() || payload.saleId.length > 128)) return;
      // Explicit allowlists: never forward arbitrary model objects/financial data.
      const notice = permissionNotice ? { at: Date.now() } : { saleId: payload.saleId };
      await Promise.all([...records].map(async ([socket, record]) => {
        const fence = record.fence;
        const current = await check(socket, record, !permissionNotice);
        if (!current || !socket.connected || fence !== record.fence) return;
        try { assertSessionClaims(record.claims); } catch { disconnect(socket); return; }
        // Dockets expose no sale details, but even their IDs require all-sale access.
        if (!permissionNotice && !current.grants.includes('sales.view_all')) return;
        socket.emit(event, notice);
      }));
    },
  };
  io.posSecurity = Object.freeze(service);
  return service;
}

function notifySessionChange(app, id) {
  // Post-commit notification is supplementary; remote processes use fresh reads.
  try { const service = app.get('io')?.posSecurity; if (service) void service.revalidateUser(id).catch(() => {}); } catch {}
}
module.exports = { secureSockets, notifySessionChange, VALIDATION_INTERVAL_MS, VERIFICATION_TIMEOUT_MS };
