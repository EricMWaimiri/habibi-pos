'use strict';
// Same-origin browser access behind a separately approved loopback HTTPS gateway.
// Gateway identity headers and forwarded headers never grant POS authority.
function remoteAccess(env = process.env) {
  const fail = () => new Error('Invalid remote access configuration');
  const port = String(env.PORT || 3000);
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw fail();
  const local = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  function httpsOrigin(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.origin !== value ||
          !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(u.hostname) ||
          !u.hostname.includes('.') || u.hostname.endsWith('.') ||
          u.hostname.endsWith('.localhost') || u.hostname === 'localhost' ||
          /^[0-9.]+$/.test(u.hostname)) throw fail();
      return u.origin;
    } catch { throw fail(); }
  }
  let configured = [];
  if (env.POS_LAN_ORIGIN !== undefined || env.POS_REMOTE_ORIGIN !== undefined) {
    const lan = httpsOrigin(env.POS_LAN_ORIGIN), remote = httpsOrigin(env.POS_REMOTE_ORIGIN);
    if (lan === remote || !new URL(remote).hostname.endsWith('.ts.net')) throw fail();
    configured = [lan, remote];
    if (env.POS_PUBLIC_ORIGIN !== undefined && !configured.includes(env.POS_PUBLIC_ORIGIN)) throw fail();
  } else if (env.POS_PUBLIC_ORIGIN !== undefined) configured = [httpsOrigin(env.POS_PUBLIC_ORIGIN)];
  const publicOrigin = configured[0];
  const origins = new Set(publicOrigin ? configured : local);
  if (env.CLIENT_URL && !origins.has(env.CLIENT_URL)) throw fail();
  const hosts = new Set([...origins].map(o => new URL(o).host));
  const allowedOrigin = origin => typeof origin === 'string' && origins.has(origin);
  const allowedRequest = (req, socket = false) => {
    if (!hosts.has(req.headers.host)) return false;
    const origin = req.headers.origin;
    if (origin !== undefined) return allowedOrigin(origin) && new URL(origin).host === req.headers.host;
    // Same-origin browser XHR polling GETs may omit Origin. A WebSocket upgrade
    // must always carry it remotely. Neither exception grants session authority.
    const polling = req._query?.transport === 'polling' || (typeof req.url === 'string' &&
      new URL(req.url, 'http://localhost').searchParams.get('transport') === 'polling');
    const site = req.headers['sec-fetch-site'];
    return !socket || !publicOrigin || (polling && (!site || site === 'same-origin'));
  };
  return Object.freeze({
    remote: !!publicOrigin,
    origin: publicOrigin || local[0],
    origins: Object.freeze([...origins]),
    cors: { origin: (origin, callback) => callback(null, allowedOrigin(origin)), credentials: false },
    middleware(req, res, next) {
      // Permit only a local, non-browser liveness probe on the private listener.
      const health = req.method === 'GET' && req.url === '/health' &&
        !req.headers.origin && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
        local.some(o => new URL(o).host === req.headers.host);
      res.setHeader('Cache-Control', 'no-store');
      if (!health && !allowedRequest(req)) return res.status(403).json({ message: 'Request origin not allowed' });
      next();
    },
    allowRequest: (req, callback) => callback(null, allowedRequest(req, true)),
    engineMiddleware(req, res, next) {
      if (!allowedRequest(req, true)) {
        // Engine.IO owns both real HTTP responses and its WebSocket response
        // adapter. Its middleware error path reliably rejects both transports.
        return next(new Error('Request origin not allowed'));
      }
      next();
    },
    helmet: {
      contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': publicOrigin ? [] : null } },
      hsts: publicOrigin ? { maxAge: 31536000, includeSubDomains: false, preload: false } : false,
      referrerPolicy: { policy: 'no-referrer' },
    },
  });
}
module.exports = { remoteAccess };
