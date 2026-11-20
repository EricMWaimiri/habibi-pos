const response = require('../utils/responses');
const express = require('express');
const router = express.Router();

const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireActiveUser } = require('../middlewares/auth.middleware');
const { can } = require('../middlewares/permission.middleware');
const { getOpenShift, openShift, closeShift } = require('../controllers/shifts.controller');
const prisma = require('../config/prisma');

// Every shift route needs a valid token and an active user.
router.use(authenticate, asyncHandler(requireActiveUser));

// The current user's own shift - available to every authenticated user.
router.get('/options', can('sales.split','sales.return','pay.void','sales.make','sales.view_all','pay.cash','pay.mpesa','sales.merge','sales.void','sales.remove_item','payments.view_collected','expenses.manage','purchases.manage','stock.view','stock.count','reports.sales','reports.financial','commissions.manage','shifts.manage'), require('../controllers/browse.controller').options);
router.get('/mine/open', asyncHandler(getOpenShift));
router.post('/open', can('shifts.manage', 'pay.cash', 'pay.mpesa'), asyncHandler(openShift));
router.post('/:id/close', can('shifts.manage', 'pay.cash', 'pay.mpesa'), asyncHandler(closeShift));

// GET /api/shifts - list all shifts (shifts.manage only)
router.get('/', can('shifts.manage'), asyncHandler(async (req, res) => {
  const F=require('../utils/filters'),f=F.filters(req.query,{statuses:['OPEN','CLOSED']});
  const where=F.and(f.range?{openedAt:f.range}:{},f.shiftId?{id:f.shiftId}:{},f.staffId?{openedById:f.staffId}:{},f.status?{status:f.status}:{},f.q?{OR:[{name:F.contains(f.q)},{id:F.contains(f.q)},{openedBy:{name:F.contains(f.q)}}]}:{});
  const {shifts,total}=await prisma.$transaction(async tx=>{
  const shifts = await tx.shift.findMany({
    where,
    include: { openedBy: { select: { name: true } }, closedBy: { select: { name: true } } },
    orderBy: [{openedAt:'desc'},{id:'desc'}],
    take: f.pageSize, skip:(f.page-1)*f.pageSize,
  });
  const total=await tx.shift.count({where});return{shifts,total};
  },{isolationLevel:'RepeatableRead',timeout:15000});
  res.json({ shifts: shifts.map(response.shift), pagination:{page:f.page,pageSize:f.pageSize,total,pages:Math.ceil(total/f.pageSize)} });
}));

module.exports = router;
