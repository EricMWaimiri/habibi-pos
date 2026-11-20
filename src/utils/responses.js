'use strict';

// Public JSON contracts only. Never use these projections for accounting,
// stock verification or printer input. Unknown model fields default to private.
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const has = (permissions, key) => Array.isArray(permissions) && permissions.includes(key);
const identity = user => user == null ? user : pick(user, ['id', 'name', 'role', 'isActive', 'createdAt']);
const staff = user => pick(user, ['id', 'name', 'role', 'isActive', 'createdAt', 'commissionRate']);
const payment = row => pick(row, ['id', 'saleId', 'method', 'amount', 'reference', 'receivedById', 'receivedShiftId', 'createdAt']);

function sale(row, permissions) {
  const result = pick(row, ['id', 'saleNumber', 'status', 'subtotal', 'discount', 'total', 'amountPaid', 'balance', 'notes', 'mergedIntoId', 'splitFromId', 'accountingDate', 'waiterId', 'cashierId', 'createdById', 'shiftId', 'createdAt', 'updatedAt']);
  if(row.financialAdjustments){const {Decimal}=require('@prisma/client').Prisma;const returned=row.financialAdjustments.filter(a=>a.kind==='RETURN').reduce((n,a)=>n.sub(a.salesDelta),new Decimal(0));result.returnedAmount=returned;result.pricingDelta=row.financialAdjustments.filter(a=>['SALE_DISCOUNT','SALE_PRICE_CHANGE'].includes(a.kind)).reduce((n,a)=>n.add(a.salesDelta),new Decimal(0));result.netTotal=new Decimal(row.total).add(row.financialAdjustments.reduce((n,a)=>n.add(a.salesDelta),new Decimal(0)));}
  if (row.items) result.items = row.items.filter(item => !item.removedAt).map(item => ({
    ...pick(item, ['id', 'productId', 'quantity', 'unitPrice', 'discount', 'subtotal']),
    ...(item.product ? { product: pick(item.product, ['id', 'name']) } : {}),
  }));
  if (Object.hasOwn(row, 'waiter')) result.waiter = row.waiter == null ? row.waiter : pick(row.waiter, ['id', 'name']);
  if (Object.hasOwn(row, 'docket')) result.docket = row.docket == null ? row.docket : pick(row.docket, ['id', 'saleId', 'status', 'createdAt', 'updatedAt']);
  if (has(permissions, 'payments.view_collected') && row.payments) result.payments = row.payments.map(payment);
  if (has(permissions, 'commissions.manage')) Object.assign(result, pick(row, ['commissionRateSnapshot', 'commissionAmount', 'commissionEarnedAt', 'commissionCapSnapshot']));
  return result;
}

function stock(row, permissions) {
  const result = pick(row, ['id', 'name', 'type', 'unitOfMeasure', 'quantity', 'price']);
  if (Object.hasOwn(row, 'category')) result.category = row.category == null ? row.category : pick(row.category, ['name']);
  if (has(permissions, 'reports.financial')) Object.assign(result, pick(row, ['cost']));
  return result;
}

function daily(row, permissions) {
  const financial = has(permissions, 'reports.financial');
  const collections = has(permissions, 'payments.view_collected');
  const result = pick(row, ['date', 'period', 'balanceView', 'cutoffExclusive', 'outstanding']);
  result.orders = pick(row.orders, ['total', 'paid', 'partial', 'unpaid']);
  result.totals = pick(row.totals, ['sales', 'paid', 'outstanding', ...(financial ? ['cost', 'profit'] : [])]);
  result.waiters = row.waiters.map(w => pick(w, ['userId', 'name', 'orders', 'total', 'paid', ...(financial ? ['cost', 'profit'] : [])]));
  result.provenance = pick(row.provenance, ['unverifiedSales', 'unverifiedOutstandingBills', ...(collections ? ['inconsistentReceiptCount'] : [])]);
  if (collections) {
    result.payments = pick(row.payments, ['CASH', 'MPESA']);
    result.unassignedMpesa = row.unassignedMpesa;
    result.collectionShifts = row.collectionShifts.map(s => pick(s, ['shiftId', 'CASH', 'MPESA']));
  }
  return result;
}

const eventDetails = {
  START: ['minutes', 'reclaimedSessionIds'], PHYSICAL_READY: ['confirmation'],
  EXTEND: ['previousExpiry', 'expiresAt', 'minutes'],
};
function countEvent(event) {
  const result = pick(event, ['id', 'stockCountId', 'userId', 'action', 'createdAt']);
  const details = {};
  for (const key of eventDetails[event.action] || []) {
    const value = event.details?.[key];
    if (key === 'reclaimedSessionIds' && Array.isArray(value)) details[key] = value.filter(id => typeof id === 'string');
    else if (key === 'minutes' && typeof value === 'number' && Number.isFinite(value)) details[key] = value;
    else if (key !== 'minutes' && key !== 'reclaimedSessionIds' && typeof value === 'string') details[key] = value;
  }
  if (Object.keys(details).length) result.details = details;
  return result;
}
function count(row) {
  const result = pick(row, ['id', 'status', 'notes', 'countedById', 'createdAt', 'completedAt', 'baselineAt', 'readyAt', 'expiresAt', 'submittedAt', 'submittedById', 'approvedById', 'stockApplied']);
  if (Object.hasOwn(row, 'countedBy')) result.countedBy = row.countedBy == null ? row.countedBy : pick(row.countedBy, ['name']);
  if (row.items) result.items = row.items.map(item => ({
    ...pick(item, ['id', 'stockCountId', 'productId', 'systemQty', 'countedQty', 'difference']),
    ...(item.product ? { product: pick(item.product, ['name', 'unitOfMeasure']) } : {}),
  }));
  if (row.events) result.events = row.events.map(countEvent);
  return result;
}

const expense = row => ({
  ...pick(row, ['id', 'expenseNumber', 'amount', 'category', 'description', 'method', 'recordedById', 'shiftId', 'createdAt', 'updatedAt']),
  ...(row.recordedBy ? { recordedBy: pick(row.recordedBy, ['name']) } : {}),
  ...(Object.hasOwn(row, 'shift') ? { shift: row.shift == null ? row.shift : pick(row.shift, ['id']) } : {}),
});
const shift = row => row == null ? row : ({
  ...pick(row, ['id', 'name', 'status', 'openingCash', 'closingCash', 'expectedCash', 'notes', 'openedById', 'closedById', 'openedAt', 'closedAt']),
  ...(row.openedBy ? { openedBy: identity(row.openedBy) } : {}),
  ...(Object.hasOwn(row, 'closedBy') ? { closedBy: identity(row.closedBy) } : {}),
});

module.exports = { identity, staff, sale, stock, daily, count, expense, shift, payment };
