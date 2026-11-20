const { verifyToken } = require('../utils/jwt');
const { assertCurrentSession, authenticationError } = require('../utils/session-version');
const prisma = require('../config/prisma');

function authenticate(req, res, next) {
  let token;
  try { token = require('../utils/web-session').sessionToken(req); } catch {}

  if (!token) {
    return res.status(401).json({ message: authenticationError().message });
  }

  try {
    req.auth = verifyToken(token, req.headers.host);
    req.user = { id: req.auth.id };
    next();
  } catch (err) {
    return res.status(401).json({ message: authenticationError().message });
  }
}

async function requireActiveUser(req, res, next) {
  try {
    req.user = await assertCurrentSession(prisma, req.auth);
  } catch (err) {
    return next(err);
  }
  next();
}

module.exports = { authenticate, requireActiveUser };
