'use strict';
const {D,money,allocateNet,error}=require('./return-calculations');
const TYPES=['SALE_DISCOUNT','SALE_PRICE_CHANGE'];
const isPricing=kind=>TYPES.includes(kind);
function allocate(total,rows){
 const cents=BigInt(money(total).mul(100).toFixed(0)),sum=rows.reduce((n,r)=>n+BigInt(money(r.amount).mul(100).toFixed(0)),0n);
 if(cents<0n||cents>sum)throw error('Invalid pricing allocation.');
 if(!sum)return rows.map(r=>({...r,amount:'0.00'}));
 const parts=rows.map(r=>{const value=BigInt(money(r.amount).mul(100).toFixed(0));return{r,cents:cents*value/sum,remainder:cents*value%sum};});
 let left=cents-parts.reduce((n,r)=>n+r.cents,0n);parts.sort((a,b)=>a.remainder===b.remainder?a.r.id.localeCompare(b.r.id):a.remainder>b.remainder?-1:1);
 for(const p of parts)if(left>0n){p.cents++;left--;}
 return parts.map(p=>({...p.r,amount:D(p.cents.toString()).div(100).toFixed(2)})).sort((a,b)=>a.id.localeCompare(b.id));
}
function state(sale,items,adjustments){
 const prices=adjustments.filter(a=>isPricing(a.kind));
 let rows,covered=new Set(),version=0;
 if(prices.length){
  const versions=prices.map(a=>a.request?.payload?.pricingSnapshot);if(versions.some(x=>!x||x.format!==1||!Number.isInteger(x.version)))throw error('Pricing provenance is unavailable.');
  versions.sort((a,b)=>a.version-b.version);if(versions.some((v,i)=>v.version!==i+1))throw error('Pricing correction sequence cannot be verified.');
  const latest=versions.at(-1);version=latest.version;rows=latest.after.map(r=>({...r}));covered=new Set(latest.returnIds);
  if(rows.some(r=>!items.some(i=>i.id===r.id)))throw error('Priced bill lines changed; manual review required.');
  for(const item of items)if(!rows.some(r=>r.id===item.id))rows.push({id:item.id,quantity:String(item.quantity),amount:money(item.subtotal).toFixed(2)});
  if([...covered].some(id=>!adjustments.some(a=>a.id===id&&a.kind==='RETURN')))throw error('Pricing return provenance cannot be verified.');
 }else{const net=allocateNet(sale,items);rows=items.map(i=>({id:i.id,quantity:String(i.quantity),amount:net.get(i.id).toFixed(2)}));}
 const allReturns=adjustments.filter(a=>a.kind==='RETURN');
 for(const row of rows){
  const returns=allReturns.filter(a=>a.saleItemId===row.id&&!covered.has(a.id));
  const used=returns.reduce((n,a)=>n.add(a.quantity),D(0)),refunded=returns.reduce((n,a)=>n.sub(a.salesDelta),D(0));
  row.anchorQuantity=String(row.quantity);row.anchorAmount=String(row.amount);row.usedQuantity=used.toString();row.refunded=refunded.toFixed(2);
  row.quantity=D(row.quantity).sub(used).toString();row.amount=money(D(row.amount).sub(refunded)).toFixed(2);
  if(D(row.quantity).lt(0)||D(row.amount).lt(0))throw error('Return and pricing history cannot be reconciled.');
 }
 return{rows,version,returnIds:allReturns.map(a=>a.id).sort()};
}
function returnValue(current,itemId,rawQuantity){
 const row=current.rows.find(r=>r.id===itemId),q=D(rawQuantity);
 if(!row||!q.isFinite()||q.lte(0)||q.gt(row.quantity)||D(row.anchorQuantity).lte(0))throw error('Quantity exceeds the remaining returnable quantity.');
 return money(D(row.anchorAmount).mul(D(row.usedQuantity).add(q)).div(row.anchorQuantity).toDecimalPlaces(2).sub(row.refunded));
}
function calculate(current,input){
 if(!isPricing(input.kind))throw error('Unsupported pricing correction.');
 if(current.version&&input.acknowledgePriorPricing!==true)throw error('Review and explicitly acknowledge earlier pricing corrections before applying another adjustment.');
 const before=current.rows.map(r=>({id:r.id,quantity:r.quantity,amount:r.amount})).sort((a,b)=>a.id.localeCompare(b.id)),base=before.reduce((n,r)=>n.add(r.amount),D(0));
 const targets=input.saleItemId?before.filter(r=>r.id===input.saleItemId):before.filter(r=>D(r.quantity).gt(0));
 if(!targets.length||targets.some(r=>D(r.quantity).lte(0)))throw error('Select an item with an unreturned quantity.');
 let after=before.map(r=>({...r}));const eligible=targets.reduce((n,r)=>n.add(r.amount),D(0));
 if(input.kind==='SALE_DISCOUNT'){
  const value=money(input.value);if(value.lt(0)||!['FIXED','PERCENT'].includes(input.discountType)||input.discountType==='PERCENT'&&value.gt(100))throw error('Discount must be nonnegative and cannot exceed 100%.');
  const discount=input.discountType==='PERCENT'?eligible.mul(value).div(100).toDecimalPlaces(2):value;
  if(discount.gt(eligible))throw error('Discount exceeds the eligible remaining value.');
  const revised=new Map(allocate(eligible.sub(discount),targets).map(r=>[r.id,r.amount]));after=after.map(r=>({...r,amount:revised.get(r.id)??r.amount}));
 }else{
  const price=money(input.value);if(!input.saleItemId||price.lt(0))throw error('Select one item and a nonnegative selling price.');
  if(price.isZero()&&input.acknowledgeZeroPrice!==true)throw error('Zero selling prices require explicit acknowledgement.');
  after=after.map(r=>r.id===input.saleItemId?{...r,amount:money(price.mul(r.quantity).toDecimalPlaces(2)).toFixed(2)}:r);
 }
 const net=after.reduce((n,r)=>n.add(r.amount),D(0));money(net);const delta=net.sub(base);if(delta.isZero())throw error('This correction makes no monetary change.');
 return{before,after,base,net,delta,snapshot:{format:1,version:current.version+1,returnIds:current.returnIds,before,after,input:{kind:input.kind,saleItemId:input.saleItemId||null,discountType:input.discountType||null,value:String(input.value),acknowledgeZeroPrice:input.acknowledgeZeroPrice===true,acknowledgePriorPricing:input.acknowledgePriorPricing===true}}};
}
async function hydrate(tx,adjustments){
 const missing=adjustments.filter(a=>isPricing(a.kind)&&!a.request);if(!missing.length)return adjustments;
 const rows=await tx.financialRequest.findMany({where:{id:{in:missing.map(a=>a.requestId).filter(Boolean)}},select:{id:true,payload:true}}),byId=new Map(rows.map(r=>[r.id,r]));
 return adjustments.map(a=>isPricing(a.kind)?{...a,request:a.request||byId.get(a.requestId)}:a);
}
function journal(delta,collectionDelta){
 const revenue=money(delta),cash=money(collectionDelta),receivable=revenue.sub(cash);
 // Existing authoritative sales engine: FinancialAdjustment deltas, not a second journal.
 return{revenueDelta:revenue.toFixed(2),receivableDelta:receivable.toFixed(2),collectionDelta:cash.toFixed(2),stockDelta:'0',costDelta:'0.00',balanced:revenue.eq(receivable.add(cash))};
}
function commissionBasis(sale,net){return sale.commissionCapSnapshot==null?D(net).mul(sale.commissionRateSnapshot||0).div(100).toDecimalPlaces(2):D(sale.total).isZero()?D(0):D(sale.commissionCapSnapshot).mul(net).div(sale.total).toDecimalPlaces(2);}
module.exports={commissionBasis,TYPES,isPricing,allocate,state,returnValue,calculate,hydrate,journal};
