const express = require('express');
const router = express.Router();

const { authenticate, requireActiveUser } = require('../middlewares/auth.middleware');
const { can } = require('../middlewares/permission.middleware');
const { validate } = require('../middlewares/validate');
const { createPurchase, CREATE_PURCHASE_SCHEMA } = require('../controllers/purchases.controller');

router.use(authenticate, requireActiveUser); // Only staff with purchases.manage can record purchases

router.get('/', can('purchases.manage','purchases.view'), require('../controllers/invoices.controller').purchaseList);
router.get('/:id', can('purchases.manage','purchases.view'), require('../controllers/invoices.controller').document);
for(const action of ['print','reprint'])router.get('/:id/'+action,can('purchases.manage','purchases.view'),can(action==='print'?'receipt.print':'receipt.reprint'),(req,res,next)=>{req.invoicePrint=action;next();},require('../controllers/invoices.controller').document);
router.post('/', can('purchases.manage'), validate(CREATE_PURCHASE_SCHEMA), createPurchase);

module.exports = router;
