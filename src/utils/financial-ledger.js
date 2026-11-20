'use strict';
const {Prisma}=require('@prisma/client');
const {D,error}=require('./return-calculations');
const {databaseInstant}=require('./accounting');
async function ledger(tx,sale,cutoff,evidence){
 const when=cutoff?{createdAt:{lt:cutoff}}:{};
 const [payments,adjustments]=evidence&&!cutoff?[evidence.payments,evidence.adjustments]:await Promise.all([tx.payment.findMany({where:{saleId:sale.id,...when}}),tx.financialAdjustment.findMany({where:{saleId:sale.id,...when},include:{cashEntries:true}})]);
 const paid=payments.reduce((n,p)=>n.add(p.amount),D(0)).add(adjustments.reduce((n,a)=>n.add(a.collectionDelta),D(0)));
 const total=D(sale.total).add(adjustments.reduce((n,a)=>n.add(a.salesDelta),D(0)));
 const methods={CASH:D(0),MPESA:D(0)};
 for(const p of payments)methods[p.method]=methods[p.method].add(p.amount);
 for(const a of adjustments)for(const e of a.cashEntries)methods[e.method]=methods[e.method].add(e.amount);
 const receiptEntries=adjustments.filter(a=>['RECEIPT_ALLOCATION','ALLOCATION_REVERSAL'].includes(a.kind));
 if(receiptEntries.length){const rows=await tx.$queryRawUnsafe('SELECT r.method,d."collectionDelta" AS amount FROM employee_settlement_links l JOIN employee_finance_allocations a ON a.id=l.allocation_id JOIN employee_finance_receipts r ON r.id=a.receipt_id JOIN financial_adjustments d ON d.id=l.adjustment_id WHERE l.adjustment_id=ANY($1::text[])',receiptEntries.map(a=>a.id));if(rows.length!==receiptEntries.length)throw error('Receipt settlement provenance cannot be verified.');for(const row of rows)methods[row.method]=methods[row.method].add(row.amount);}
 if(total.lt(0)||paid.lt(0)||paid.gt(total)||Object.values(methods).some(v=>v.lt(0)))throw error('Financial ledger cannot be verified. Manual review required.');
 return{payments,adjustments,paid,total,balance:total.sub(paid),methods};
}
async function commissionTarget(tx,sale,net,settled){
 const sum=await tx.financialAdjustment.aggregate({where:{saleId:sale.id},_sum:{commissionDelta:true}});
 const previous=D(sale.commissionAmount||0).add(sum._sum.commissionDelta||0);
 const target=settled&&sale.commissionEarnedAt&&sale.commissionRateSnapshot!==null?(sale.commissionCapSnapshot==null?net.mul(sale.commissionRateSnapshot).div(100).toDecimalPlaces(2):D(sale.total).isZero()?D(0):D(sale.commissionCapSnapshot).mul(net).div(sale.total).toDecimalPlaces(2)):D(0);
 return target.sub(previous);
}
async function restoreCommissionOnSettlement(tx,sale,payment,net){
 if(!sale.commissionEarnedAt)return;
 const delta=await commissionTarget(tx,sale,net,true);if(delta.lte(0))return;
 if(!payment.receivedShiftId)throw error('Final re-settlement restoring earned commission requires an explicitly selected open receiving shift. No payment was recorded.');
 await tx.financialAdjustment.create({data:{saleId:sale.id,settlementPaymentId:payment.id,kind:'COMMISSION_RESTORE',actorId:payment.receivedById,shiftId:payment.receivedShiftId,commissionDelta:delta,reason:'Commission restored on final re-settlement',createdAt:await databaseInstant(tx)}});
}
module.exports={ledger,commissionTarget,restoreCommissionOnSettlement};
