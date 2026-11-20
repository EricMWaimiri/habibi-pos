'use strict';
// Pure planning only. Callers must re-read balances, eligibility, reference
// uniqueness and permissions under the accepted transaction locks before posting.
// No database/client imports, automatic settlement, tip approval or payroll rules.
const {money,D,error}=require('./accounting-ledger');
const {normalizeMpesaReference,isValidMpesaReference}=require('./payment-reference');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=(value,label)=>{if(typeof value!=='string'||!value.trim()||value.length>100||/[\x00-\x1f\x7f]/.test(value))throw error(400,'Invalid '+label+'.');return value;};
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw error(400,'Unsupported allocation input.');return value;}
function balanceMap(bills){if(!Array.isArray(bills)||bills.length>10000)throw error(400,'Invalid bill selection.');const map=new Map();for(const row of bills){const key=id(row.id,'bill');if(map.has(key))throw error(400,'A bill may appear only once.');const balance=money(row.outstanding);if(balance.lt(0))throw error(409,'Bill balance requires reconciliation.');map.set(key,{...row,outstanding:balance});}return map;}
function entries(rows,key,eligible){if(!Array.isArray(rows)||rows.length>1000)throw error(400,'Invalid allocation list.');const seen=new Set();return rows.map(row=>{object(row,[key,'amount']);const value=id(row[key],key);if(seen.has(value))throw error(400,'Duplicate allocation target.');seen.add(value);if(!eligible.has(value))throw error(403,'Allocation target is unavailable or not authorized.');return{[key]:value,amount:money(row.amount,{positive:true}).toFixed(2)};});}
function planReceipt(input,context){
 object(input,['requestId','originalSaleId','amount','method','reference','shiftId','bills','tips']);
 if(!UUID.test(input.requestId||''))throw error(400,'A stable request UUID is required.');
 const originalSaleId=id(input.originalSaleId,'original sale'),received=money(input.amount,{positive:true});
 if(!['CASH','MPESA'].includes(input.method))throw error(400,'Unsupported payment method.');
 if(!Object.hasOwn(input,'shiftId')||(input.shiftId!==null&&(typeof input.shiftId!=='string'||!input.shiftId.trim()))||(input.method==='CASH'&&input.shiftId===null))throw error(400,'Choose an explicit receiving shift.');
 let reference=null,submittedReference=null;if(input.reference!==undefined){if(typeof input.reference!=='string'||input.reference.length>100||/[\x00-\x1f\x7f]/.test(input.reference))throw error(400,'Invalid payment reference.');submittedReference=input.reference;reference=input.method==='MPESA'?normalizeMpesaReference(input.reference):input.reference.trim()||null;}
 if(input.method==='MPESA'&&!isValidMpesaReference(reference))throw error(400,'Enter a valid M-Pesa reference.');
 const available=balanceMap(context.availableBills);if(!available.has(originalSaleId))throw error(403,'Original sale is unavailable or not authorized.');
 const recipients=context.eligibleEmployeeIds;if(!Array.isArray(recipients))throw error(400,'Explicit eligible recipients are required.');const eligible=new Set(recipients.map(x=>id(x,'recipient')));
 const bills=entries(input.bills||[],'saleId',available),tips=entries(input.tips||[],'employeeId',eligible);
 for(const allocation of bills)if(D(allocation.amount).gt(available.get(allocation.saleId).outstanding))throw error(409,'A bill allocation exceeds its current outstanding balance.');
 const allocatedToBills=bills.reduce((n,row)=>n.add(row.amount),D(0)),allocatedToTips=tips.reduce((n,row)=>n.add(row.amount),D(0)),unallocated=received.sub(allocatedToBills).sub(allocatedToTips);
 if(unallocated.lt(0))throw error(409,'Allocations exceed the received amount.');
 return{requestId:input.requestId.toLowerCase(),originalSaleId,method:input.method,reference,submittedReference,shiftId:input.shiftId,received:received.toFixed(2),bills,tips,allocatedToBills:allocatedToBills.toFixed(2),allocatedToTips:allocatedToTips.toFixed(2),unallocated:unallocated.toFixed(2),needsReconciliation:unallocated.gt(0)};
}
function planBillAllocation(amount,selectedBills,{order='EXPLICIT'}={}){
 const received=money(amount,{positive:true}),map=balanceMap(selectedBills);if(!['EXPLICIT','OLDEST_FIRST'].includes(order))throw error(400,'Choose an explicit allocation order.');
 const rows=[...map.values()];if(order==='OLDEST_FIRST'){for(const row of rows)if(typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))throw error(400,'Verified bill timestamps are required.');rows.sort((x,y)=>Date.parse(x.createdAt)-Date.parse(y.createdAt)||x.id.localeCompare(y.id));}
 let remaining=received;const allocations=[];for(const row of rows){if(remaining.isZero())break;const applied=row.outstanding.lte(remaining)?row.outstanding:remaining;if(applied.isZero())continue;allocations.push({saleId:row.id,amount:applied.toFixed(2)});remaining=remaining.sub(applied);}
 const totalOutstanding=rows.reduce((n,row)=>n.add(row.outstanding),D(0));return{order,selectedBillCount:rows.length,totalOutstanding:totalOutstanding.toFixed(2),allocations,allocated:received.sub(remaining).toFixed(2),unallocated:remaining.toFixed(2),remainingOutstanding:totalOutstanding.sub(received.sub(remaining)).toFixed(2)};
}
module.exports={planReceipt,planBillAllocation};
