'use strict';
const prisma=require('../config/prisma'),{Prisma}=require('@prisma/client'),{z}=require('zod');
const {withShiftTransaction}=require('../utils/shift-transactions'),{assertCurrentSession}=require('../utils/session-version');
const {readAdminContext}=require('../utils/permissions'),{lockMutableSales,databaseInstant,nairobiDate,audit}=require('../utils/accounting');
const {entitlement}=require('../utils/commission-snapshot'),response=require('../utils/responses');
const bad=(status,message)=>Object.assign(new Error(message),{status});
const schema=z.object({params:z.object({id:z.string().min(1)}),body:z.object({itemIds:z.array(z.string().min(1)).min(1).max(49),reason:z.string().trim().min(3).max(200),clientRequestId:z.string().uuid()}).strict()});
async function split(req,res){
 const {id}=req.validated.params,input=req.validated.body;let permissions;
 const result=await withShiftTransaction(prisma,async tx=>{
  const actor=await assertCurrentSession(tx,req.auth),context=await readAdminContext(tx,actor.id);permissions=context.permissions[actor.role];
  if(!permissions.includes('sales.split'))throw bad(403,'Bill splitting is not permitted.');
  const [source]=await lockMutableSales(tx,[id],actor,permissions,true);
  // Revalidate after waits; credentials/grants may have changed before locks.
  await assertCurrentSession(tx,req.auth);const fresh=await readAdminContext(tx,actor.id);if(!fresh.permissions[actor.role].includes('sales.split'))throw bad(403,'Bill splitting is not permitted.');permissions=fresh.permissions[actor.role];
  if(await tx.sale.findUnique({where:{splitRequestId:input.clientRequestId}}))throw bad(409,'This split request was already processed. Refresh the bills.');
  const ids=[...new Set(input.itemIds)],items=source.items.filter(i=>!i.removedAt),selected=items.filter(i=>ids.includes(i.id));
  if(ids.length!==input.itemIds.length||selected.length!==ids.length||selected.length>=items.length)throw bad(400,'Choose existing whole lines and leave at least one line on the original bill.');
  if(source.total.lte(0)||await tx.financialRequest.count({where:{saleId:id,status:'PENDING'}})||await tx.financialAdjustment.count({where:{saleId:id}}))throw bad(409,'This bill has financial corrections or approval requests; review it before splitting.');
  const subtotal=selected.reduce((n,i)=>n.add(i.subtotal),new Prisma.Decimal(0)),discount=source.discount.mul(subtotal).div(source.subtotal).toDecimalPlaces(2),total=subtotal.sub(discount),remaining=source.total.sub(total);
  if(total.lte(0)||remaining.lte(0))throw bad(409,'Both resulting bills must have a positive net value.');
  const cap=entitlement(source),targetCap=cap.mul(total).div(source.total).toDecimalPlaces(2),instant=await databaseInstant(tx);
  const target=await tx.sale.create({data:{splitFromId:id,splitRequestId:input.clientRequestId,status:'UNPAID',subtotal,discount,total,balance:total,amountPaid:0,shiftId:source.shiftId,waiterId:source.waiterId,createdById:source.createdById,cashierId:source.cashierId,accountingDate:source.accountingDate,createdAt:instant,commissionRateSnapshot:source.commissionRateSnapshot,commissionCapSnapshot:targetCap,notes:'Split from '+source.saleNumber}});
  for(const item of selected){const origins=await tx.stockMovement.findMany({where:{saleItemId:item.id,type:'SALE'},select:{saleId:true}});const origin=item.stockOriginSaleId||origins[0]?.saleId||id;if(origins.some(m=>m.saleId!==origin))throw bad(409,'Original stock attribution is ambiguous; manual review required.');await tx.saleItem.update({where:{id:item.id},data:{saleId:target.id,stockOriginSaleId:origin}});}
  await tx.sale.update({where:{id},data:{subtotal:source.subtotal.sub(subtotal),discount:source.discount.sub(discount),total:remaining,balance:remaining,commissionCapSnapshot:cap.sub(targetCap)}});
  await audit(tx,id,actor.id,'SPLIT_OUT',source,{targetId:target.id,itemIds:ids},input.reason);
  await audit(tx,target.id,actor.id,'SPLIT_IN',target,{sourceId:id,itemIds:ids},input.reason);
  if(nairobiDate(await databaseInstant(tx))!==source.accountingDate.toISOString().slice(0,10))throw bad(409,'Accounting date changed; no split was committed.');
  const include={items:{where:{removedAt:null},include:{product:{select:{id:true,name:true}}}},payments:true,financialAdjustments:true};
  const bills=await tx.sale.findMany({where:{id:{in:[id,target.id]}},include});
  if(!bills.reduce((n,s)=>n.add(s.total),new Prisma.Decimal(0)).eq(source.total)||!bills.reduce((n,s)=>n.add(entitlement(s)),new Prisma.Decimal(0)).eq(cap))throw bad(409,'Split values could not be preserved.');
  return{source:bills.find(s=>s.id===id),split:bills.find(s=>s.id===target.id)};
 });
 res.status(201).json({message:'Unpaid bill split. Original stock deductions and preparation ticket were preserved; no new print job was created.',sale:response.sale(result.source,permissions),splitSale:response.sale(result.split,permissions)});
}
module.exports={split,schema};
