const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');

const { authenticate, requireActiveUser } = require('../middlewares/auth.middleware');
const { can } = require('../middlewares/permission.middleware');

// The waiter picker is needed by whoever can sell or view sales.
router.use(authenticate, requireActiveUser, can('sales.make', 'sales.view_all'));

// GET /api/staff/waiters  - active waiters (names only), for the counter's waitress picker
router.get('/waiters', async (req, res) => {
  const waiters = await prisma.user.findMany({
    where: { role: 'WAITER', isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  res.json({ waiters });
});

module.exports = router;