'use strict';
const { Prisma } = require('@prisma/client');
const { lockOpenShift } = require('./shift-transactions');
const error = message => Object.assign(new Error(message), { status: 409 });
const DAY_MS = 86400000;
const nairobiDate = instant => new Date(new Date(instant).getTime() + 10800000).toISOString().slice(0, 10);
const isRealDate = str => /^\d{4}-\d{2}-\d{2}$/.test(str) && !Number.isNaN(Date.parse(str + 'T00:00:00Z')) && new Date(str + 'T00:00:00Z').toISOString().slice(0, 10) === str;
function nairobiDayBounds(str) {
  if (!isRealDate(str)) throw Object.assign(new Error('Invalid date'), { status: 400 });
  const start = new Date(Date.parse(str + 'T00:00:00Z') - 10800000);
  return { start, end: new Date(+start + DAY_MS) };
}
// Explicit UTC conversion: Prisma timestamps have no timezone; clock_timestamp
// is sampled AFTER the required locks, rather than transaction-start now().
async function databaseInstant(tx) {
  const [row] = await tx.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS instant`;
  return row.instant;
}
function snapshot(sale) {
  return JSON.parse(JSON.stringify(sale));
}
async function audit(tx, saleId, actorId, action, before, details = {}, reason = null) {
  const after = await tx.sale.findUnique({ where: { id: saleId }, include: { items: true } });
  const instant = await databaseInstant(tx);
  if (['ADD_ITEMS','REMOVE_ITEM','CANCEL','MERGE','MERGED_INTO'].includes(action) && after.accountingDate?.toISOString().slice(0,10) !== await require('./business-day-runtime').dateForShift(tx,instant,after.shiftId)) {
    throw error('The Nairobi accounting date changed while waiting. No changes were committed.');
  }
  await tx.saleAccountingEvent.create({ data: { saleId, actorId, action, reason,
    createdAt: instant, details: { before: snapshot(before), after: snapshot(after), ...details } } });
}
async function verifyDebt(tx, sale) {
  const current = await require('./financial-ledger').ledger(tx,sale);
  const payments = current.payments;
  const paid = current.paid;
  const items = await tx.saleItem.findMany({ where: { saleId: sale.id, removedAt: null } });
  const subtotal = items.reduce((sum, i) => sum.add(i.subtotal), new Prisma.Decimal(0));
  if (!paid.eq(sale.amountPaid) || !current.balance.eq(sale.balance) ||
      !subtotal.eq(sale.subtotal) || !subtotal.sub(sale.discount).eq(sale.total) || sale.total.lt(0) || sale.balance.lt(0)) {
    throw error('Bill amounts cannot be verified. Manual review is required.');
  }
  const sources = await tx.sale.count({ where: { mergedIntoId: sale.id } });
  if (sources && !await tx.saleAccountingEvent.count({ where: { saleId: sale.id, action: 'MERGE' } })) {
    throw error('Historical merged bill attribution cannot be verified. Manual review is required.');
  }
  return { items, payments };
}
async function verifyStockHistory(tx, items, currentSaleId) {
  for (const item of items) {
    if (!Number.isInteger(item.stockDeductionCount) || item.stockDeductionCount < 0) throw error('Original stock history cannot be verified. Manual review is required.');
    const all = await tx.stockMovement.findMany({ where: { saleItemId: item.id }, include: { reversal: true,returnPortion:{include:{originalMovement:true}} } });
    const moves=all.filter(m=>m.type==='SALE'&&m.quantityChange.lt(0)&&!m.reversalOfId);
    if(all.some(m=>!moves.includes(m)&&!(m.type==='CORRECTION'&&m.returnPortion&&m.quantityChange.eq(m.returnPortion.quantity)&&m.returnPortion.originalMovement.productId===m.productId&&m.returnPortion.originalMovement.saleItemId===item.id)))throw error('Stock restoration history is ambiguous. Manual review is required.');
    if (moves.length !== item.stockDeductionCount || moves.some(m => m.type !== 'SALE' || !m.saleId || m.reversalOfId || m.reversal || !m.quantityChange.lt(0) || !m.previousQty.add(m.quantityChange).eq(m.quantityAfter))) {
      throw error('Original stock history cannot be verified. Manual review is required.');
    }
    for (const movement of moves) {
      if(item.stockOriginSaleId){
        if(movement.saleId!==item.stockOriginSaleId)throw error('Immutable stock origin does not match original deductions. Manual review required.');
        continue;
      }
      let sourceId = movement.saleId;
      const visited = new Set();
      while (sourceId !== currentSaleId) {
        if (visited.has(sourceId)) throw error('Stock origin lineage is ambiguous. Manual review is required.');
        visited.add(sourceId);
        const source = await tx.sale.findUnique({ where: { id: sourceId } });
        if (!source || source.status !== 'MERGED' || !source.mergedIntoId) throw error('Stock origin lineage cannot be verified. Manual review is required.');
        const evidence = await tx.saleAccountingEvent.findFirst({ where: { saleId: sourceId, action: 'MERGED_INTO', details: { path: ['targetId'], equals: source.mergedIntoId } } });
        if (!evidence) throw error('Historical stock merge lineage requires manual review.');
        sourceId = source.mergedIntoId;
      }
    }
  }
}
// Discovery takes no row locks. Lock ONE origin owner/shift before sorted sales.
// No caller may already hold a sale or product lock when entering this helper.
async function lockMutableSales(tx, ids, actor, permissions, merge = false, allowPricedAdditions = false) {
  const initial = await tx.sale.findMany({ where: { id: { in: ids } } });
  if (initial.length !== ids.length) throw Object.assign(new Error('Order not found'), { status: 404 });
  for (const s of initial) if (!permissions.includes('sales.view_all') && s.waiterId !== actor.id && s.createdById !== actor.id) {
    throw Object.assign(new Error('Not your order'), { status: 403 });
  }
  const origin = initial[0].shiftId;
  if (initial.some(s => s.shiftId !== origin) || (merge && !origin)) throw error('Merge requires the same assigned open originating shift.');
  if (origin) {
    const shift = await tx.shift.findUnique({ where: { id: origin } });
    if (!shift) throw error('Originating shift cannot be verified. Manual review is required.');
    await lockOpenShift(tx, shift.openedById, origin, 'CASH');
  }
  await tx.$queryRaw`SELECT id FROM sales WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
  const sales = await tx.sale.findMany({ where: { id: { in: ids } }, orderBy: [{ createdAt: 'asc' }, { saleNumber: 'asc' }], include: { items: true } });
  return validateMutableSales(tx,sales,origin,merge,allowPricedAdditions);
}
// Validation only: caller must already hold the origin owner/shift and sale locks.
async function validateMutableSales(tx,sales,origin,merge=false,allowPricedAdditions=false) {
  const date = await require('./business-day-runtime').dateForShift(tx,await databaseInstant(tx),origin);
  for (const sale of sales) {
    if (sale.shiftId !== origin || !sale.accountingDate || await require('./business-day-runtime').dateForShift(tx,sale.createdAt,sale.shiftId,{allowClosedPeriod:true}) !== sale.accountingDate.toISOString().slice(0, 10) || sale.accountingDate.toISOString().slice(0, 10) !== date || sale.commissionRateSnapshot === null) {
      throw error('This bill is outside the current verified accounting date. Manual review is required.');
    }
    if (sale.status === 'CANCELLED') throw error('This order is already cancelled; only an unpaid order can be changed.');
    if (sale.status === 'MERGED') throw error('This order was merged into another bill; only an unpaid order can be changed.');
    if (sale.status !== 'UNPAID' || !sale.amountPaid.isZero() || sale.commissionEarnedAt !== null) throw error('Only an unpaid order without payments can be changed.');
    if(!allowPricedAdditions&&await tx.financialAdjustment.count({where:{saleId:sale.id,kind:{in:['SALE_DISCOUNT','SALE_PRICE_CHANGE']}}}))throw error('This bill has audited pricing corrections. Use a new bill for additional items or the financial correction workflow.');
    const { items, payments } = await verifyDebt(tx, sale);
    if (payments.length) throw error('Bills with recorded payments cannot be changed.');
    await verifyStockHistory(tx, items, sale.id);
    if (merge && (sale.waiterId !== sales[0].waiterId || !sale.commissionRateSnapshot.eq(sales[0].commissionRateSnapshot))) throw error('Merge requires the same employee and captured commission rate.');
  }
  return sales;
}
module.exports = { nairobiDate, isRealDate, nairobiDayBounds, databaseInstant, audit, verifyDebt, verifyStockHistory, lockMutableSales, validateMutableSales };
