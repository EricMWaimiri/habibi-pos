'use strict';
const prisma = require('../config/prisma');
const response = require('../utils/responses');
const F = require('../utils/filters');
const snapshot = fn => (req,res) => prisma.$transaction(tx => fn(req,res,tx), {isolationLevel:'RepeatableRead',timeout:15000});
const paymentList = snapshot(async(req,res,db)=>{
  const f=F.filters(req.query),where=F.and(F.eventScope(f,'receivedShiftId','receivedById'), f.q ? {OR:[{reference:F.contains(f.q)},{sale:{saleNumber:F.contains(f.q)}}]}:{});
  const result=await F.page(db,'payment',{where,orderBy:[{createdAt:'desc'},{id:'desc'}],include:{sale:{select:{saleNumber:true}}}},f);
  res.json({payments:result.rows.map(p=>({...response.payment(p),saleNumber:p.sale.saleNumber})),pagination:result.pagination,attribution:'actual collection time and receiving shift; unassigned is explicit'});
});
const movementList = snapshot(async(req,res,db)=>{
  const f=F.filters(req.query);const types=['IN','OUT','SALE','ADJUSTMENT','COUNT','CORRECTION'];
  if(f.type&&!types.includes(f.type))throw Object.assign(new Error('Invalid movement type'),{status:400});
  // Only explicit immutable sale/purchase provenance gives an origin shift.
  let shift={};
  if(f.shiftId){
    const sales=await db.sale.findMany({where:{shiftId:f.shiftId==='unassigned'?{not:null}:f.shiftId},select:{id:true}}),ids=sales.map(x=>x.id);
    shift=f.shiftId==='unassigned'?{AND:[{OR:[{saleId:null},{saleId:{notIn:ids}}]},{OR:[{purchaseItemId:null},{purchaseItem:{purchase:{shiftId:null}}}]}]}:{OR:[{saleId:{in:ids}},{purchaseItem:{purchase:{shiftId:f.shiftId}}}]};
  }
  const where=F.and(f.range?{createdAt:f.range}:{},f.staffId?{userId:F.id(f.staffId)}:{},f.productId?{productId:f.productId}:{},f.type?{type:f.type}:{},shift,f.q?{OR:[{reason:F.contains(f.q)},{product:{name:F.contains(f.q)}}]}:{});
  const result=await F.page(db,'stockMovement',{where,orderBy:[{createdAt:'desc'},{id:'desc'}],include:{product:{select:{name:true,unitOfMeasure:true}},purchaseItem:{select:{purchase:{select:{id:true,shiftId:true}}}},returnPortion:{select:{originalMovementId:true,adjustment:{select:{id:true,shiftId:true}}}}}},f);
  const sales=await db.sale.findMany({where:{id:{in:[...new Set(result.rows.map(x=>x.saleId).filter(Boolean))]}},select:{id:true,shiftId:true}}),bySale=new Map(sales.map(s=>[s.id,s.shiftId]));
  res.json({movements:result.rows.map(m=>({id:m.id,productId:m.productId,product:m.product,type:m.type,quantityChange:m.quantityChange,previousQty:m.previousQty,quantityAfter:m.quantityAfter,reason:m.reason,saleId:m.saleId,saleItemId:m.saleItemId,reversalOfId:m.reversalOfId,returnPortionId:m.returnPortionId,originalMovementId:m.returnPortion?.originalMovementId,adjustmentId:m.returnPortion?.adjustment.id,recordingShiftId:m.returnPortion?.adjustment.shiftId,userId:m.userId,createdAt:m.createdAt,purchaseItemId:m.purchaseItemId,purchaseId:m.purchaseItem?.purchase.id,shiftId:bySale.get(m.saleId)??m.purchaseItem?.purchase.shiftId??null,attribution:m.saleId&&bySale.get(m.saleId)?'sale-origin':m.purchaseItem?.purchase.shiftId?'purchase-origin':'unassigned'})),pagination:result.pagination});
});
const options = snapshot(async(req,res,db)=>{
  const broad=['sales.view_all','reports.sales','reports.financial','payments.view_collected','expenses.manage','purchases.manage','shifts.manage','commissions.manage'].some(p=>req.permissions.includes(p));
  const f=F.filters(req.query);const where=F.and(broad?{}:{OR:[{openedById:req.user.id},{assignments:{some:{userId:req.user.id}}},{sales:{some:{OR:[{waiterId:req.user.id},{createdById:req.user.id}]}}}]},f.range?{openedAt:{lt:f.range.lt},OR:[{closedAt:null},{closedAt:{gte:f.range.gte}}]}:{},f.q?{OR:[{name:F.contains(f.q)},{id:F.contains(f.q)}]}:{});
  const result=await F.page(db,'shift',{where,orderBy:[{openedAt:'desc'},{id:'desc'}],select:{id:true,name:true,status:true,openedAt:true,closedAt:true}},f);
  const staff=broad?await db.user.findMany({where:f.q?{name:F.contains(f.q)}:{},select:{id:true,name:true},orderBy:[{name:'asc'},{id:'asc'}],take:200}):[{id:req.user.id,name:req.user.name}];
  res.json({shifts:result.rows,staff,pagination:result.pagination});
});
module.exports={paymentList:require('./payment-ledger.controller').list,movementList,purchases:require('./invoices.controller').purchaseList,options};
