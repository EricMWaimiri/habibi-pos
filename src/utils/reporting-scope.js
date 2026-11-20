'use strict';
const F=require('./filters'),{D}=require('./return-calculations');
// A reference identifies its bill's flow history. Each event is selected once;
// original and correction date/shift restrictions still apply independently.
const billSearch=q=>({OR:[{saleNumber:F.contains(q)},{notes:F.contains(q)},{waiter:{name:F.contains(q)}},{payments:{some:{OR:[{reference:F.contains(q)},{receivedBy:{name:F.contains(q)}}]}}}]});
const saleScope=f=>F.and(F.saleScope({...f,q:undefined}),f.q?billSearch(f.q):{});
const collectionScope=f=>F.and(F.eventScope(f,'receivedShiftId','receivedById'),f.q?{sale:billSearch(f.q)}:{});
const correctionCollectionScope=f=>F.and(require('./business-day-context').eventScope(f),f.shiftId?{shiftId:F.id(f.shiftId)}:{},f.staffId?{actorId:F.id(f.staffId)}:{},f.method?{cashEntries:{some:{method:f.method}}}:{},f.q?{sale:billSearch(f.q)}:{});
function classifyExpenses(expenses){
 let operating=D(0),stock=D(0),unknown=D(0),oldOperating=D(0),oldStock=D(0),unclassifiedCount=0,linkedCount=0;
 for(const e of expenses){const amount=D(e.amount),legacy=e.category==='Stock Purchase'&&e.description.includes('(PUR-');if(legacy)oldStock=oldStock.add(amount);else oldOperating=oldOperating.add(amount);
  if(e.categoryKindSnapshot==='OPERATING'){operating=operating.add(amount);}
  else if(e.categoryKindSnapshot==='INVENTORY_ACQUISITION'){stock=stock.add(amount);linkedCount++;}
  else if(e.purchase&&D(e.purchase.totalAmount).eq(amount)&&e.purchase.method===e.method){stock=stock.add(amount);linkedCount++;}
  else if(e.purchase||e.category==='Stock Purchase'){unknown=unknown.add(amount);unclassifiedCount++;}
  else operating=operating.add(amount);
 }
 const num=n=>Number(n.toDecimalPlaces(2));
 return {totalExpenses:num(operating),stockPurchases:num(stock),unclassifiedAmount:num(unknown),unclassifiedCount,linkedCount,
  previousOperatingExpenses:num(oldOperating),previousStockPurchases:num(oldStock),operatingDifference:num(operating.sub(oldOperating)),stockDifference:num(stock.sub(oldStock)),
  rule:'Verified purchase-expense link and matching amount/method; unlinked Stock Purchase or inconsistent links require review. No description-based inference.',
  profitVerified:unclassifiedCount===0};
}
async function collectionEvents(db,f){
 const received=await db.payment.findMany({where:collectionScope(f),select:{method:true,amount:true,createdAt:true,receivedShiftId:true,sale:{select:{status:true}}}});
 const entries=await db.adjustmentCashEntry.findMany({where:{...(f.method?{method:f.method}:{}),adjustment:correctionCollectionScope(f)},include:{adjustment:{select:{shiftId:true,createdAt:true}}}});
 const incoming=await db.employee_finance_receipts.findMany({where:{...require('./business-day-context').eventScope(f,'shift_id','created_at'),...(f.shiftId?{shift_id:F.id(f.shiftId)}:{}),...(f.staffId?{actor_id:F.id(f.staffId)}:{}),...(f.method?{method:f.method}:{}),...(f.q?{OR:[{reference:F.contains(f.q)},{sales:billSearch(f.q)}]}:{})},select:{method:true,amount:true,created_at:true,shift_id:true,sales:{select:{status:true}}}});
 return [...received,...incoming.map(r=>({method:r.method,amount:r.amount,createdAt:r.created_at,receivedShiftId:r.shift_id,sale:{status:'INCOMING_RECEIPT'},originSaleStatus:r.sales.status})),...entries.map(e=>({method:e.method,amount:e.amount,createdAt:e.adjustment.createdAt,receivedShiftId:e.adjustment.shiftId,sale:{status:'CORRECTION'}}))];
}
function collectionSummary(events){
 const methods={CASH:D(0),MPESA:D(0)},shifts=new Map();
 for(const e of events){methods[e.method]=methods[e.method].add(e.amount);const key=e.receivedShiftId??null;if(!shifts.has(key))shifts.set(key,{CASH:D(0),MPESA:D(0)});shifts.get(key)[e.method]=shifts.get(key)[e.method].add(e.amount);}
 const values=m=>Object.fromEntries(Object.entries(m).map(([k,v])=>[k,Number(v.toDecimalPlaces(2))]));
 return {methods:values(methods),netCollections:Number(methods.CASH.add(methods.MPESA).toDecimalPlaces(2)),shifts:[...shifts].map(([shiftId,m])=>({shiftId,...values(m)})),basis:'Actual collection/correction date and receiving/recording shift; reference search includes matching bill flow history. M-Pesa is internally recorded, not provider-confirmed.'};
}
module.exports={billSearch,saleScope,collectionScope,correctionCollectionScope,classifyExpenses,collectionEvents,collectionSummary};
