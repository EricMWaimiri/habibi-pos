const express = require('express');
const router = express.Router();

const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireActiveUser } = require('../middlewares/auth.middleware');
const { can } = require('../middlewares/permission.middleware');
const { listProducts } = require('../controllers/products.controller');

// The sellable catalogue is needed by anyone who can sell, view sales or manage products.
router.get(
  '/',
  authenticate,
  asyncHandler(requireActiveUser),
  can('sales.make', 'sales.view_all', 'products.manage'),
  listProducts
);

// Administration is separate from the cost/stock-free Front Office catalogue.
const admin=require('../utils/catalog-administration'),db=require('../config/prisma');
// Pending owner review of exact isolated grants: fail closed until explicitly enabled.
const adminEnabled=(req,res,next)=>process.env.CORE_ADMINISTRATION_ENABLED==='true'?next():res.status(503).json({message:'Catalogue administration is awaiting isolated database acceptance.'});
router.get('/admin',authenticate,adminEnabled,asyncHandler(requireActiveUser),asyncHandler(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await admin.list(db,req.auth,req.query));}));
router.post('/admin/recipe-preview',authenticate,adminEnabled,asyncHandler(requireActiveUser),asyncHandler(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await admin.previewRecipe(db,req.auth,req.body));}));
router.post('/admin/products',authenticate,adminEnabled,asyncHandler(requireActiveUser),asyncHandler(async(req,res)=>res.status(201).json(await admin.saveProduct(db,req.auth,null,req.body))));
router.patch('/admin/products/:id',authenticate,adminEnabled,asyncHandler(requireActiveUser),asyncHandler(async(req,res)=>res.json(await admin.saveProduct(db,req.auth,req.params.id,req.body))));
router.post('/admin/categories',authenticate,adminEnabled,asyncHandler(requireActiveUser),asyncHandler(async(req,res)=>res.status(201).json(await admin.saveCategory(db,req.auth,null,req.body))));
router.patch('/admin/categories/:id',authenticate,adminEnabled,asyncHandler(requireActiveUser),asyncHandler(async(req,res)=>res.json(await admin.saveCategory(db,req.auth,req.params.id,req.body))));
module.exports = router;