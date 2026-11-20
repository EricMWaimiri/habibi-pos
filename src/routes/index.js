const express = require('express');
const router = express.Router();

router.use('/accounting',require('./accounting.routes'));
router.use('/employee-finance',require('./employee-finance.routes'));
router.use('/settings',require('./settings.routes'));
router.use('/auth', require('./auth.routes'));
router.use('/users', require('./users.routes'));
router.use('/products', require('./products.routes'));
router.use('/sales', require('./sales.routes'));
router.use('/financial-operations',require('./financial-operations.routes'));
router.use('/reports', require('./reports.routes'));
router.use('/permissions', require('./permissions.routes'));
router.use('/stock', require('./stock.routes'));
router.use('/expenses', require('./expenses.routes'));
router.use('/shifts', require('./shifts.routes'));
router.use('/purchases', require('./purchases.routes'));
router.use('/invoices',require('./invoices.routes'));
router.use('/staff', require('./staff.routes'));

module.exports = router;
