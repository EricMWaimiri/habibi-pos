const jwt = require('jsonwebtoken');
const { assertSessionVersion, assertSessionClaims } = require('./session-version');

function signToken(user, audience) {
  assertSessionVersion(user.sessionVersion);
  const token = jwt.sign(
    { id: user.id, role: user.role, sessionVersion: user.sessionVersion, transport: 'cookie-v1', jti: require('node:crypto').randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h', ...(audience ? { audience } : {}) }
  );
  // Retain the existing duration configuration, but never issue beyond 12h.
  assertSessionClaims(jwt.decode(token));
  return token;
}

function verifyToken(token, audience) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], ...(audience ? { audience } : {}) });
  if (decoded.transport !== 'cookie-v1' || typeof decoded.jti !== 'string' || !/^[a-f0-9-]{36}$/.test(decoded.jti)) throw new Error('Please log in again');
  assertSessionClaims(decoded);
  return Object.freeze({ id: decoded.id, sessionVersion: decoded.sessionVersion, iat: decoded.iat, exp: decoded.exp });
}

module.exports = { signToken, verifyToken };
