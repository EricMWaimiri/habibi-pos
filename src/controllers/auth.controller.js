const prisma = require('../config/prisma');
const response = require('../utils/responses');
const { signToken } = require('../utils/jwt');
const { hashPin } = require('../utils/pin');
const asyncHandler = require('../utils/asyncHandler');
const { z } = require('../middlewares/validate');
const { withAdminTransaction } = require('../utils/admin-transactions');
const { assertCurrentSession, nextSessionVersion } = require('../utils/session-version');
const { notifySessionChange } = require('../sockets/security');

const LOGIN_SCHEMA = z.object({
  body: z.object({
    pin: z.string().min(1),
  }),
});

const login = asyncHandler(async (req, res) => {
  const { pin } = req.body;

  if (!pin) {
    return res.status(400).json({ message: 'PIN is required' });
  }

  const pinHash = hashPin(pin, process.env.PIN_PEPPER);
  const candidate = await prisma.user.findUnique({
    where: { pinHash },
  });

  if (!candidate || !candidate.isActive) {
    return res.status(401).json({ message: 'Invalid PIN' });
  }

  // Current credential mechanism is HMAC, not bcrypt. Credential lookup/hash is
  // outside the global guard; recheck the exact verified snapshot under its lock.
  let result;
  try {
    result = await withAdminTransaction(prisma, { targetIds: [candidate.id] }, async tx => {
      const user = await tx.user.findUnique({ where: { id: candidate.id } });
      if (!user || !user.isActive || user.pinHash !== pinHash || user.sessionVersion !== candidate.sessionVersion) {
        throw Object.assign(new Error('Invalid PIN'), { status: 401 });
      }
      return { token: signToken(user, req.headers.host), user: { id: user.id, name: user.name, role: user.role } };
    });
  } catch (error) {
    if (error.status === 404) throw Object.assign(new Error('Invalid PIN'), { status: 401 });
    throw error;
  }

  const csrfToken = require('../utils/web-session').establish(req, res, result.token);
  res.set('Cache-Control', 'no-store').json({
    message: 'Login successful',
    user: result.user,
    csrfToken,
    sessionContext: require('../utils/web-session').context(req, result.token),
  });
});

const logout = asyncHandler(async (req, res) => {
  if (Object.keys(req.query || {}).length || (req.body !== undefined &&
      (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' || Object.keys(req.body).length))) {
    return res.status(400).json({ message: 'Invalid logout request' });
  }
  await withAdminTransaction(prisma, { actorId: req.user.id }, async tx => {
    await assertCurrentSession(tx, req.auth);
    nextSessionVersion(req.auth.sessionVersion);
    await tx.user.update({ where: { id: req.user.id }, data: { sessionVersion: { increment: 1 } } });
  });
  notifySessionChange(req.app, req.user.id);
  require('../utils/web-session').clear(res);
  res.set('Cache-Control', 'no-store').status(204).end();
});

const getMe = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ user: response.identity(req.user), csrfToken: require('../utils/web-session').proof(req), sessionContext: require('../utils/web-session').context(req) });
});

module.exports = { login, logout, getMe, LOGIN_SCHEMA };
