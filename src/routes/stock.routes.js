const express = require('express');
const router = express.Router();

const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireActiveUser } = require('../middlewares/auth.middleware');
const { can } = require('../middlewares/permission.middleware');
const { validate } = require('../middlewares/validate');
const {
  getStock, receiveStock, adjustStock, RECEIVE_SCHEMA, ADJUST_SCHEMA,
} = require('../controllers/stock.controller');
const counts = require('../controllers/stock-counts.controller');

router.use(authenticate, asyncHandler(requireActiveUser));

// Action prerequisites disclose identities/units only, never stock or valuation.
router.get('/movements', can('stock.view', 'stock.count'), require('../controllers/browse.controller').movementList);
router.get('/options', can('stock.receive', 'stock.adjust', 'purchases.manage'), asyncHandler(async (req, res) => {
  const prisma = require('../config/prisma');
  const F=require('../utils/filters'),f=F.filters(req.query);
  const where={isActive:true,type:'simple',...(f.q?{OR:[{name:F.contains(f.q)},{productCode:F.contains(f.q)}]}:{})};
  const paged=Object.keys(req.query||{}).length>0;
  const products = await prisma.product.findMany({ where, ...(paged?{take:f.pageSize,skip:(f.page-1)*f.pageSize}:{}),
    select: { id: true, name: true, type: true, unitOfMeasure: true }, orderBy: [{name:'asc'},{id:'asc'}] });
  const total=paged?await prisma.product.count({where}):products.length;
  res.json({products,...(paged?{pagination:{page:f.page,pageSize:f.pageSize,total,pages:Math.ceil(total/f.pageSize)}}:{})});
}));

// Allow viewing stock if they have stock.view OR stock.count (so cashiers can do counts)
router.get('/', can('stock.view', 'stock.count'), asyncHandler(getStock));

// Receive stock that was delivered
router.post('/receive', can('stock.receive'), validate(RECEIVE_SCHEMA), asyncHandler(receiveStock));

// Correct stock by hand (broken, spilled, found...). A reason is required.
router.post('/adjust', can('stock.adjust'), validate(ADJUST_SCHEMA), asyncHandler(adjustStock));

// Anyone with stock.count can submit a draft count
router.post('/count', can('stock.count', 'stock.count_approve'), validate(counts.COUNT_SCHEMA), asyncHandler(counts.submitStockCount));
router.post('/counts/start', can('stock.count'), validate(counts.START_COUNT_SCHEMA), asyncHandler(counts.startStockCount));
router.get('/counts/history', can('stock.count','stock.count_approve'), asyncHandler(counts.countHistory));
router.get('/counts/:id', can('stock.count', 'stock.count_approve'), asyncHandler(counts.getStockCount));
router.post('/counts/:id/ready', can('stock.count', 'stock.count_approve'), validate(counts.READY_SCHEMA), asyncHandler(counts.readyStockCount));
router.post('/counts/:id/extend', can('stock.count', 'stock.count_approve'), asyncHandler(counts.extendStockCount));
router.post('/counts/:id/discard', can('stock.count', 'stock.count_approve'), asyncHandler(counts.discardStockCount));

// Only people with stock.count_approve can see pending drafts and approve them
router.get('/counts', can('stock.count', 'stock.count_approve'), asyncHandler(counts.getPendingCounts));
router.post('/counts/:id/approve', can('stock.count_approve'), validate(counts.APPROVE_SCHEMA), asyncHandler(counts.approveStockCount));

module.exports = router;
