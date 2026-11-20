const express = require('express');
const router = express.Router();

const { authenticate, requireActiveUser } = require('../middlewares/auth.middleware');
const { can } = require('../middlewares/permission.middleware');
const { validate } = require('../middlewares/validate');
const { getExpenses, createExpense, CREATE_EXPENSE_SCHEMA } = require('../controllers/expenses.controller');

router.use(authenticate, requireActiveUser, can('expenses.manage'));

router.get('/', getExpenses);
router.post('/', validate(CREATE_EXPENSE_SCHEMA), createExpense);

module.exports = router;