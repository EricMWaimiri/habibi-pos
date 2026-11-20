'use strict';
// Pure draft calculation. Approval/posting and closed-period controls stay in the accounting service.
const {D,money,error}=require('./accounting-ledger');
const {calculateDraft}=require('./employee-payroll-draft');
const {isRealDate}=require('./accounting');
const Exact=D(0).constructor.clone({precision:80});
const decimal=v=>new Exact(v);
function segmentedDraft(revisions,employeeId,input){
 const {attendance,manualBasicAdjustment,...base}=input;
 // Reuse the existing validation without assigning an invented monthly salary.
 const validated=calculateDraft({...base,monthlyBasic:'0',missedDays:'0',bills:'0',advance:'0',deductions:'0'});
 const count=validated.calendarDays,prefix=String(input.year).padStart(4,'0')+'-'+String(input.month).padStart(2,'0')+'-';
 const rows=revisions.filter(r=>r.employeeId===employeeId).map(r=>({...r}));
 for(const r of rows){if(!isRealDate(r.effectiveDate)||!isRealDate(r.employmentStart)||r.employmentEnd&&!isRealDate(r.employmentEnd)||!Number.isInteger(r.revision))throw error(409,'Salary history is invalid; review before preparing payroll.');money(r.monthlyBasic);}
 const select=date=>rows.filter(r=>r.effectiveDate<=date).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate)||b.revision-a.revision)[0];
 const days=[];
 for(let n=1;n<=count;n++){
  const date=prefix+String(n).padStart(2,'0'),r=select(date);
  if(!r){if(rows.some(x=>x.employmentStart<=date&&(!x.employmentEnd||x.employmentEnd>=date)))throw error(409,'Salary history does not cover all employed days.');continue;}
  if(date<r.employmentStart||r.employmentEnd&&date>r.employmentEnd)continue;
  days.push({date,profile:r,unpaid:decimal(0)});
 }
 if(!days.length)throw error(409,'No eligible employment days in this payroll month.');
 const latest=days[days.length-1].profile;
 if(base.monthlyBasic!==undefined&&!D(base.monthlyBasic).eq(latest.monthlyBasic))throw error(409,'Salary differs from the effective profile; refresh the salary history.');
 let missed;try{missed=decimal(base.missedDays);}catch{throw error(400,'Enter valid missed days.');}
 if(!missed.isFinite()||missed.lt(0)||missed.decimalPlaces()>4||missed.gt(days.length))throw error(400,'Missed days exceed eligible employment days.');
 const byDate=new Map(days.map(d=>[d.date,d])),seen=new Set();
 if(attendance!==undefined){
  if(!Array.isArray(attendance)||attendance.length>count)throw error(400,'Invalid dated attendance.');
  for(const entry of attendance){
   if(!entry||Object.keys(entry).some(k=>!['date','kind','fraction'].includes(k))||!isRealDate(entry.date)||!['MISSED','UNPAID_LEAVE','PAID_LEAVE'].includes(entry.kind)||seen.has(entry.date)||!byDate.has(entry.date))throw error(400,'Attendance dates must be unique, eligible and within the payroll month.');
   let fraction;try{fraction=decimal(entry.fraction);}catch{throw error(400,'Invalid attendance fraction.');}
   if(!fraction.isFinite()||fraction.lte(0)||fraction.gt(1)||fraction.decimalPlaces()>4)throw error(400,'Attendance fractions must be greater than zero and at most one day.');
   seen.add(entry.date);if(entry.kind!=='PAID_LEAVE')byDate.get(entry.date).unpaid=fraction;
  }
  const total=days.reduce((s,d)=>s.add(d.unpaid),decimal(0));
  if(!total.eq(missed))throw error(400,'Missed days must equal dated unpaid leave and missed days; do not deduct them twice.');
 }else if(missed.gt(0)){
  if(new Set(days.map(d=>d.profile.id||d.profile.revision)).size!==1||days.length!==count)throw error(400,'Date unpaid leave and missed days for a segmented or partial employment month.');
  // A full month at one rate preserves the accepted aggregate-days workflow.
  let remaining=missed;for(const day of days){day.unpaid=Exact.min(remaining,1);remaining=remaining.sub(day.unpaid);}
 }
 const groups=[];let numerator=decimal(0),payable=decimal(0);
 for(const d of days){
  let g=groups[groups.length-1];if(!g||g.revision!==d.profile.revision){g={profileId:d.profile.id||null,revision:d.profile.revision,from:d.date,to:d.date,monthlyBasic:money(d.profile.monthlyBasic).toFixed(2),eligibleDays:0,payableDays:decimal(0)};groups.push(g);}
  g.to=d.date;g.eligibleDays++;const paid=decimal(1).sub(d.unpaid);g.payableDays=g.payableDays.add(paid);payable=payable.add(paid);numerator=numerator.add(decimal(g.monthlyBasic).mul(paid));
 }
 const raw=numerator.div(count),original=raw.toDecimalPlaces(2,4);let adjustment=decimal(0);
 if(manualBasicAdjustment!==undefined){
  if(!manualBasicAdjustment||Object.keys(manualBasicAdjustment).some(k=>!['amount','reason'].includes(k))||typeof manualBasicAdjustment.reason!=='string'||manualBasicAdjustment.reason.trim().length<3||manualBasicAdjustment.reason.length>200)throw error(400,'A reviewed manual salary adjustment requires a reason.');
  adjustment=decimal(money(manualBasicAdjustment.amount).toFixed(2));
 }
 const basic=raw.add(adjustment).toDecimalPlaces(2,4);if(basic.lt(0))throw error(409,'Manual adjustment cannot make basic salary negative.');
 const calculation=calculateDraft({...base,monthlyBasic:basic.toFixed(2),missedDays:'0'});
 Object.assign(calculation,{monthlyBasic:money(latest.monthlyBasic).toFixed(2),calendarDays:count,missedDays:missed.toString(),payableDays:payable.toString(),unroundedBasic:raw.toString(),originalCalculatedBasic:original.toFixed(2),manualBasicAdjustment:adjustment.toFixed(2),salaryBasis:'DAILY_EFFECTIVE_SEGMENTS',segments:groups.map(g=>({...g,payableDays:g.payableDays.toString(),unroundedSalary:decimal(g.monthlyBasic).mul(g.payableDays).div(count).toString()}))});
 return {calculation,salaryProfileSnapshot:{version:2,basis:'DAILY_EFFECTIVE_SEGMENTS',profiles:JSON.parse(JSON.stringify(groups.map(g=>({...rows.find(r=>r.revision===g.revision)})))),attendance:attendance===undefined?null:attendance.map(x=>({...x})),manualBasicAdjustment:manualBasicAdjustment?{...manualBasicAdjustment,reason:manualBasicAdjustment.reason.trim()}:null}};
}
function compatibleWithCurrentStorage(c){return D(c.payableDays).eq(D(c.calendarDays).sub(c.missedDays))&&D(c.basic).eq(D(c.monthlyBasic).mul(c.payableDays).div(c.calendarDays).toDecimalPlaces(2,4));}
module.exports={segmentedDraft,compatibleWithCurrentStorage};
