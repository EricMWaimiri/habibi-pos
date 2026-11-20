'use strict';
const prisma=require('../config/prisma'),{Prisma}=require('@prisma/client'),{z}=require('zod');
const {D,money,returnAmounts,error}=require('../utils/return-calculations');
const {quantity,quantitySchema,applyStockDelta}=require('../utils/quantity');
const {withShiftTransaction,lockOpenShift}=require('../utils/shift-transactions');
const {databaseInstant,nairobiDate,verifyDebt,verifyStockHistory,validateMutableSales,audit}=require('../utils/accounting');
const {restoreStockForItems,lockProducts}=require('../utils/stock');
const {assertStockAvailable}=require('../utils/stock-counts');
const {ledger,commissionTarget}=require('../utils/financial-ledger');
const {assertCurrentSession}=require('../utils/session-version');
const {effectivePermissions}=require('../utils/admin-policy');
const F=require('../utils/filters');
const fail=(status,message)=>Object.assign(new Error(message),{status});
const Pricing=require('../utils/pricing-calculations');
const {createHash}=require('node:crypto');
const grant={SALE_DISCOUNT:'sales.discount',SALE_PRICE_CHANGE:'sales.change_price',PAYMENT_VOID:'pay.void',RETURN:'sales.return',CANCEL:'sales.void',REMOVE_ITEM:'sales.remove_item'};
const reason=z.string().trim().min(3).max(200);
const refund=z.object({method:z.enum(['CASH','MPESA']),amount:z.union([z.number(),z.string()]),externalReference:z.string().trim().max(60).optional(),externallyHandled:z.boolean().optional()}).strict();
const requestSchema=z.object({kind:z.enum(Object.keys(grant)),saleId:z.string().min(1),paymentId:z.string().min(1).optional(),saleItemId:z.string().min(1).optional(),quantity:quantitySchema({positive:true}).optional(),value:z.union([z.number(),z.string()]).optional(),discountType:z.enum(['FIXED','PERCENT']).optional(),acknowledgeZeroPrice:z.boolean().optional(),acknowledgePriorPricing:z.boolean().optional(),refunds:z.array(refund).max(2).optional(),reason,shiftId:z.string().min(1).optional(),clientRequestId:z.string().uuid(),expectedUpdatedAt:z.string().datetime().optional()}).strict();
const decisionSchema=z.object({decision:z.enum(['APPROVE','REJECT']),reason,shiftId:z.string().min(1).optional()}).strict();
function parse(schema,body){const result=schema.safeParse(body);if(!result.success)throw fail(400,'Invalid reversal request: check reason, quantity, refund allocation and fields.');return result.data;}
function mode(){const value=process.env.FINANCIAL_APPROVAL_MODE||'MANAGER';if(!['MANAGER','DUAL_MANAGER','PERMISSION'].includes(value))throw fail(503,'Financial approval configuration requires review.');return value;}
async function lockUsers(tx,ids){await tx.$executeRaw`SET LOCAL lock_timeout='5s'`;await tx.$queryRaw`SELECT id FROM users WHERE id IN (${Prisma.join([...new Set(ids)].sort())}) ORDER BY id FOR NO KEY UPDATE`;}
async function access(tx,auth){const actor=await assertCurrentSession(tx,auth);const rows=await tx.rolePermission.findMany({where:{role:actor.role,enabled:true},select:{permission:true}});return{actor,permissions:await require('../utils/custom-role-policy').resolveUserPermissions(tx,actor)};}
function authorize(ctx,sale,kind){if(!ctx.permissions.includes(grant[kind]))throw fail(403,'Permission denied for this financial action.');if(!ctx.permissions.includes('sales.view_all')&&sale.waiterId!==ctx.actor.id&&sale.createdById!==ctx.actor.id)throw fail(403,'Not your order');}
const stateHash=(sale,l)=>JSON.stringify([sale.updatedAt.toISOString(),String(sale.total),String(l.paid),String(l.total),l.adjustments.length,l.payments.length]);
function projection(a,permissions){return{id:a.id,requestId:a.requestId,kind:a.kind,saleId:a.saleId,saleItemId:a.saleItemId,quantity:a.quantity,salesDelta:a.salesDelta,reason:a.reason,createdAt:a.createdAt,shiftId:a.shiftId,actorId:a.actorId,
 ...(permissions.includes('payments.view_collected')?{paymentId:a.paymentId,collectionDelta:a.collectionDelta,cashEntries:(a.cashEntries||[]).map(e=>({method:e.method,amount:e.amount,externalReference:e.externalReference,confirmation:e.manualExternal?'MANUALLY_RECORDED_NOT_PROVIDER_CONFIRMED':'INTERNAL_LEDGER_ONLY'}))}:{}),
 ...(permissions.includes('reports.financial')?{costDelta:a.costDelta}:{}),...(permissions.includes('commissions.manage')?{commissionDelta:a.commissionDelta}:{})};}
