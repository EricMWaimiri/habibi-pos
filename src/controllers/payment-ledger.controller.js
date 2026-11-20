'use strict';
const prisma=require('../config/prisma'),{Prisma}=require('@prisma/client');
const F=require('../utils/filters'),response=require('../utils/responses');
const {D}=require('../utils/return-calculations');
const {MPESA_REFERENCE_SQL}=require('../utils/payment-reference');
const {billSearch}=require('../utils/reporting-scope');
// The reference predicate is the same normalization as payment validation/index.
// Existing records are never marked provider-confirmed: no provider adapter exists.
const classification=Prisma.raw(`CASE WHEN v.id IS NOT NULL THEN 'VOIDED' WHEN p."receivedShiftId" IS NULL THEN 'UNRESOLVED' WHEN p.method='CASH' THEN 'CLEARED' WHEN ${MPESA_REFERENCE_SQL.replace(/\breference\b/g,'p.reference')} ~ '^[A-Z0-9]{10}$' THEN 'PENDING' ELSE 'UNRESOLVED' END`);
async function list(req,res){
 const f=F.filters(req.query,{statuses:['CLEARED','PENDING','UNRESOLVED','VOIDED']});
 const predicates=[];
 // Prisma raw Date parameters are timestamptz, while stored Prisma dates are
 // UTC timestamp-without-zone. Explicit UTC timestamp bounds avoid the server
 // timezone shifting an exact Nairobi midnight out of the requested period.
 if(f.range)predicates.push(Prisma.sql`p."createdAt">=${f.range.gte.toISOString()}::timestamp AND p."createdAt"<${f.range.lt.toISOString()}::timestamp`);
 if(f.shiftId)predicates.push(f.shiftId==='unassigned'?Prisma.sql`p."receivedShiftId" IS NULL`:Prisma.sql`p."receivedShiftId"=${f.shiftId}`);
 if(f.staffId)predicates.push(f.staffId==='unassigned'?Prisma.sql`p."receivedById" IS NULL`:Prisma.sql`p."receivedById"=${f.staffId}`);
 if(f.method)predicates.push(Prisma.sql`p.method::text=${f.method}`);
 if(f.q){const text='%'+f.q+'%';predicates.push(Prisma.sql`(s."saleNumber" ILIKE ${text} OR s.notes ILIKE ${text} OR EXISTS(SELECT 1 FROM users sw WHERE sw.id=s."waiterId" AND sw.name ILIKE ${text}) OR EXISTS(SELECT 1 FROM payments sp LEFT JOIN users su ON su.id=sp."receivedById" WHERE sp."saleId"=s.id AND (sp.reference ILIKE ${text} OR su.name ILIKE ${text})))`);}
 const periodPredicates=[...predicates];
 if(f.status)predicates.push(Prisma.sql`${classification}=${f.status}`);
 const where=predicates.length?Prisma.sql`WHERE ${Prisma.join(predicates,' AND ')}`:Prisma.empty;
 await prisma.$transaction(async tx=>{
  const join=Prisma.sql`FROM payments p JOIN sales s ON s.id=p."saleId" LEFT JOIN users u ON u.id=p."receivedById" LEFT JOIN financial_adjustments v ON v."paymentId"=p.id`;
  const ids=await tx.$queryRaw(Prisma.sql`SELECT p.id,${classification} AS classification ${join} ${where} ORDER BY p."createdAt" DESC,p.id DESC OFFSET ${(f.page-1)*f.pageSize} LIMIT ${f.pageSize}`);
  const [summary]=await tx.$queryRaw(Prisma.sql`SELECT count(*)::int AS total,coalesce(sum(p.amount),0) AS recorded,coalesce(sum(CASE WHEN v.id IS NOT NULL THEN p.amount ELSE 0 END),0) AS voided ${join} ${where}`);
  const rows=await tx.payment.findMany({where:{id:{in:ids.map(x=>x.id)}},include:{sale:{select:{saleNumber:true}},receivedBy:{select:{id:true,name:true}},voidAdjustment:{select:{id:true,createdAt:true,shiftId:true,reason:true}}}}),byId=new Map(rows.map(r=>[r.id,r]));
  const adjustments=await tx.adjustmentCashEntry.findMany({where:{...(f.method?{method:f.method}:{}),adjustment:{...(f.range?{createdAt:f.range}:{}),...(f.shiftId?{shiftId:F.id(f.shiftId)}:{}),...(f.staffId?{actorId:F.id(f.staffId)}:{}),...(f.q?{sale:billSearch(f.q)}:{})}},select:{amount:true}});
  const correctionFlows=adjustments.reduce((n,a)=>n.add(a.amount),D(0));
  let periodRecorded=summary.recorded;if(f.status){const periodWhere=periodPredicates.length?Prisma.sql`WHERE ${Prisma.join(periodPredicates,' AND ')}`:Prisma.empty;const [period]=await tx.$queryRaw(Prisma.sql`SELECT coalesce(sum(p.amount),0) AS recorded ${join} ${periodWhere}`);periodRecorded=period.recorded;}
  const physical=await require('../utils/reporting-scope').collectionEvents(tx,f),physicalSummary=require('../utils/reporting-scope').collectionSummary(physical);
  res.json({payments:ids.map(({id,classification})=>{const p=byId.get(id);return{...response.payment(p),saleNumber:p.sale.saleNumber,receivedBy:p.receivedBy,reviewStatus:classification,ledgerStatus:p.voidAdjustment?'VOIDED':'RECORDED',providerConfirmation:p.method==='MPESA'?'NOT_INTEGRATED':'NOT_APPLICABLE',void:p.voidAdjustment};}),pagination:{page:f.page,pageSize:f.pageSize,total:summary.total,pages:Math.ceil(summary.total/f.pageSize)},totals:{recorded:summary.recorded,voidedRecords:summary.voided,activeRecords:D(summary.recorded).sub(summary.voided),periodRecorded,correctionFlows,netCollections:physicalSummary.netCollections,receiptCollections:D(physicalSummary.netCollections).sub(D(periodRecorded).add(correctionFlows))},attribution:'Record totals follow review-status filters; net collections cover matching dated ledger flows independently of review status. Search by bill to include its whole refund history. Full incoming receipt collections are included in net collections; allocation details are in Employee finance. Original collections and corrections retain their separate actual dates/shifts. Pending is recorded M-Pesa awaiting external verification, not an unpaid bill. No provider confirmation is claimed.'});
 },{isolationLevel:'RepeatableRead',timeout:15000});
}
module.exports={list};
