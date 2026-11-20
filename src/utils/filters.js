'use strict';
const { isRealDate, nairobiDayBounds } = require('./accounting');
const bad = message => Object.assign(new Error(message), { status: 400 });
function filters(query = {}, { statuses = [], today } = {}) {
  const text = key => {
    const value = query[key];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || value.length > (key === 'q' ? 100 : 100)) throw bad('Invalid ' + key);
    return value.trim() || undefined;
  };
  const f = {};
  for (const key of ['date','start','end','shiftId','staffId','q','status','method','productId','type','balances']) f[key] = text(key);
  if (f.date && (f.start || f.end)) throw bad('Choose a single date or a date range');
  if (Boolean(f.start) !== Boolean(f.end)) throw bad('Both range dates are required');
  if (!f.date && !f.start && today) f.date = today;
  if (f.date || f.start) {
    const start = f.date || f.start, end = f.date || f.end;
    if (!isRealDate(start) || !isRealDate(end) || end < start) throw bad('Invalid Nairobi date range');
    f.calendarRange={gte:nairobiDayBounds(start).start,lt:nairobiDayBounds(end).end};
    const business=require('./business-day-context');f.range={gte:business.bounds(start).start,lt:business.bounds(end).end};
    if (+f.range.lt - +f.range.gte > 366 * 86400000) throw bad('Choose a period of one year or less');
    f.first = start; f.last = end;
  }
  if (f.status && !statuses.includes(f.status)) throw bad('Invalid status');
  if (f.method && !['CASH','MPESA'].includes(f.method)) throw bad('Invalid payment method');
  if (f.balances && !['cutoff','current'].includes(f.balances)) throw bad('Invalid balance view');
  const integer = (key, fallback, max) => {
    const v = text(key); if (v === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > max) throw bad('Invalid ' + key);
    return Number(v);
  };
  f.page = integer('page', 1, 1000000); f.pageSize = integer('pageSize', 200, 200);
  return f;
}
const id = value => value === 'unassigned' ? null : value;
const contains = value => ({ contains: value, mode: 'insensitive' });
const and = (...parts) => ({ AND: parts.filter(p => p && Object.keys(p).length) });
function salePeriod(f) {
  return f.range ? { OR: [
    { accountingDate: { gte: new Date(f.first+'T00:00:00Z'), lte: new Date(f.last+'T00:00:00Z') } },
    { accountingDate: null, createdAt: f.range },
  ] } : {};
}
function saleScope(f) {
  return and(salePeriod(f), f.shiftId ? {shiftId:id(f.shiftId)} : {}, f.staffId ? {waiterId:id(f.staffId)} : {},
    f.q ? { OR: [{saleNumber:contains(f.q)}, {notes:contains(f.q)}, {waiter:{name:contains(f.q)}}] } : {});
}
function eventScope(f, shift = 'shiftId', staff = 'recordedById') {
  return { ...require('./business-day-context').eventScope(f,shift), ...(f.shiftId ? {[shift]:id(f.shiftId)}:{}), ...(f.staffId ? {[staff]:id(f.staffId)}:{}), ...(f.method ? {method:f.method}:{}) };
}
async function page(db, model, args, f) {
  const rows = await db[model].findMany({ ...args, skip:(f.page-1)*f.pageSize, take:f.pageSize });
  const total = await db[model].count({where:args.where});
  return { rows, pagination:{page:f.page,pageSize:f.pageSize,total,pages:Math.ceil(total/f.pageSize)} };
}
module.exports = {filters,id,contains,and,salePeriod,saleScope,eventScope,page};
