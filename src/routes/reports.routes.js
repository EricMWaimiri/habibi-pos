const express = require('express');
const router = express.Router();

const {
  authenticate,
  requireActiveUser,
} = require('../middlewares/auth.middleware');
const { can } = require('../middlewares/permission.middleware');
const { validate } = require('../middlewares/validate');
const {
  dailyReport,
  pnlReport,
  commissionsReport,
  DAILY_REPORT_SCHEMA,
  PNL_REPORT_SCHEMA,
  COMMISSIONS_SCHEMA,
} = require('../controllers/reports.controller');

// Every report has its own permission - the Manager decides who sees what.
router.use(authenticate, requireActiveUser);

router.get('/dashboard', can('dashboard.view'), require('../controllers/dashboard.controller').dashboard);
router.get('/inventory', can('reports.inventory'), require('../controllers/dashboard.controller').inventory);

router.get('/mpesa-matches', can('pay.mpesa','payments.view_collected'), async(req,res)=>{res.set('Cache-Control','no-store');res.json(await require('../utils/mpesa-matching').matches(require('../config/prisma'),req.user,req.permissions,req.query.suffix));});
router.get('/payments', can('payments.view_collected'), require('../controllers/browse.controller').paymentList);
router.get('/daily/csv', can('reports.sales'), validate(DAILY_REPORT_SCHEMA), require('../controllers/reports.controller').dailyReportCsv);
router.get('/daily', can('reports.sales'), validate(DAILY_REPORT_SCHEMA), dailyReport);
router.get('/pnl', can('reports.financial'), validate(PNL_REPORT_SCHEMA), pnlReport);
router.get('/commissions', can('commissions.manage'), validate(COMMISSIONS_SCHEMA), commissionsReport);

module.exports = router;