async function prepare(tx,sale,input){
 if(sale.status==='CANCELLED')throw error('This order is already cancelled; only an unpaid order can be changed.');
 if(sale.status==='MERGED')throw error('This order was merged into another bill; only an unpaid order can be changed.');
 if(input.expectedUpdatedAt&&sale.updatedAt.toISOString()!==input.expectedUpdatedAt)throw error('Bill changed. Review it before submitting again.');
 const l=await ledger(tx,sale);await verifyDebt(tx,sale);
 if(Pricing.isPricing(input.kind))return require('../utils/pricing-operations').prepare(tx,sale,input,l);
 if(input.value!==undefined||input.discountType!==undefined||input.acknowledgeZeroPrice!==undefined||input.acknowledgePriorPricing!==undefined)throw fail(400,'Pricing fields are not valid for this operation.');
 if(['PAYMENT_VOID','RETURN'].includes(input.kind)&&(!sale.accountingDate||sale.commissionRateSnapshot===null))throw error('Historical accounting snapshots cannot be verified. Manual review required.');
 if(input.kind==='PAYMENT_VOID'){
  if(input.saleItemId||input.quantity!==undefined||input.refunds)throw fail(400,'Payment void does not accept item or refund fields.');
  const payment=l.payments.find(p=>p.id===input.paymentId);if(!payment)throw fail(404,'Payment not found on this bill.');
  if(l.adjustments.some(a=>a.paymentId===payment.id))throw error('Payment was already voided.');
  if(l.methods[payment.method].lt(payment.amount))throw error('This payment has already funded refunds. Manual review required.');
  return{l,payment};
 }
 if(input.paymentId)throw fail(400,'Unexpected payment field.');
 if(input.kind==='RETURN'){
  if(sale.status!=='PAID'||!l.balance.isZero())throw error('Only fully settled bills can use the paid-return workflow.');
  const items=await tx.saleItem.findMany({where:{saleId:sale.id,removedAt:null}}),item=items.find(i=>i.id===input.saleItemId);
  if(!item)throw fail(404,'Active sale item not found.');
  if(item.returnEligible!==true)throw error(item.returnEligible===false?'This original item is non-returnable.':'Historical return eligibility is unverified; manual review required.');
  await verifyStockHistory(tx,[item],sale.id);
  const previous=l.adjustments.filter(a=>a.kind==='RETURN'&&a.saleItemId===item.id),amounts=returnAmounts(sale,items,item,input.quantity,previous);
  if(l.adjustments.some(a=>Pricing.isPricing(a.kind)))amounts.amount=Pricing.returnValue(Pricing.state(sale,items,await Pricing.hydrate(tx,l.adjustments)),item.id,input.quantity);
  const refunds=(input.refunds||[]).map(r=>({...r,amount:money(r.amount)}));
  if(new Set(refunds.map(r=>r.method)).size!==refunds.length||refunds.some(r=>r.amount.lte(0))||!refunds.reduce((n,r)=>n.add(r.amount),D(0)).eq(amounts.amount))throw fail(400,'Refund methods must add up exactly to the original discounted return value.');
  for(const r of refunds){if(r.amount.gt(l.methods[r.method]))throw error('Refund exceeds the remaining amount collected by that method.');if(r.method==='MPESA'&&r.externallyHandled!==true)throw fail(400,'M-Pesa refunds must be handled externally and explicitly recorded; this POS does not send refunds.');}
  return{l,item,amounts,refunds};
 }
 if(input.quantity!==undefined||input.refunds)throw fail(400,'Unexpected quantity or refund fields.');
 if(input.kind==='REMOVE_ITEM'&&!input.saleItemId)throw fail(400,'Choose an item.');
 if(input.kind==='CANCEL'&&input.saleItemId)throw fail(400,'Unexpected item field.');
 return{l};
}
async function execute(tx,ctx,sale,input,requestId,clientKey){
 const plan=await prepare(tx,sale,input);const {l}=plan;
 let salesDelta=D(0),collectionDelta=D(0),costDelta=D(0),commissionDelta=D(0),cash=[],parts=[];
 if(Pricing.isPricing(input.kind)){
  salesDelta=plan.pricing.delta;collectionDelta=plan.refundTotal.negated();
  commissionDelta=sale.commissionEarnedAt?await commissionTarget(tx,sale,plan.pricing.net,plan.pricing.net.sub(l.paid.add(collectionDelta)).isZero()):D(0);
  cash=plan.refunds.map(r=>({method:r.method,amount:r.amount.negated(),externalReference:r.externalReference||null,manualExternal:r.method==='MPESA'}));
 }else if(input.kind==='PAYMENT_VOID'){
  if(plan.payment.method==='CASH'&&plan.payment.receivedShiftId!==input.shiftId)throw error('Cash payment void requires its original receiving shift to remain open. Use an approved paid return for an actual later refund.');
  collectionDelta=plan.payment.amount.negated();cash=[{method:plan.payment.method,amount:collectionDelta}];
  commissionDelta=sale.commissionEarnedAt?await commissionTarget(tx,sale,l.total,false):D(0);
 }else if(input.kind==='RETURN'){
  salesDelta=plan.amounts.amount.negated();collectionDelta=salesDelta;costDelta=plan.amounts.cost.negated();
  commissionDelta=sale.commissionEarnedAt?await commissionTarget(tx,sale,l.total.add(salesDelta),true):D(0);
  cash=plan.refunds.map(r=>({method:r.method,amount:r.amount.negated(),externalReference:r.externalReference||null,manualExternal:r.method==='MPESA'}));
  const originals=await tx.stockMovement.findMany({where:{saleItemId:plan.item.id,type:'SALE',quantityChange:{lt:0},reversalOfId:null},include:{returnPortions:true},orderBy:{id:'asc'}});
  for(const original of originals){const target=quantity(original.quantityChange.negated().mul(plan.amounts.cumulative).div(plan.amounts.original),{min:0,status:409,label:'Original recipe return'});const prior=original.returnPortions.reduce((n,p)=>n.add(p.quantity),D(0)),delta=quantity(target.sub(prior),{positive:true,status:409,label:'Returned stock'});parts.push({original,delta});}
  await lockProducts(tx,parts.map(p=>p.original.productId));await assertStockAvailable(tx,parts.map(p=>p.original.productId));
 }else{
  const [mutable]=await validateMutableSales(tx,[sale],sale.shiftId);
  // Origin owner/shift and sale are already held. Validation takes no upstream locks.
  const items=await tx.saleItem.findMany({where:{saleId:sale.id,removedAt:null}});
  const selected=input.kind==='CANCEL'?items:items.filter(i=>i.id===input.saleItemId);
  if(!selected.length)throw fail(404,'Item was already removed.');if(input.kind==='REMOVE_ITEM'&&items.length<=1)throw error('Keep one line or cancel the bill.');
  await restoreStockForItems(tx,selected,{saleId:sale.id,userId:ctx.actor.id,reason:input.reason});
  if(input.kind==='CANCEL'){await tx.sale.update({where:{id:sale.id},data:{status:'CANCELLED',notes:[sale.notes,'CANCELLED: '+input.reason].filter(Boolean).join(' | ')}});await tx.docket.updateMany({where:{saleId:sale.id},data:{status:'CANCELLED'}});}
  else{await tx.saleItem.update({where:{id:input.saleItemId},data:{removedAt:await databaseInstant(tx)}});const subtotal=items.filter(i=>i.id!==input.saleItemId).reduce((n,i)=>n.add(i.subtotal),D(0)),total=subtotal.sub(mutable.discount);if(total.lt(0))throw error('Remaining bill cannot cover its original discount.');await tx.sale.update({where:{id:sale.id},data:{subtotal,total,balance:total,...(mutable.commissionCapSnapshot!=null?{commissionCapSnapshot:require('../utils/commission-snapshot').resized(mutable,total)}:{})}});}
 }
 if(!commissionDelta.isZero()&&!ctx.permissions.includes('commissions.void'))throw fail(403,'Earned commission correction additionally requires commissions.void.');
 const instant=await databaseInstant(tx);
 const adjustment=await tx.financialAdjustment.create({data:{requestId,clientKey,saleId:sale.id,paymentId:plan.payment?.id,saleItemId:plan.item?.id,kind:input.kind,quantity:plan.amounts?.quantity,salesDelta,collectionDelta,costDelta,commissionDelta,shiftId:input.shiftId,actorId:ctx.actor.id,reason:input.reason,createdAt:instant,cashEntries:{create:cash}},include:{cashEntries:true}});
 for(const {original,delta} of parts){const portion=await tx.stockReturnPortion.create({data:{adjustmentId:adjustment.id,originalMovementId:original.id,quantity:delta}});const movement=await applyStockDelta(tx,original.productId,delta);await tx.stockMovement.create({data:{...movement,productId:original.productId,type:'CORRECTION',saleId:original.saleId,saleItemId:original.saleItemId,returnPortionId:portion.id,userId:ctx.actor.id,reason:input.reason,createdAt:instant}});}
 if(['PAYMENT_VOID','RETURN',...Pricing.TYPES].includes(input.kind)){
  const paid=l.paid.add(collectionDelta),net=l.total.add(salesDelta),balance=net.sub(paid);
  await tx.sale.update({where:{id:sale.id},data:{amountPaid:paid,balance,status:balance.isZero()?'PAID':paid.isZero()?'UNPAID':'PARTIAL'}});
 }
 await audit(tx,sale.id,ctx.actor.id,['CANCEL','REMOVE_ITEM'].includes(input.kind)?input.kind:'FINANCIAL_'+input.kind,sale,{adjustmentId:adjustment.id,requestId:requestId||null,originalShiftId:sale.shiftId,recordingShiftId:input.shiftId},input.reason);
 return adjustment;
}
async function runAction(req,input,requestId=null){
 if(Pricing.isPricing(input.kind)&&!input.expectedUpdatedAt)throw fail(400,'Review a current pricing preview before submitting.');
 return withShiftTransaction(prisma,async tx=>{
  const initial=await tx.sale.findUnique({where:{id:input.saleId}});if(!initial)throw fail(404,'Order not found');
  const pending=requestId?await tx.financialRequest.findUnique({where:{id:requestId}}):null;
  const unpaid=['CANCEL','REMOVE_ITEM'].includes(input.kind);const shift=unpaid&&initial.shiftId?await tx.shift.findUnique({where:{id:initial.shiftId}}):null;
  const recording=input.shiftId?await tx.shift.findUnique({where:{id:input.shiftId}}):null;
  await lockUsers(tx,[req.user.id,...(pending?[pending.requestedById]:[]),...(shift?[shift.openedById]:[]),...(recording?[recording.openedById]:[])]);
  const ctx=await access(tx,req.auth);authorize(ctx,initial,input.kind);
  let pricingKey,pricingFingerprint;
  if(Pricing.isPricing(input.kind)&&!requestId){
   pricingKey=ctx.actor.id+':'+input.clientRequestId;
   const stable=Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b)));pricingFingerprint=createHash('sha256').update(JSON.stringify(stable)).digest('hex');
   await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(180023,hashtext(${pricingKey}))`;
   const prior=await tx.financialRequest.findUnique({where:{clientKey:pricingKey},include:{adjustment:{include:{cashEntries:true}}}});
   if(prior){if(prior.payload.pricingFingerprint!==pricingFingerprint)throw error('Request identifier was already used for different pricing details.');if(prior.status==='REJECTED')throw error('This request was rejected; review before submitting a new request.');return prior.adjustment?{adjustment:prior.adjustment,permissions:ctx.permissions}:{request:prior,permissions:ctx.permissions};}
  }
  const requires=requestId||(!(Pricing.isPricing(input.kind)&&ctx.actor.role==='MANAGER')&&(mode()==='DUAL_MANAGER'||(mode()==='MANAGER'&&ctx.actor.role!=='MANAGER')));
  if(requestId&&(!pending||ctx.actor.role!=='MANAGER'||pending.requestedById===ctx.actor.id))throw fail(403,'An independent authorized manager must decide this request.');
  if(!requires||requestId){
   if(!input.shiftId)throw fail(400,'Explicit open recording shift is required.');
   if(unpaid&&shift&&input.shiftId!==shift.id)throw error('Unpaid mutation must use its open originating shift.');
   const owner=unpaid&&shift?shift.openedById:recording?.openedById||ctx.actor.id;
   if(!unpaid&&owner!==ctx.actor.id&&!(ctx.actor.role==='MANAGER'&&ctx.permissions.includes('shifts.manage')))throw fail(403,'Another recording drawer requires manager role and shifts.manage.');
   await lockOpenShift(tx,owner,input.shiftId,'CASH');
  }
  await tx.$queryRaw`SELECT id FROM sales WHERE id=${initial.id} FOR UPDATE`;
  const sale=await tx.sale.findUnique({where:{id:initial.id}});authorize(ctx,sale,input.kind);
  if(unpaid&&sale.shiftId!==initial.shiftId)throw error('Originating shift changed while waiting; no changes committed.');
  if(Pricing.isPricing(input.kind))await require('../utils/pricing-operations').storageReady(tx);
  const plan=await prepare(tx,sale,input);
  if(Pricing.isPricing(input.kind)&&plan.refundTotal.gt(0)&&!ctx.permissions.includes('sales.return'))throw fail(403,'A pricing refund additionally requires sales.return.');
  if(requestId){
   await tx.$queryRaw`SELECT id FROM financial_requests WHERE id=${requestId} FOR UPDATE`;
   const current=await tx.financialRequest.findUnique({where:{id:requestId}});
   if(current.status!=='PENDING'||current.payload.expectedStateHash!==stateHash(sale,plan.l))throw error('Request is already decided or the bill changed; review and submit a new request.');
   const requester=await tx.user.findUnique({where:{id:current.requestedById}}),rows=requester?await tx.rolePermission.findMany({where:{role:requester.role,enabled:true},select:{permission:true}}):[];
   const requesterPermissions=requester?.isActive?await require('../utils/custom-role-policy').resolveUserPermissions(tx,requester):[];
   if(!requester?.isActive||!requesterPermissions.includes(grant[input.kind])||Pricing.isPricing(input.kind)&&plan.refundTotal.gt(0)&&!requesterPermissions.includes('sales.return'))throw fail(403,'Requester is no longer authorized.');
   // Request payload is immutable; the pending snapshot was captured under the sale lock.
   const result=await execute(tx,ctx,sale,input,current.id,Pricing.isPricing(input.kind)?current.clientKey:null);
   await tx.financialRequest.update({where:{id:current.id},data:{status:'APPROVED',reviewedById:ctx.actor.id,decisionReason:req.body.reason,decidedAt:await databaseInstant(tx)}});return{adjustment:result,permissions:ctx.permissions};
  }
  const clientKey=ctx.actor.id+':'+input.clientRequestId;
  if(requires){
   const payload={refunds:input.refunds||[],expectedStateHash:stateHash(sale,plan.l),...(Pricing.isPricing(input.kind)?{pricingInput:input,pricingFingerprint,pricingSnapshot:plan.pricing.snapshot,accounting:Pricing.journal(plan.pricing.delta,plan.refundTotal.negated())}: {})};
   const request=await tx.financialRequest.create({data:{clientKey,kind:input.kind,saleId:sale.id,paymentId:input.paymentId,saleItemId:input.saleItemId,quantity:input.quantity,reason:input.reason,payload,requestedById:ctx.actor.id}});
   await audit(tx,sale.id,ctx.actor.id,'FINANCIAL_REQUEST',sale,{requestId:request.id,kind:input.kind},input.reason);return{request,permissions:ctx.permissions};
  }
  if(Pricing.isPricing(input.kind)){
   const pricingRequest=await tx.financialRequest.create({data:{clientKey,kind:input.kind,saleId:sale.id,saleItemId:input.saleItemId,reason:input.reason,requestedById:ctx.actor.id,reviewedById:ctx.actor.id,status:'APPROVED',decidedAt:await databaseInstant(tx),payload:{pricingFingerprint,pricingInput:input,pricingSnapshot:plan.pricing.snapshot,accounting:Pricing.journal(plan.pricing.delta,plan.refundTotal.negated())}}});
   return{adjustment:await execute(tx,ctx,sale,input,pricingRequest.id,clientKey),permissions:ctx.permissions};
  }
  return{adjustment:await execute(tx,ctx,sale,input,null,clientKey),permissions:ctx.permissions};
 });
}
async function create(req,res){const input=parse(requestSchema,req.body);const result=await runAction(req,input);let sale;
 if(!result.request&&req.financialLegacy){const row=await prisma.sale.findUnique({where:{id:input.saleId},include:{items:{where:{removedAt:null},include:{product:{select:{id:true,name:true}}}},payments:true,docket:true,waiter:{select:{id:true,name:true}},financialAdjustments:true}});sale=require('../utils/responses').sale(row,result.permissions);}
 res.status(result.request?202:req.financialLegacy?200:201).json(result.request?{message:'Pending manager approval; no financial or stock changes made.',request:{id:result.request.id,status:'PENDING',kind:result.request.kind}}:{message:'Recorded. No external M-Pesa transfer was performed.',adjustment:projection(result.adjustment,result.permissions),...(sale?{sale}:{})});}
async function decide(req,res){
 const d=parse(decisionSchema,req.body),request=await prisma.financialRequest.findUnique({where:{id:req.params.id}});if(!request)throw fail(404,'Request not found');
 if(d.decision==='APPROVE'){const input={...(request.payload.pricingInput||{}),kind:request.kind,saleId:request.saleId,paymentId:request.paymentId||undefined,saleItemId:request.saleItemId||undefined,quantity:request.quantity||undefined,refunds:request.kind==='RETURN'||Pricing.isPricing(request.kind)?request.payload.refunds:undefined,reason:request.reason,shiftId:d.shiftId};const result=await runAction(req,input,request.id);return res.json({message:'Approved and recorded atomically.',adjustment:projection(result.adjustment,result.permissions)});}
 await withShiftTransaction(prisma,async tx=>{await lockUsers(tx,[req.user.id,request.requestedById]);const ctx=await access(tx,req.auth);const sale=await tx.sale.findUnique({where:{id:request.saleId}});authorize(ctx,sale,request.kind);if(ctx.actor.role!=='MANAGER'||request.requestedById===ctx.actor.id)throw fail(403,'An independent authorized manager must reject this request.');await tx.$queryRaw`SELECT id FROM sales WHERE id=${request.saleId} FOR UPDATE`;await tx.$queryRaw`SELECT id FROM financial_requests WHERE id=${request.id} FOR UPDATE`;const current=await tx.financialRequest.findUnique({where:{id:request.id}});if(current.status!=='PENDING')throw error('Request was already decided.');await tx.financialRequest.update({where:{id:request.id},data:{status:'REJECTED',reviewedById:ctx.actor.id,decisionReason:d.reason,decidedAt:await databaseInstant(tx)}});await audit(tx,request.saleId,ctx.actor.id,'FINANCIAL_REJECT',sale,{requestId:request.id},d.reason);});res.json({message:'Rejected; no financial or inventory changes.'});
}
async function list(req,res){const f=F.filters(req.query,{statuses:['PENDING','APPROVED','REJECTED']});const ctx=await access(prisma,req.auth),kinds=Object.keys(grant).filter(k=>ctx.permissions.includes(grant[k]));const ownership=ctx.actor.role==='MANAGER'&&ctx.permissions.includes('sales.view_all')?{}:{requestedById:ctx.actor.id};const where=F.and({kind:{in:kinds}},ownership,f.status?{status:f.status}:{},f.range?{createdAt:f.range}:{},f.q?{OR:[{reason:F.contains(f.q)},{sale:{saleNumber:F.contains(f.q)}}]}:{});const result=await prisma.$transaction(tx=>F.page(tx,'financialRequest',{where,orderBy:[{createdAt:'desc'},{id:'desc'}],include:{sale:{select:{saleNumber:true}}}},f),{isolationLevel:'RepeatableRead'});res.json({requests:result.rows.map(r=>({id:r.id,kind:r.kind,saleId:r.saleId,saleNumber:r.sale.saleNumber,saleItemId:r.saleItemId,quantity:r.quantity,reason:r.reason,status:r.status,requestedById:r.requestedById,reviewedById:r.reviewedById,decisionReason:r.decisionReason,createdAt:r.createdAt,decidedAt:r.decidedAt})),pagination:result.pagination,approvalMode:mode()});}
async function options(req,res){const ctx=await access(prisma,req.auth),sale=await prisma.sale.findUnique({where:{id:req.params.id},include:{items:{where:{removedAt:null},include:{product:{select:{name:true}}}}}});if(!sale)throw fail(404,'Order not found');if(!ctx.permissions.some(p=>Object.values(grant).includes(p)))throw fail(403,'Financial action access required');authorize(ctx,sale,Object.keys(grant).find(k=>ctx.permissions.includes(grant[k])));const l=await ledger(prisma,sale);const recordingShifts=await prisma.shift.findMany({where:{status:'OPEN',...(ctx.actor.role==='MANAGER'&&ctx.permissions.includes('shifts.manage')?{OR:[{openedById:ctx.actor.id},{id:{in:[sale.shiftId,...l.payments.map(p=>p.receivedShiftId)].filter(Boolean)}}]}:{openedById:ctx.actor.id})},select:{id:true,name:true,openedById:true},orderBy:{id:'asc'},take:200});res.json({saleId:sale.id,saleNumber:sale.saleNumber,originShiftId:sale.shiftId,recordingShifts,originalTotal:sale.total,netTotal:l.total,amountPaid:l.paid,balance:l.balance,updatedAt:sale.updatedAt,approvalMode:mode(),requiresApproval:mode()==='DUAL_MANAGER'||mode()==='MANAGER'&&ctx.actor.role!=='MANAGER',pricingAvailable:await require('../utils/pricing-operations').storageAvailable(prisma),pricingRequiresApproval:!(ctx.actor.role==='MANAGER')&&(mode()==='DUAL_MANAGER'||mode()==='MANAGER'),priorPricing:l.adjustments.some(a=>Pricing.isPricing(a.kind)),availableRefunds:ctx.permissions.includes('sales.return')||ctx.permissions.includes('sales.discount')||ctx.permissions.includes('sales.change_price')?l.methods:undefined,
 items:sale.items.map(i=>({id:i.id,name:i.product.name,quantity:i.quantity,unitPrice:i.unitPrice,returnEligible:i.returnEligible,returnedQuantity:l.adjustments.filter(a=>a.kind==='RETURN'&&a.saleItemId===i.id).reduce((n,a)=>n.add(a.quantity),D(0))})),
 ...(ctx.permissions.includes('pay.void')?{payments:l.payments.map(p=>({id:p.id,amount:p.amount,method:p.method,createdAt:p.createdAt,receivedShiftId:p.receivedShiftId,voided:l.adjustments.some(a=>a.paymentId===p.id),...(ctx.permissions.includes('payments.view_collected')?{reference:p.reference}:{})}))}:{}),
 history:l.adjustments.map(a=>projection(a,ctx.permissions))});}
async function quote(req,res){await prisma.$transaction(async tx=>{const ctx=await access(tx,req.auth),sale=await tx.sale.findUnique({where:{id:req.params.id}});if(!sale)throw fail(404,'Order not found');authorize(ctx,sale,'RETURN');const l=await ledger(tx,sale);if(sale.status!=='PAID'||!l.balance.isZero()||!sale.accountingDate||sale.commissionRateSnapshot===null)throw error('This bill requires manual review before a return.');const items=await tx.saleItem.findMany({where:{saleId:sale.id,removedAt:null}}),item=items.find(i=>i.id===req.query.saleItemId);if(!item||item.returnEligible!==true)throw error('This original item is not verified as returnable.');await verifyStockHistory(tx,[item],sale.id);const amounts=returnAmounts(sale,items,item,req.query.quantity,l.adjustments.filter(a=>a.saleItemId===item.id&&a.kind==='RETURN'));if(l.adjustments.some(a=>Pricing.isPricing(a.kind)))amounts.amount=Pricing.returnValue(Pricing.state(sale,items,await Pricing.hydrate(tx,l.adjustments)),item.id,req.query.quantity);res.json({quantity:amounts.quantity,amount:amounts.amount,availableRefunds:l.methods,updatedAt:sale.updatedAt,notice:'Original discounted value only. No refund is sent by this quote.'});},{isolationLevel:'RepeatableRead',timeout:15000});}
async function pricingQuote(req,res){const input=parse(requestSchema,{...req.body,saleId:req.params.id});if(!Pricing.isPricing(input.kind))throw fail(400,'Choose a pricing action.');await prisma.$transaction(async tx=>{const ctx=await access(tx,req.auth),sale=await tx.sale.findUnique({where:{id:input.saleId}});if(!sale)throw fail(404,'Order not found');authorize(ctx,sale,input.kind);const plan=await require('../utils/pricing-operations').prepare(tx,sale,input,await ledger(tx,sale),true);await verifyDebt(tx,sale);res.json({saleId:sale.id,updatedAt:sale.updatedAt,netTotal:plan.pricing.net,salesDelta:plan.pricing.delta,requiredRefund:plan.requiredRefund,refundAuthorized:plan.requiredRefund.isZero()||ctx.permissions.includes('sales.return'),refundTotal:plan.refundTotal,balance:plan.pricing.net.sub(plan.l.paid.sub(plan.refundTotal)),before:plan.pricing.before,after:plan.pricing.after,accounting:Pricing.journal(plan.pricing.delta,plan.refundTotal.negated()),storageAvailable:await require('../utils/pricing-operations').storageAvailable(tx),notice:'Preview only. Original payments, inventory and costs remain unchanged.'});},{isolationLevel:'RepeatableRead'});}
module.exports={pricingQuote,create,decide,list,options,quote,projection,requestSchema,mode,runAction};
