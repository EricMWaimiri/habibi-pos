'use strict';
const {Prisma}=require('@prisma/client');
const {isRealDate,nairobiDate}=require('./accounting');
const D=v=>new Prisma.Decimal(v??0),ZERO=()=>D(0);
const error=(status,message)=>Object.assign(new Error(message),{status});
function money(v,{positive=false,nonzero=false}={}){
 if(!['string','number'].includes(typeof v))throw error(400,'Enter a monetary amount.');
 let n;try{n=D(v);}catch{throw error(400,'Invalid monetary amount.');}
 if(!n.isFinite()||n.decimalPlaces()>2||n.abs().gt('9999999999.99')||(positive&&!n.gt(0))||(nonzero&&n.eq(0)))throw error(400,'Amount must be finite, within range and use at most two decimal places.');
 return n;
}
const sum=(rows,key='amount')=>rows.reduce((n,r)=>n.add(r[key]||0),ZERO());
const day=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const before=(row,asOf)=>!asOf||day(row.posting_date||nairobiDate(row.created_at))<=asOf;
const reversalOf=(rows,key,id,asOf)=>rows.some(r=>r[key]===id&&before(r,asOf));
function supplierLedger(data,asOf){
 if(asOf&&!isRealDate(asOf))throw error(400,'Invalid statement cutoff.');
 const postings=data.postings.filter(r=>before(r,asOf)),payments=data.payments.filter(r=>before(r,asOf)),credits=data.credits.filter(r=>before(r,asOf)),adjustments=data.adjustments.filter(r=>before(r,asOf)),openings=(data.openings||[]).filter(r=>before(r,asOf));
 const activePayments=payments.filter(p=>!reversalOf(adjustments,'supplier_payment_id',p.id,asOf));
 const activeCredits=credits.filter(c=>!reversalOf(adjustments,'credit_note_id',c.id,asOf));
 const paymentIds=new Set(activePayments.map(x=>x.id)),creditIds=new Set(activeCredits.map(x=>x.id));
 const allocations=data.paymentAllocations.filter(a=>paymentIds.has(a.payment_id)&&before(a,asOf)&&!reversalOf(data.allocationReversals||[],'payment_allocation_id',a.id,asOf));
 const creditAllocations=data.creditAllocations.filter(a=>creditIds.has(a.credit_note_id)&&before(a,asOf)&&!reversalOf(data.allocationReversals||[],'credit_allocation_id',a.id,asOf));
 const invoices=postings.map(p=>{
  const corrections=sum(adjustments.filter(a=>a.purchase_id===p.purchase_id),'payable_delta');
  const net=D(p.amount).add(corrections),paid=sum(allocations.filter(a=>a.purchase_id===p.purchase_id)),credited=sum(creditAllocations.filter(a=>a.purchase_id===p.purchase_id));
  const outstanding=net.sub(paid).sub(credited);if(net.lt(0)||outstanding.lt(0))throw error(409,'Supplier invoice ledger does not reconcile; manual review required.');
  const age=Math.max(0,Math.floor((Date.parse((asOf||nairobiDate(new Date()))+'T00:00:00Z')-Date.parse(day(p.due_date)+'T00:00:00Z'))/86400000));
  const referenceCorrections=adjustments.filter(a=>a.purchase_id===p.purchase_id&&a.metadata?.invoiceNumber).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)||a.id.localeCompare(b.id));
  return {...p,originalInvoiceNumber:p.invoiceNumber,invoiceNumber:referenceCorrections.at(-1)?.metadata.invoiceNumber||p.invoiceNumber,originalAmount:D(p.amount).toFixed(2),corrections:corrections.toFixed(2),netAmount:net.toFixed(2),paid:paid.toFixed(2),credits:credited.toFixed(2),outstanding:outstanding.toFixed(2),status:net.eq(0)?'CANCELLED':outstanding.eq(0)?'PAID':paid.add(credited).gt(0)?'PARTIAL':'UNPAID',overdue:outstanding.gt(0)&&age>0,daysOverdue:age,agingBucket:age===0?'CURRENT':age<=30?'1_30':age<=60?'31_60':age<=90?'61_90':'OVER_90'};
 });
 const advances=activePayments.map(p=>({...p,available:D(p.amount).sub(sum(allocations.filter(a=>a.payment_id===p.id))).toFixed(2)}));
 const unappliedCredits=activeCredits.map(c=>({...c,available:D(c.amount).sub(sum(creditAllocations.filter(a=>a.credit_note_id===c.id))).toFixed(2)}));
 if([...advances,...unappliedCredits].some(x=>D(x.available).lt(0)))throw error(409,'Supplier allocations exceed available funds; manual review required.');
 const transactions=[];
 const add=(r,type,reference,debit,credit)=>transactions.push({id:r.id||r.purchase_id,date:day(r.posting_date),createdAt:r.created_at,type,reference:reference||r.id||r.purchase_id,debit:D(debit).toFixed(2),credit:D(credit).toFixed(2)});
 for(const p of postings)add(p,'INVOICE',p.purchaseNumber,p.amount,0);
 for(const p of payments)add(p,'PAYMENT',p.reference,0,p.amount);
 for(const c of credits)add(c,'CREDIT_NOTE',c.reference,0,c.amount);
 for(const o of openings)add(o,'OPENING',o.id,D(o.amount).gt(0)?o.amount:0,D(o.amount).lt(0)?D(o.amount).neg():0);
 for(const a of adjustments){if(a.purchase_id)add(a,'PURCHASE_CORRECTION',a.purchase_id,a.payable_delta,0);else if(a.supplier_payment_id)add(a,'PAYMENT_REVERSAL',a.supplier_payment_id,payments.find(p=>p.id===a.supplier_payment_id)?.amount||0,0);else if(a.credit_note_id)add(a,'CREDIT_REVERSAL',a.credit_note_id,credits.find(c=>c.id===a.credit_note_id)?.amount||0,0);}
 transactions.sort((a,b)=>a.date.localeCompare(b.date)||new Date(a.createdAt)-new Date(b.createdAt)||a.id.localeCompare(b.id));
 let running=ZERO();for(const t of transactions){running=running.add(t.debit).sub(t.credit);t.balance=running.toFixed(2);}
 const totalInvoices=sum(invoices,'netAmount'),totalPayments=sum(activePayments),totalCredits=sum(activeCredits),opening=sum(openings),balance=totalInvoices.add(opening).sub(totalPayments).sub(totalCredits);
 if(!running.eq(balance))throw error(409,'Supplier statement reconciliation failed.');
 const buckets=Object.fromEntries(['CURRENT','1_30','31_60','61_90','OVER_90'].map(k=>[k,sum(invoices.filter(i=>i.agingBucket===k),'outstanding').toFixed(2)]));
 return {invoices,advances,unappliedCredits,transactions,totals:{invoices:totalInvoices.toFixed(2),payments:totalPayments.toFixed(2),credits:totalCredits.toFixed(2),opening:opening.toFixed(2),balance:balance.toFixed(2),outstanding:sum(invoices,'outstanding').toFixed(2),overdue:sum(invoices.filter(i=>i.overdue),'outstanding').toFixed(2),advances:sum(advances,'available').toFixed(2),unappliedCredits:sum(unappliedCredits,'available').toFixed(2)},aging:buckets,asOf:asOf||null};
}
function csv(rows,columns,heading,period){
 const cell=v=>'"'+String(v??'').replace(/^[=+\-@\t\r]/,"'$&").replace(/"/g,'""')+'"';
 return '\ufeff'+[heading,period,columns.map(c=>c.label).map(cell).join(','),...rows.map(r=>columns.map(c=>cell(typeof c.value==='function'?c.value(r):r[c.value])).join(','))].join('\r\n');
}
module.exports={D,money,sum,day,before,supplierLedger,csv,error};
