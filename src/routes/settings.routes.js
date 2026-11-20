const router=require('express').Router(),{authenticate,requireActiveUser}=require('../middlewares/auth.middleware'),{can}=require('../middlewares/permission.middleware'),asyncHandler=require('../utils/asyncHandler'),C=require('../controllers/settings.controller');
router.use(authenticate,asyncHandler(requireActiveUser),can('settings.manage','printers.manage','accounting.settings'));
router.get('/',asyncHandler(C.get));router.put('/',asyncHandler(C.update));router.get('/audit',asyncHandler(C.audit));
module.exports=router;
