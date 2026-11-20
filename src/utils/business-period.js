'use strict';
// Pure calculation for prospective, persisted shift snapshots. NOT wired into
// existing accounting dates: legacy snapshots must continue to use midnight.
const DAY=86400000,NAIROBI_OFFSET=10800000;
function bounds(instant,startMinute){const time=new Date(instant).getTime();if(!Number.isFinite(time)||!Number.isInteger(startMinute)||startMinute<0||startMinute>=1440)throw Object.assign(Error('Invalid business-day instant or boundary.'),{status:400});const date=new Date(time+NAIROBI_OFFSET-startMinute*60000).toISOString().slice(0,10),start=new Date(Date.parse(date+'T00:00:00Z')-NAIROBI_OFFSET+startMinute*60000);return{date,start,end:new Date(start.getTime()+DAY),timezone:'Africa/Nairobi',startMinute};}
function forShift(instant,snapshot){return bounds(instant,snapshot?.businessDayStartMinute??0);}
module.exports={bounds,forShift};
