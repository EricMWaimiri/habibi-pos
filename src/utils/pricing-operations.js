'use strict';
const P=require('./pricing-calculations'),{D,money,error}=require('./return-calculations');
async function storageAvailable(tx){const rows=await tx.$queryRawUnsafe("SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid IN ('public.financial_requests'::regclass,'public.financial_adjustments'::regclass) AND conname IN ('financial_request_shape','financial_adjustment_shape')");return rows.length===2&&rows.every(r=>P.TYPES.every(k=>r.definition.includes("'"+k+"'")));}
async function storageReady(tx){if(!await storageAvailable(tx))throw Object.assign(Error('Pricing corrections are awaiting the reviewed database migration. No change was recorded.'),{status:503});}
async function prepare(tx,sale,input,l,preview=false){
 if(['CANCELLED','MERGED'].includes(sale.status)||!sale.accountingDate||sale.commissionRateSnapshot===null)throw error('This bill lacks verified pricing/accounting provenance.');
 if(input.expectedUpdatedAt&&sale.updatedAt.toISOString()!==input.expectedUpdatedAt)throw error('Bill changed; review a fresh correction preview.');
 if(input.quantity!==undefined||input.paymentId)throw error('Pricing does not modify original quantities or payment records.');
 if(input.kind==='SALE_PRICE_CHANGE'&&input.discountType!==undefined)throw error('Price overrides do not accept a discount type.');
 const items=await tx.saleItem.findMany({where:{saleId:sale.id,removedAt:null}}),adjustments=await P.hydrate(tx,l.adjustments),current=P.state(sale,items,adjustments);
 if(!current.rows.reduce((n,r)=>n.add(r.amount),D(0)).eq(l.total))throw error('Item pricing allocations disagree with the financial ledger.');
 const pricing=P.calculate(current,input);pricing.snapshot.originalItems=items.map(i=>({id:i.id,quantity:String(i.quantity),unitPrice:String(i.unitPrice),subtotal:String(i.subtotal),discount:String(i.discount||0)}));const requiredRefund=l.paid.gt(pricing.net)?l.paid.sub(pricing.net):D(0);
 const refunds=(input.refunds||[]).map(r=>({...r,amount:money(r.amount)})),refundTotal=refunds.reduce((n,r)=>n.add(r.amount),D(0));
 if(new Set(refunds.map(r=>r.method)).size!==refunds.length||refunds.some(r=>r.amount.lte(0)))throw error('Use one positive refund amount per payment method.');
 if((!preview||refunds.length)&&!refundTotal.eq(requiredRefund))throw error('Explicit refunds must exactly cover the reduction beyond the outstanding balance.');
 for(const refund of refunds){if(!['CASH','MPESA'].includes(refund.method)||refund.amount.gt(l.methods[refund.method]))throw error('Refund exceeds the verified collected amount by that method.');if(refund.method==='MPESA'&&(refund.externallyHandled!==true||!refund.externalReference?.trim()))throw error('Record the external M-Pesa refund reference and explicit external-handling acknowledgement. No refund is sent by this application.');}
 return{l,pricing,requiredRefund,refundTotal,refunds};
}
module.exports={prepare,storageAvailable,storageReady};
