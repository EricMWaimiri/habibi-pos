const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireActiveUser } = require('../middlewares/auth.middleware');
const { withAdminTransaction } = require('../utils/admin-transactions');
const policy = require('../utils/admin-policy');
const { ROLE_VALUES } = require('../utils/permission-definitions');
const { assertCurrentSession } = require('../utils/session-version');
const { prisma, PERMISSIONS, getPermissionsForUser, readAdminContext, publishPermissionChange } = require('../utils/permissions');

router.use(authenticate, asyncHandler(requireActiveUser));
const customRoles=require('../utils/custom-role-administration');
router.get('/custom',asyncHandler(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await customRoles.list(prisma,req.auth));}));
router.post('/custom',asyncHandler(async(req,res)=>{const row=await customRoles.save(prisma,req.auth,req.body);publishPermissionChange(req.app,row.baseRole);res.json(row);}));
router.post('/custom/assignment',asyncHandler(async(req,res)=>{const row=await customRoles.assign(prisma,req.auth,req.body);publishPermissionChange(req.app,null,row.userId);res.json(row);}));
router.get('/mine', asyncHandler(async (req, res) => {
  const permissions = await getPermissionsForUser(req.user);
  const latest = await prisma.rolePermission.aggregate({ where: { role: req.user.role }, _max: { updatedAt: true } });
  res.json({ role: req.user.role, permissions, features:{coreCatalogue:process.env.CORE_ADMINISTRATION_ENABLED==='true',payrollCorrections:require('../utils/payroll-storage').enabled()}, version: latest._max.updatedAt ? latest._max.updatedAt.getTime() : 0 });
}));

router.get('/', asyncHandler(async (req, res) => {
  const matrix = await withAdminTransaction(prisma, { actorId: req.user.id }, async tx => {
    await assertCurrentSession(tx, req.auth);
    const context = await readAdminContext(tx, req.user.id);
    policy.authorizePermissionMatrixRead(context);
    const rows = await tx.rolePermission.findMany({ orderBy: [{ role: 'asc' }, { permission: 'asc' }] });
    const stored = new Map(rows.map(row => [row.role + ':' + row.permission, row.enabled]));
    return { roles: ROLE_VALUES, permissions: PERMISSIONS.map(permission => ({
      ...permission,
      roles: Object.fromEntries(ROLE_VALUES.map(role => [role, context.permissions[role].includes(permission.key)])),
      // Expose legacy storage separately; never rewrite it to match policy.
      storedRoles: Object.fromEntries(ROLE_VALUES.map(role => [role, stored.get(role + ':' + permission.key) ?? false])),
    })) };
  });
  res.json(matrix);
}));

router.get('/audit', asyncHandler(async(req,res)=>{
  const F=require('../utils/filters'),f=F.filters({pageSize:'25',...req.query});
  const result=await withAdminTransaction(prisma,{actorId:req.user.id},async tx=>{await assertCurrentSession(tx,req.auth);policy.authorizePermissionMatrixRead(await readAdminContext(tx,req.user.id));const page=await F.page(tx,'administrationEvent',{where:{scope:'PERMISSIONS'},orderBy:[{createdAt:'desc'},{id:'desc'}],include:{actor:{select:{id:true,name:true}}}},f);return{events:page.rows,pagination:page.pagination};});res.set('Cache-Control','no-store').json(result);
}));
router.put('/', asyncHandler(async (req, res) => {
  policy.validatePermissionChangeInput(req.body);
  const input = { role: req.body.role, permissions: req.body.permissions.map(item => ({ ...item })) };
  const decision = await withAdminTransaction(prisma, { actorId: req.user.id }, async tx => {
    await assertCurrentSession(tx, req.auth);
    const approved = policy.authorizePermissionChanges(await readAdminContext(tx, req.user.id), input);
    const previous = await tx.rolePermission.findMany({where:{role:approved.role,permission:{in:approved.permissions.map(x=>x.permission)}},select:{permission:true,enabled:true},orderBy:{permission:'asc'}});
    // Single role per request; policy returns keys in deterministic order.
    for (const item of approved.permissions) await tx.rolePermission.update({
      where: { role_permission: { role: approved.role, permission: item.permission } }, data: { enabled: item.enabled },
    });
    await require('../utils/settings').audit(tx,{actorId:req.user.id,scope:'PERMISSIONS',reason:'Role permission update',before:{role:approved.role,permissions:previous},after:approved});
    return approved;
  });
  publishPermissionChange(req.app, decision.role);
  res.json({ message: 'Permissions updated', role: decision.role, updatedCount: decision.permissions.length });
}));
module.exports = router;
