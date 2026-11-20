'use strict';
const router=require('express').Router(),{authenticate,requireActiveUser}=require('../middlewares/auth.middleware'),{can}=require('../middlewares/permission.middleware'),C=require('../controllers/invoices.controller');
router.use(authenticate,requireActiveUser);
router.get('/sales',can('reports.sales'),C.saleList);
router.get('/purchases',can('purchases.manage','purchases.view'),C.purchaseList);
router.use('/:kind', (req,res,next)=>{if(!['sales','purchases'].includes(req.params.kind))return res.status(404).json({message:'Invoice type not found'});return (req.params.kind==='sales'?can('reports.sales'):can('purchases.manage','purchases.view'))(req,res,next);});
router.get('/:kind/:id',C.document);
for(const action of ['print','reprint'])router.get('/:kind/:id/'+action,can(action==='print'?'receipt.print':'receipt.reprint'),(req,res,next)=>{req.invoicePrint=action;next();},C.document);
module.exports=router;
