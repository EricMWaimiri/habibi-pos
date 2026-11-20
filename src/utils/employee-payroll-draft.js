'use strict';
// Draft arithmetic only: approval, legal deduction limits and posting are separate guards.
const {money,D,error}=require('./accounting-ledger');
function calculateDraft(input){
 const allowed=['monthlyBasic','year','month','missedDays','commission','tips','bills','advance','deductions','additional'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw error(400,'Unsupported payroll input.');
 if(!Number.isInteger(input.year)||input.year<1900||input.year>9999||!Number.isInteger(input.month)||input.month<1||input.month>12)throw error(400,'Choose a valid payroll year and month.');
 const leap=input.year%4===0&&(input.year%100!==0||input.year%400===0);
 const calendarDays=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][input.month-1];
 if(typeof input.missedDays!=='string'&&typeof input.missedDays!=='number')throw error(400,'Approved missed days are required.');
 let missed;try{missed=D(input.missedDays);}catch{throw error(400,'Enter valid missed days.');}const divisor=D(calendarDays);
 if(!missed.isFinite()||missed.decimalPlaces()>4||missed.lt(0)||missed.gt(divisor))throw error(400,'Missed days must be within the payroll month.');
 const days=divisor.sub(missed);
 const amounts={};for(const k of ['monthlyBasic','commission','tips','bills','advance','deductions','additional']){amounts[k]=money(input[k]);if(amounts[k].lt(0))throw error(400,'Payroll components must be nonnegative.');}
 const unroundedBasic=amounts.monthlyBasic.mul(days).div(divisor);
 const basic=unroundedBasic.toDecimalPlaces(2,4);
 const earnings=basic.add(amounts.commission).add(amounts.tips).add(amounts.additional);
 const deductions=amounts.bills.add(amounts.advance).add(amounts.deductions),net=earnings.sub(deductions);
 if(net.lt(0))throw error(409,'Selected deductions exceed earnings; review partial recovery.');
 for(const value of [basic,earnings,deductions,net])money(value.toFixed(2));
 return{basic:basic.toFixed(2),earnings:earnings.toFixed(2),totalDeductions:deductions.toFixed(2),net:net.toFixed(2),year:input.year,month:input.month,calendarDays,missedDays:missed.toString(),payableDays:days.toString(),monthlyBasic:amounts.monthlyBasic.toFixed(2),unroundedBasic:unroundedBasic.toString(),rounding:'HALF_UP_2DP',statutoryAdjustmentsApplied:false,status:'DRAFT',financialApproval:false};
}
module.exports={calculateDraft};
