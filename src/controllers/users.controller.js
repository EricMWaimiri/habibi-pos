const response = require('../utils/responses');
const prisma = require('../config/prisma');
const { hashPin } = require('../utils/pin');
const { z } = require('zod');
const { withAdminTransaction, countActiveManagers } = require('../utils/admin-transactions');
const policy = require('../utils/admin-policy');
const { readAdminContext, publishPermissionChange } = require('../utils/permissions');
const { assertCurrentSession, nextSessionVersion } = require('../utils/session-version');

const PATCH_USER_SCHEMA = z.object({ params: z.object({ id: z.string().min(1) }) });
const staffSelect = { id: true, name: true, role: true, isActive: true, commissionRate: true, createdAt: true };
const conflict = message => Object.assign(new Error(message), { status: 409 });
async function uniquePin(tx, pin, targetId) {
  const pinHash = hashPin(pin, process.env.PIN_PEPPER);
  const existing = await tx.user.findUnique({ where: { pinHash }, select: { id: true } });
  if (existing && existing.id !== targetId) throw conflict('PIN already in use');
  return pinHash;
}
async function write(work) {
  try { return await work(); }
  catch (error) {
    const target = error.meta?.target;
    if (error.code === 'P2002' && (target === 'pinHash' || (Array.isArray(target) && target.includes('pinHash')))) throw conflict('PIN already in use');
    throw error;
  }
}
async function createUser(req, res) {
  policy.validateCreateUserInput(req.body);
  const input = Object.freeze({ ...req.body });
  const user = await write(() => withAdminTransaction(prisma, { actorId: req.user.id }, async tx => {
    await assertCurrentSession(tx, req.auth);
    const context = await readAdminContext(tx, req.user.id);
    const decision = policy.authorizeCreateUser(context, input);
    const pinHash = decision.credentialAction==='payroll-only-no-login'?null:await uniquePin(tx, input.pin);
    const created=await tx.user.create({ data: { ...decision.changes, pinHash, isActive: true }, select: staffSelect });
    await require('../utils/staff-audit').record(tx,req.user.id,null,created,decision.credentialAction==='payroll-only-no-login'?'PAYROLL_ONLY_NO_LOGIN':'CREATE');
    return created;
  }));
  publishPermissionChange(req.app, user.role, user.id);
  res.status(201).json({ message: 'User created', user: response.staff(user) });
}
async function listUsers(req, res) {
  const result = await withAdminTransaction(prisma, { actorId: req.user.id }, async tx => {
    await assertCurrentSession(tx, req.auth);
    const context = await readAdminContext(tx, req.user.id);
    policy.authorizeUserList(context);
    const f = require('../utils/filters').filters(req.query,{statuses:['ACTIVE','INACTIVE']});
    const where = { ...(f.q?{name:require('../utils/filters').contains(f.q)}:{}), ...(f.status?{isActive:f.status==='ACTIVE'}:{}) };
    if (f.status && !['ACTIVE','INACTIVE'].includes(f.status)) throw Object.assign(new Error('Invalid staff status'),{status:400});
    const users = await tx.user.findMany({ where, select: staffSelect, orderBy: [{name:'asc'},{id:'asc'}], ...(Object.keys(req.query||{}).length?{skip:(f.page-1)*f.pageSize,take:f.pageSize}:{}) });
    // One list query plus the existing actor/grant reads, regardless of size.
    const total=Object.keys(req.query||{}).length?await tx.user.count({where}):users.length;
    return { users: users.map(response.staff), administration: policy.administrationMetadata(context, users), pagination:{page:f.page,pageSize:Object.keys(req.query||{}).length?f.pageSize:Math.max(1,users.length),total,pages:Object.keys(req.query||{}).length?Math.ceil(total/f.pageSize):Math.min(1,users.length)} };
  });
  res.json(result);
}
async function patchUser(req, res) {
  policy.validateUserChangeInput(req.body);
  const input = Object.freeze({ ...req.body });
  const { id } = req.validated.params;
  const user = await write(() => withAdminTransaction(prisma, { actorId: req.user.id, targetIds: [id] }, async tx => {
    await assertCurrentSession(tx, req.auth);
    const context = await readAdminContext(tx, req.user.id);
    const current = await tx.user.findUnique({ where: { id } });
    const decision = policy.authorizeUserChanges(context, current, input,
      { currentPinHash: current.pinHash, pinPepper: process.env.PIN_PEPPER });
    const removesActiveManager = current.role === 'MANAGER' && current.isActive &&
      (decision.changes.isActive === false || (decision.changes.role !== undefined && decision.changes.role !== 'MANAGER'));
    if (removesActiveManager && await countActiveManagers(tx) <= 1) throw conflict('Cannot remove the last active manager. Refresh and request review.');
    const changes = { ...decision.changes };
    if (decision.credentialAction) changes.pinHash = await uniquePin(tx, input.pin, id);
    const securityChanged = ['pinHash', 'role', 'isActive'].some(key =>
      Object.hasOwn(changes, key) && changes[key] !== current[key]);
    if (securityChanged) {
      nextSessionVersion(current.sessionVersion);
      changes.sessionVersion = { increment: 1 };
    }
    const updated=await tx.user.update({ where: { id }, data: changes, select: staffSelect });
    await require('../utils/staff-audit').record(tx,req.user.id,current,updated,decision.credentialAction||null);
    return updated;
  }));
  publishPermissionChange(req.app, user.role, user.id);
  res.json({ message: 'User updated', user: response.staff(user) });
}
async function staffAudit(req,res){
 const result=await withAdminTransaction(prisma,{actorId:req.user.id},async tx=>{
  await assertCurrentSession(tx,req.auth);const context=await readAdminContext(tx,req.user.id);
  policy.authorizeUserList(context);if(context.actor.role!=='MANAGER')throw Object.assign(new Error('Staff audit requires an authorized manager.'),{status:403});
  const F=require('../utils/filters'),f=F.filters(req.query);const page=await F.page(tx,'administrationEvent',{where:{scope:'USERS'},orderBy:[{createdAt:'desc'},{id:'desc'}],select:{id:true,actorId:true,targetUserId:true,createdAt:true,reason:true,before:true,after:true}},f);
  return{events:page.rows,pagination:page.pagination};
 });res.set('Cache-Control','no-store').json(result);
}
module.exports = { createUser, listUsers, patchUser, staffAudit, PATCH_USER_SCHEMA };
