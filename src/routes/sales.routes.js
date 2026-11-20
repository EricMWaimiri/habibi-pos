
const express = require('express');
const router = express.Router();

const {
  authenticate,
  requireActiveUser,
} = require('../middlewares/auth.middleware');
const { can } = require('../middlewares/permission.middleware');
const { validate } = require('../middlewares/validate');

const {
  createSale,
  getSales,
  getSale,
  addItems,
  removeItem,
  addPayment,
  cancelSale,
  mergeSales,
  CREATE_SALE_SCHEMA,
  LIST_SALES_SCHEMA,
  GET_SALE_SCHEMA,
  ADD_ITEMS_SCHEMA,
  REMOVE_ITEM_SCHEMA,
  ADD_PAYMENT_SCHEMA,
  CANCEL_SALE_SCHEMA,
  MERGE_SALES_SCHEMA,
} = require('../controllers/sales.controller');

// Every route requires a valid token and an active user.
// Access is decided by the dynamic permissions, never by the role name.
router.use(authenticate, requireActiveUser);

// Actor-scoped read-only reconciliation; no submitted credential or payload exposure.
router.get('/operations/:requestId', can('sales.make','pay.cash','pay.mpesa'), require('../controllers/sales.controller').mutationStatus);

// Create a sale.
router.post(
  '/',
  can('sales.make'),
  validate(CREATE_SALE_SCHEMA),
  createSale
);

router.post('/:id/split',can('sales.split'),validate(require('../controllers/split.controller').schema),require('../controllers/split.controller').split);

// Merge bills.
router.post(
  '/merge',
  can('sales.merge'),
  validate(MERGE_SALES_SCHEMA),
  mergeSales
);

// List sales. The controller must also restrict results for users
// without sales.view_all so they cannot see other staff's sales.
router.get(
  '/',
  can('sales.split','sales.make', 'sales.view_all', 'pay.cash', 'pay.mpesa', 'sales.merge', 'sales.void', 'sales.remove_item', 'sales.return', 'pay.void', 'sales.discount', 'sales.change_price'),
  validate(LIST_SALES_SCHEMA),
  getSales
);

// View a single sale. Ownership restrictions must be enforced
// in the controller before returning the sale.
router.get(
  '/:id',
  can('sales.split','sales.make', 'sales.view_all', 'pay.cash', 'pay.mpesa', 'sales.merge', 'sales.void', 'sales.remove_item', 'sales.return', 'pay.void', 'sales.discount', 'sales.change_price'),
  validate(GET_SALE_SCHEMA),
  getSale
);

// Add items to a sale.
router.post(
  '/:id/items',
  can('sales.make'),
  validate(ADD_ITEMS_SCHEMA),
  addItems
);

// Receive a payment. The route requires 'pay.cash' or 'pay.mpesa';
// the controller then checks that the user holds the permission for
// this specific payment method.
router.post(
  '/:id/payments',
  can('pay.cash', 'pay.mpesa'),
  validate(ADD_PAYMENT_SCHEMA),
  addPayment
);

// Remove items.
router.delete(
  '/:id/items/:itemId',
  can('sales.remove_item'),
  validate(REMOVE_ITEM_SCHEMA),
  removeItem
);

// Cancel/void a sale.
router.patch(
  '/:id/cancel',
  can('sales.void'),
  validate(CANCEL_SALE_SCHEMA),
  cancelSale
);

module.exports = router;
