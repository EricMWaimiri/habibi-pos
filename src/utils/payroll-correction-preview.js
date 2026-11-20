'use strict';
// Review arithmetic only. Does not query, authorize posting, write, or reserve funds.
// Feed this verified, locked server-side ledger facts, never request-provided balances.
const {D,money,error}=require('./accounting-ledger'),{canonical}=require('./accounting-receipts'),{isRealDate}=require('./accounting'),{createHash}=require('crypto');
const fields=['expense','tips','bills','advances','otherDeductions'];
function correctionPreview(ctx,before,target,accountingDate){
 if(ctx?.actor?.role!=='MANAGER'||!['payroll.view','payroll.manage','accounting.correct'].every(k=>ctx.permissions?.includes(k)))throw error(403,'Payroll correction preview permission denied.');
 if(!before||typeof before.rootId!=='string'||!before.rootId||!Number.isInteger(before.version)||before.version<0||typeof before.closed!=='boolean'||!isRealDate(accountingDate))throw error(409,'Verified payroll facts and an open posting date are required.');
 if(before.employeeId===ctx.actor.id)throw error(403,'A different manager must prepare your payroll correction.');
 if(before.closed)throw error(409,'Posting date is closed; choose a separately authorized open date.');
 const old={},next={};for(const key of fields){old[key]=money(before[key]);next[key]=money(target[key]);if(old[key].lt(0)||next[key].lt(0))throw error(400,'Correction target components must be nonnegative.');}
 const required=[];if(!next.bills.eq(old.bills))required.push('receivables.correct','payroll.confirm');if(!next.advances.eq(old.advances))required.push('employee_advances.manage','payroll.confirm');if(!next.tips.eq(old.tips))required.push('tips.allocate');if(required.some(k=>!ctx.permissions.includes(k)))throw error(403,'Correction includes an ungranted recovery or tip action.');
 const net=x=>x.expense.add(x.tips).sub(x.bills).sub(x.advances).sub(x.otherDeductions);
 if(net(next).lt(0))throw error(409,'Correct the selected recoveries; target deductions exceed earnings.');
 const liability=money(before.liability),claim=money(before.overpaymentOutstanding),paid=money(before.actualPaid),recovered=money(before.overpaymentRecovered);
 if([liability,claim,paid,recovered].some(v=>v.lt(0))||!liability.sub(claim).eq(net(old).sub(paid).add(recovered)))throw error(409,'Payroll liabilities, payouts and overpayment recoveries do not reconcile.');
 const delta=net(next).sub(net(old)),position=liability.sub(claim).add(delta),afterLiability=D(0).constructor.max(position,0),afterClaim=D(0).constructor.max(position.neg(),0),claimChange=afterClaim.sub(claim);
 const effects={operatingExpense:next.expense.sub(old.expense),salaryLiability:afterLiability.sub(liability),billReceivable:old.bills.sub(next.bills),advanceAsset:old.advances.sub(next.advances),tipLiability:old.tips.sub(next.tips),otherRecoveryLiability:next.otherDeductions.sub(old.otherDeductions),overpaymentAsset:claimChange,cash:D(0)};
 if(!effects.operatingExpense.add(effects.billReceivable).add(effects.advanceAsset).add(effects.overpaymentAsset).eq(effects.salaryLiability.add(effects.tipLiability).add(effects.otherRecoveryLiability)))throw error(409,'Correction preview does not balance.');
 const data={rootId:before.rootId,employeeId:before.employeeId,expectedVersion:before.version,accountingDate,before:Object.fromEntries(fields.map(k=>[k,old[k].toFixed(2)])),target:Object.fromEntries(fields.map(k=>[k,next[k].toFixed(2)])),effects:Object.fromEntries(Object.entries(effects).map(([k,v])=>[k,v.toFixed(2)])),afterLiability:afterLiability.toFixed(2),afterOverpaymentOutstanding:afterClaim.toFixed(2),actualPaidPreserved:paid.toFixed(2),sourceFingerprint:before.sourceFingerprint||null,requiresIndependentApproval:true,automaticFutureRecovery:false,statutoryApplied:false};
 return {...data,fingerprint:createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex')};
}
module.exports={correctionPreview};
