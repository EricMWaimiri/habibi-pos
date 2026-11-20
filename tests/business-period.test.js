'use strict';
const test=require('node:test'),a=require('node:assert/strict'),B=require('../src/utils/business-period');
test('prospective 09:00 Nairobi boundary uses preceding business date before 09:00',()=>{a.equal(B.bounds('2026-11-18T05:59:59.999Z',540).date,'2026-11-17');a.equal(B.bounds('2026-11-18T06:00:00.000Z',540).date,'2026-11-18');});
test('month/year/leap boundaries are exact 24-hour half-open intervals',()=>{for(const [time,date]of [['2027-01-01T05:59:59Z','2026-12-31'],['2028-03-01T05:59:59Z','2028-02-29'],['2027-03-01T05:59:59Z','2027-02-28']]){const p=B.bounds(time,540);a.equal(p.date,date);a.equal(p.end-p.start,86400000);a.equal(B.bounds(p.end,540).start.getTime(),p.end.getTime());}});
test('historical shifts without a snapshot preserve existing Nairobi midnight semantics',()=>{a.equal(B.forShift('2026-11-18T05:00:00Z',null).date,'2026-11-18');a.equal(B.forShift('2026-11-18T05:00:00Z',{businessDayStartMinute:540}).date,'2026-11-17');});
test('invalid boundary or timestamp fails closed',()=>{for(const v of[-1,1440,1.5,'540'])a.throws(()=>B.bounds(new Date(),v),e=>e.status===400);a.throws(()=>B.bounds('bad date',540),e=>e.status===400);});
