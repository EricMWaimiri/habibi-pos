'use strict';
// Pure scheduling contract. No database/configuration writes or runtime activation.
const {isRealDate}=require('./accounting');
const fail=m=>Object.assign(Error(m),{status:409});
function date(value){if(typeof value!=='string'||!isRealDate(value))throw fail('Use a real business date.');return value;}
function minute(value){if(!Number.isInteger(value)||value<0||value>1439)throw fail('Invalid business-day start minute.');return value;}
function instant(day,value){return new Date(Date.parse(date(day)+'T00:00:00Z')-10800000+minute(value)*60000);}
function next(day){return new Date(Date.parse(date(day)+'T00:00:00Z')+86400000).toISOString().slice(0,10);}
function schedule({current,effectiveDate,startMinute=540,today,materializedDates=[]}){
 date(effectiveDate);date(today);minute(startMinute);
 if(effectiveDate<=today||current&&effectiveDate<=current.effective_date)throw fail('Select a future effective business date.');
 const previous=new Date(Date.parse(effectiveDate+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 if(materializedDates.some(d=>date(d)>=previous))throw fail('An adjacent immutable period already exists.');
 return {version:(current?.version||0)+1,previous_id:current?.id||null,effective_date:effectiveDate,start_minute:startMinute,timezone:'Africa/Nairobi'};
}
function period(day,policies){date(day);const sorted=[...policies].sort((a,b)=>a.effective_date.localeCompare(b.effective_date));const policy=sorted.filter(p=>p.effective_date<=day).at(-1);if(!policy)throw fail('No policy applies; preserve legacy calendar dates.');const tomorrow=next(day),following=sorted.find(p=>p.effective_date===tomorrow);return{businessDate:day,policyVersion:policy.version,start:instant(day,policy.start_minute),end:instant(tomorrow,following?.start_minute??policy.start_minute)};}
function assertActivation({activeShifts,now,periodStart}){if(activeShifts.some(s=>s.status==='OPEN'))throw fail('Close incompatible active shifts before policy activation.');if(new Date(now).getTime()<new Date(periodStart).getTime())throw fail('The policy is not effective yet.');}
module.exports={instant,schedule,period,assertActivation};
