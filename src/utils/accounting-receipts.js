'use strict';
// Installed as src/utils/accounting-receipts.js in the permanent feature worktree.
// Caller MUST keep begin, financial action, audit and commit in ONE transaction.
const {createHash,randomUUID}=require('node:crypto');
const {assertCurrentSession}=require('./session-version');
const {effectivePermissions}=require('./admin-policy');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const grants=Object.freeze({GOODS_RECEIVE:'purchases.manage',GOODS_REVERSE:'purchases.void',BUSINESS_DAY_SCHEDULE:'settings.manage',...{"SUPPLIER_CREATE":"suppliers.manage","SUPPLIER_UPDATE":"suppliers.manage","CATEGORY_CREATE":"expense_categories.manage","CATEGORY_UPDATE":"expense_categories.manage","DRAFT_CREATE":"accounting.documents","DRAFT_UPDATE":"accounting.documents","DRAFT_CANCEL":"accounting.documents","PURCHASE_POST":"purchases.manage","EXPENSE_POST":"expenses.manage","PAYMENT_CREATE":"supplier_payments.manage","PAYMENT_ALLOCATE":"supplier_payments.manage","CREDIT_CREATE":"supplier_credits.manage","CREDIT_ALLOCATE":"supplier_credits.manage","PAYMENT_REVERSE":"supplier_payments.void","CREDIT_REVERSE":"supplier_credits.manage","ALLOCATION_REVERSE":"accounting.correct","OPENING_CREATE":"accounting.opening","PURCHASE_CORRECT":"purchases.void","EXPENSE_REVERSE":"expenses.void","EXPENSE_CORRECT":"accounting.correct","EXPENSE_SETTLE":"expenses.manage","DECIDE":"accounting.approve"},EXPENSE_CREATE:'expenses.manage',CATEGORY_PROFILE:'expense_categories.manage',SUPPLIER_PROFILE:'suppliers.manage',SUPPLIER_PAYMENT:'supplier_payments.manage',SUPPLIER_CREDIT:'supplier_credits.manage',EXPENSE_REVERSE:'expenses.void',PURCHASE_CORRECT:'purchases.void'});
const fail=(status,message)=>Object.assign(new Error(message),{status});
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
 if(typeof value==='number'&&!Number.isFinite(value))throw fail(400,'Invalid accounting payload.');
 return value;
}
function context(auth,requestId,operation,payload){
 if(!auth||typeof auth.id!=='string'||!auth.id||typeof requestId!=='string'||!UUID.test(requestId)||!Object.hasOwn(grants,operation))throw fail(400,'A stable UUID and supported accounting operation are required.');
 return{id:requestId.toLowerCase(),actorId:auth.id,operation,fingerprint:createHash('sha256').update(JSON.stringify(canonical({operation,payload}))).digest('hex')};
}
async function begin(tx,auth,requestId,operation,payload){
 const c=context(auth,requestId,operation,payload);
 // Separate from the sale-bound receipt namespace; full UUID remains authoritative.
 await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
 await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(180023,hashtext(${c.id}))`;
 // Existing hierarchy: request guard -> actor -> explicit shift -> sorted parents.
 // Never acquire an administration guard after entering this financial hierarchy.
 await tx.$queryRaw`SELECT id FROM users WHERE id=${auth.id} FOR NO KEY UPDATE`;
 const actor=await assertCurrentSession(tx,auth);
 const enabled=await tx.rolePermission.findMany({where:{role:actor.role,enabled:true},select:{permission:true}});
 const permissions=await require('./custom-role-policy').resolveUserPermissions(tx,actor);
 if(!permissions.includes(grants[operation]))throw fail(403,'Permission denied for this accounting operation.');
 const prior=await tx.accounting_write_receipts.findUnique({where:{id:c.id}});
 if(prior&&(prior.actor_id!==c.actorId||prior.operation!==operation||prior.fingerprint!==c.fingerprint))throw fail(409,'This request identifier was already used for a different accounting operation.');
 return{context:c,actor,permissions,replay:!!prior,resultIds:prior?.result_ids||null};
}
function validateResult(ids){
 const allowed=['policyId','receiptId','expenseId','supplierId','categoryId','paymentId','creditId','requestId','adjustmentId','purchaseId','documentId','allocationId','openingId','settlementId'];
 if(!ids||typeof ids!=='object'||Array.isArray(ids)||!Object.keys(ids).length||Object.entries(ids).some(([k,v])=>!allowed.includes(k)||typeof v!=='string'||!v.trim()||v.length>100))throw fail(500,'Accounting result could not be recorded safely.');
 return Object.fromEntries(Object.entries(ids));
}
async function commit(tx,receipt,resultIds){
 if(!receipt?.context||receipt.replay)throw fail(500,'Accounting receipt cannot be committed twice.');
 const c=receipt.context,ids=validateResult(resultIds);
 await tx.accounting_write_receipts.create({data:{id:c.id,actor_id:c.actorId,operation:c.operation,fingerprint:c.fingerprint,result_ids:ids}});
 await tx.accounting_audit_events.create({data:{id:randomUUID(),actor_id:c.actorId,action:c.operation,target_type:'ACCOUNTING_OPERATION',target_id:Object.values(ids)[0],reason:'Accounting operation recorded',metadata:{requestId:c.id,resultIds:ids}}});
 return{resultIds:ids,replay:false};
}
module.exports={UUID,grants,context,begin,commit,validateResult,canonical};
