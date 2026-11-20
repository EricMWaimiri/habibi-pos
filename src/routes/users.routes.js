const express = require('express');
const router = express.Router();

const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireActiveUser } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate');
const {
  createUser, listUsers, patchUser,
  PATCH_USER_SCHEMA,
} = require('../controllers/users.controller');

// Every route below: valid token -> active user -> fresh guarded policy in each controller
router.use(authenticate, asyncHandler(requireActiveUser));

router.post('/', asyncHandler(createUser));
router.get('/audit', asyncHandler(require('../controllers/users.controller').staffAudit));
router.get('/', asyncHandler(listUsers));
router.get('/:id/employment',asyncHandler(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await require('../utils/employee-employment').list(require('../config/prisma'),req.auth,req.params.id));}));
router.post('/:id/employment',asyncHandler(async(req,res)=>{if(req.body?.employeeId!==req.params.id)throw Object.assign(Error('Employee target mismatch'),{status:400});res.status(201).json(await require('../utils/employee-employment').save(require('../config/prisma'),req.auth,req.body));}));
router.patch('/:id', validate(PATCH_USER_SCHEMA), asyncHandler(patchUser));

module.exports = router;
