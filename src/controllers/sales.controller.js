const receipts = require('../utils/mutation-receipts');
const response = require('../utils/responses');
const { printOrder } = require('../utils/print');
const prisma = require('../config/prisma');
const { Prisma } = require('@prisma/client');
const { z } = require('zod');
const { deductStockForItems, restoreStockForItems } = require('../utils/stock');
const { getPermissionsForUser } = require('../utils/permissions');
const { assertCurrentSession } = require('../utils/session-version');
const { MPESA_REFERENCE_SQL, normalizeMpesaReference, isValidMpesaReference } = require('../utils/payment-reference');
const { SHIFT_CONTEXT_SCHEMA, withShiftTransaction, lockOpenShift } = require('../utils/shift-transactions');

const { databaseInstant, nairobiDate, nairobiDayBounds, audit, verifyDebt, lockMutableSales } = require('../utils/accounting');

// ---------- helpers ----------
const round2 = (n) => Math.round(n * 100) / 100;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// What we send back for an order. NOTE: no unitCost (cost price stays private)
const saleInclude = {
  items: {
    where: { removedAt: null },
    select: {
      id: true,
      productId: true,
      operationalLocation: true,
      quantity: true,
      unitPrice: true,
      discount: true,
      subtotal: true,
      product: { select: { id: true, name: true } },
    },
  },
  payments: true,
  financialAdjustments: true,
  docket: true,
  waiter: { select: { id: true, name: true } },
};

const loadSale = (id) => prisma.sale.findUnique({ where: { id }, include: saleInclude });

// Optional output has its own fresh admission after commit. Do not reuse the
// sale request's grants or role: credentials/role/grants may have changed while
// it waited for financial locks. Failure suppresses receipt, never the docket.
const receiptAuthorization = req => async () => {
  const actor = await assertCurrentSession(prisma, req.auth);
  return (await getPermissionsForUser(actor)).includes('receipt.print');
};

// Lock one order row until the transaction ends, so two actions cannot clash
const lockSale = (tx, id) => tx.$queryRaw`SELECT id FROM sales WHERE id = ${id} FOR UPDATE`;

const TX_OPTIONS = { timeout: 15000, isolationLevel: 'ReadCommitted' };

// Turn [{productId, quantity}] into order lines, using the REAL price from the database
async function buildLines(tx, items) {
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = await tx.product.findMany({
    where: { id: { in: ids } },
    include: { components: { where: { quantity: { gt: 0 } }, include: { componentProduct: { select: { cost: true } } } } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  return items.map((item) => {
    const product = byId.get(item.productId);
    if (!product || !product.isActive) throw httpError(400, 'Unknown or inactive product');
    const price = Number(product.price);
    if (price <= 0) throw httpError(400, `${product.name} is not for sale`);

    // Cost snapshot for profit reports. Recipe items: worked out from the ingredients NOW.
    let unitCost = Number(product.cost);
    if (product.type === 'composite' && product.components.length > 0) {
      unitCost = product.components.reduce(
        (sum, c) => sum + Number(c.quantity) * Number(c.componentProduct.cost),
        0
      );
    }

    return {
      productId: product.id,
      operationalLocation: product.operationalLocation ?? null,
      returnEligible: product.returnsAllowed === true && !(process.env.NON_RETURNABLE_PRODUCT_CODES||'').split(',').map(s=>s.trim()).filter(Boolean).includes(product.productCode),
      quantity: item.quantity,
      unitPrice: price,
      unitCost: round2(unitCost),
      subtotal: round2(price * item.quantity),
    };
  });
}

// Recalculate subtotal / total / balance from the order's items
async function recalcTotals(tx, saleId, capOverride) {
  const sale = await tx.sale.findUnique({ where: { id: saleId }, include: { items: { where: { removedAt: null } } } });
  const subtotal = round2(sale.items.reduce((sum, i) => sum + Number(i.subtotal), 0));
  const total = round2(subtotal - Number(sale.discount));
  if (total < 0) throw httpError(409, 'The remaining items cannot cover the recorded discount. No changes were made.');
  const pricing=await tx.financialAdjustment.aggregate({where:{saleId,kind:{in:['SALE_DISCOUNT','SALE_PRICE_CHANGE']}},_sum:{salesDelta:true}});
  const balance = round2(total + Number(pricing._sum.salesDelta||0) - Number(sale.amountPaid));
  await tx.sale.update({ where: { id: saleId }, data: { subtotal, total, balance, ...((sale.commissionCapSnapshot!=null||capOverride!==undefined)?{commissionCapSnapshot:capOverride!==undefined?capOverride:require('../utils/commission-snapshot').resized(sale,total)}:{}) } });
}

// ---------- validation ----------
const ITEM = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(999),
});

const ID_PARAMS = z.object({ id: z.string().min(1) });

const CREATE_SALE_SCHEMA = z.object({
  body: z.object({
    shiftId: SHIFT_CONTEXT_SCHEMA,
    items: z.array(ITEM).min(1).max(50),
    notes: z.string().max(300).optional(),
    waiterId: z.string().min(1).optional(), // only used by users with sales.view_all
  }),
});

const LIST_SALES_SCHEMA = z.object({
  query: z.object({
    status: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'CANCELLED', 'MERGED']).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  }),
});

const GET_SALE_SCHEMA = z.object({ params: ID_PARAMS });

const ADD_ITEMS_SCHEMA = z.object({
  params: ID_PARAMS,
  body: z.object({ items: z.array(ITEM).min(1).max(50) }),
});

const REVERSAL_BODY=z.object({reason:z.string().trim().min(3).max(200),shiftId:z.string().min(1),clientRequestId:z.string().uuid()}).strict();
const REMOVE_ITEM_SCHEMA = z.object({
  params: z.object({ id: z.string().min(1), itemId: z.string().min(1) }),
  body:REVERSAL_BODY,
});

const ADD_PAYMENT_SCHEMA = z.object({
  params: ID_PARAMS,
  body: z.object({
    method: z.enum(['CASH', 'MPESA']),
    amount: z.number().positive().max(10000000),
    reference: z.string().transform(value => value.trim()).pipe(z.string().max(30)).optional(),
    shiftId: SHIFT_CONTEXT_SCHEMA,
  }),
});

const CANCEL_SALE_SCHEMA = z.object({
  params: ID_PARAMS,
  body: REVERSAL_BODY,
});

const MERGE_SALES_SCHEMA = z.object({
  body: z.object({ saleIds: z.array(z.string().min(1)).min(2).max(10) }),
});

// ---------- handlers ----------

/** POST /api/sales  - take a new order (creates its docket and takes the stock out) */
async function createSale(req, res) {
  const { items, notes } = req.validated.body;

  // Anyone with "View all sales" may name a waitress (or leave it as a counter sale).
  // Everyone else always owns their own orders.
  const myPermissions = await getPermissionsForUser(req.user);
  const canAssign = myPermissions.includes('sales.view_all');
  const waiterId = canAssign ? req.validated.body.waiterId || null : req.user.id;
  if (waiterId && waiterId !== req.user.id) {
    const w = await prisma.user.findUnique({ where: { id: waiterId } });
    if (!w || !w.isActive || w.role !== 'WAITER') {
      return res.status(400).json({ message: 'waiterId must be an active waiter' });
    }
  }

  let saleId, operationResult;
  try {
    operationResult = await prisma.$transaction(async (tx) => {
      const receipt = await receipts.begin(tx, req, 'CREATE_ORDER');
      if (receipt.replay) return { ...receipt.result, replay: true };
      // Explicit nullable origin; never fall back to a newly opened shift.
      const userShift = await lockOpenShift(tx, req.user.id, req.validated.body.shiftId, 'MPESA');
      const instant = await databaseInstant(tx);
      const employee = waiterId ? await tx.user.findUnique({ where: { id: waiterId } }) : null;
      if (waiterId && waiterId !== req.user.id && (!employee?.isActive || employee.role !== 'WAITER')) throw httpError(409, 'Selected waitress is no longer eligible. Refresh the order.');
      const rate = await require('../utils/employee-employment').commissionForSale(tx,employee,nairobiDate(instant));
      const lines = await buildLines(tx, items);
      const total = round2(lines.reduce((sum, l) => sum + l.subtotal, 0));
      const sale = await tx.sale.create({
        data: {
          status: 'UNPAID',
          subtotal: total,
          discount: 0,
          total,
          amountPaid: 0,
          balance: total,
          notes: notes || null,
          waiterId,
          createdById: req.user.id,
          shiftId: userShift ? userShift.id : null,
          createdAt: instant,
          accountingDate: new Date(await require('../utils/business-day-runtime').dateForShift(tx,instant,userShift?.id) + 'T00:00:00Z'),
          commissionRateSnapshot: rate,
          items: { create: lines },
          docket: { create: { status: 'PENDING' } },
        },
      });
      const persistedItems = await tx.saleItem.findMany({ where: { saleId: sale.id } });
      await deductStockForItems(tx, persistedItems, {
        saleId: sale.id,
        userId: req.user.id,
        reason: `Order ${sale.saleNumber}`,
      });
      const recordedAt = await databaseInstant(tx);
      await tx.sale.update({ where: { id: sale.id }, data: { createdAt: recordedAt, accountingDate: new Date(await require('../utils/business-day-runtime').dateForShift(tx,recordedAt,userShift?.id) + 'T00:00:00Z') } });
      await audit(tx, sale.id, req.user.id, 'CREATE', null);
      return receipts.commit(tx, receipt, { saleId: sale.id });
    }, TX_OPTIONS);
    saleId = operationResult.saleId;
  } catch (err) {
    // Never retry unrelated unique failures or repeat financial work silently.
    if (err.code === 'P2002') throw httpError(409, 'Order creation conflicted with an existing identifier. Refresh and request review before retrying.');
    throw err;
  }

  // Load the full sale (with items + waiter) then print
  const sale = await loadSale(saleId);
  const waiterName = sale.waiter?.name || null;
  if (!operationResult.replay) printOrder(sale, sale.items || [], waiterName, sale.waiterId, { authorizeReceipt: receiptAuthorization(req) }).catch(() => {});

  res.status(operationResult.replay ? 200 : 201).json({ message: operationResult.replay ? 'Order already recorded' : 'Order created', replayed: operationResult.replay, sale: response.sale(sale, req.permissions) });
}

/** GET /api/sales?status=UNPAID&date=2026-10-18  (merged-away orders are hidden) */
const F = require('../utils/filters');
async function getSales(req, res) {
  const f = F.filters(req.query, { statuses: ['UNPAID','PARTIAL','PAID','CANCELLED','MERGED'] });
  const { status, date } = req.validated.query;
  const where = { status: status || { not: 'MERGED' } };

  if (date) {
    const { start, end } = nairobiDayBounds(date);
    where.createdAt = { gte: start, lt: end };
  }
  const userPermissions = await getPermissionsForUser(req.user);
  if (!userPermissions.includes('sales.view_all')) {
    where.OR = [
      { waiterId: req.user.id },
      { createdById: req.user.id },
    ];
  }

  delete where.createdAt;
  where.AND = [F.saleScope(f)];
  const {sales,total}=await prisma.$transaction(async tx=>{
  const sales = await tx.sale.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: f.pageSize, skip: (f.page-1)*f.pageSize,
    include: saleInclude,
  });
  const total = await tx.sale.count({ where });return{sales,total};
  },{isolationLevel:'RepeatableRead',timeout:15000});
  res.json({ sales: sales.map(sale => response.sale(sale, req.permissions)), pagination: {page:f.page,pageSize:f.pageSize,total,pages:Math.ceil(total/f.pageSize)} });
}

/** GET /api/sales/:id */
async function getSale(req, res) {
  const sale = await loadSale(req.validated.params.id);
  if (!sale) return res.status(404).json({ message: 'Order not found' });
  const userPermissions = await getPermissionsForUser(req.user);
  if (!userPermissions.includes('sales.view_all') && sale.waiterId !== req.user.id && sale.createdById !== req.user.id) {
    return res.status(403).json({ message: 'Not your order' });
  }
  res.json({ sale: response.sale(sale, req.permissions) });
}

/** POST /api/sales/:id/items  - add more items to an unpaid order */
async function addItems(req, res) {
  const { id } = req.validated.params;
  const { items } = req.validated.body;
  let addedLines = [];

  const userPermissions = await getPermissionsForUser(req.user);

  const operationResult = await prisma.$transaction(async (tx) => {
    const receipt = await receipts.begin(tx, req, 'ADD_ITEMS');
    if (receipt.replay) return { ...receipt.result, replay: true };
    const [sale] = await lockMutableSales(tx, [id], req.user, userPermissions, false, true);
    if (!userPermissions.includes('sales.view_all') && sale.waiterId !== req.user.id && sale.createdById !== req.user.id) {
      throw httpError(403, 'Not your order');
    }
    if (sale.status !== 'UNPAID') throw httpError(409, 'Items can only be added to an unpaid order');

    const lines = await buildLines(tx, items);
    addedLines = lines;
    const persistedItems = [];
    for (const line of lines) persistedItems.push(await tx.saleItem.create({ data: { ...line, saleId: id } }));
    await deductStockForItems(tx, persistedItems, {
      saleId: id,
      userId: req.user.id,
      reason: `Items added to ${sale.saleNumber}`,
    });
    await recalcTotals(tx, id);
    await audit(tx, id, req.user.id, 'ADD_ITEMS', sale);
    return receipts.commit(tx, receipt, { saleId: id });
  }, TX_OPTIONS);

  // Print: a docket with ONLY the new items, plus a fresh receipt of the whole order
  const sale = await loadSale(id);
  const names = new Map(sale.items.map((i) => [i.productId, i.product.name]));
  const added = addedLines.map((l) => ({ quantity: l.quantity, product: { name: names.get(l.productId) || 'Item' } }));
  if (!operationResult.replay) printOrder(sale, sale.items, sale.waiter?.name || null, sale.waiterId, { added, authorizeReceipt: receiptAuthorization(req) }).catch(() => {});

  res.status(operationResult.replay ? 200 : 201).json({ message: operationResult.replay ? 'Items already recorded' : 'Items added', replayed: operationResult.replay, sale: response.sale(sale, req.permissions) });
}

/** DELETE /api/sales/:id/items/:itemId  - needs sales.remove_item (puts the stock back) */
async function removeItem(req,res){
 req.financialLegacy=true;req.body={...req.validated.body,kind:'REMOVE_ITEM',saleId:req.validated.params.id,saleItemId:req.validated.params.itemId};
 return require('./financial-operations.controller').create(req,res);
}

/** POST /api/sales/:id/payments  - record a payment */
async function addPayment(req, res) {
  const { id } = req.validated.params;
  const { method } = req.validated.body;
  const amount = round2(req.validated.body.amount);
  const reference = method === 'MPESA'
    ? normalizeMpesaReference(req.validated.body.reference)
    : (req.validated.body.reference || '').trim().toUpperCase();

  // Who may take which payment
  const userPermissions = await getPermissionsForUser(req.user);
  const requiredPerm = method === 'CASH' ? 'pay.cash' : 'pay.mpesa';

  if (!userPermissions.includes(requiredPerm)) {
    return res.status(403).json({ message: 'Permission denied for this payment method' });
  }
  if (method === 'MPESA' && !isValidMpesaReference(reference)) {
    return res.status(400).json({ message: 'Enter the 10-character M-Pesa code (letters and numbers)' });
  }
  if (amount <= 0) {
    return res.status(400).json({ message: 'Amount must be more than 0' });
  }

  const operationResult = await withShiftTransaction(prisma, async (tx) => {
    const receipt = await receipts.begin(tx, req, method === 'CASH' ? 'CASH_PAYMENT' : 'MPESA_PAYMENT');
    if (receipt.replay) return { ...receipt.result, replay: true };
    const receivedShift = await lockOpenShift(tx, req.user.id, req.validated.body.shiftId, method);
    await lockSale(tx, id);

    const sale = await tx.sale.findUnique({ where: { id } });
    if (!sale) throw httpError(404, 'Order not found');
    if (!userPermissions.includes('sales.view_all') && sale.waiterId !== req.user.id && sale.createdById !== req.user.id) {
      throw httpError(403, 'Not your order');
    }
    if (sale.status === 'CANCELLED') throw httpError(409, 'This order was cancelled');
    if (sale.status === 'MERGED') throw httpError(409, 'This order was merged into another bill');
    if (sale.status === 'PAID') throw httpError(409, 'This order is already fully paid');

    await verifyDebt(tx, sale);
    const currentLedger=await require('../utils/financial-ledger').ledger(tx,sale);
    const instant = await databaseInstant(tx);
    const balance = Number(sale.balance);
    if (amount > balance) throw httpError(400, `Amount is more than the balance (${balance})`);

    if (method === 'MPESA') {
      // Friendly early rejection, including legacy noncanonical references.
      // The unique index is authoritative when different sales race this check.
      const used = await tx.$queryRaw(Prisma.sql`
        SELECT id FROM public.payments WHERE method = 'MPESA'
        AND ${Prisma.raw(MPESA_REFERENCE_SQL)} ~ '^[A-Z0-9]{10}$'
        AND ${Prisma.raw(MPESA_REFERENCE_SQL)} = ${reference} LIMIT 1
      `);
      if (used.length) throw httpError(409, 'This M-Pesa code was already used');
    }

    try {
      var recordedPayment=await tx.payment.create({
        data: {
          saleId: id,
          createdAt: instant,
          method,
          amount,
          reference: reference || null,
          receivedById: req.user.id,
          receivedShiftId: receivedShift ? receivedShift.id : null,
        },
      });
    } catch (error) {
      // A uniqueness failure aborts this transaction; Express responds only
      // after Prisma has rolled it back. Do not retry or update sale balances.
      const target = error.meta?.target;
      const identityConflict = Array.isArray(target) && target.length === 1 && target[0] === 'id';
      if (method === 'MPESA' && error.code === 'P2002' && !identityConflict) {
        throw httpError(409, 'This M-Pesa code was already used');
      }
      throw error;
    }

    const paid = round2(Number(sale.amountPaid) + amount);
    const newBalance = round2(Number(currentLedger.total) - paid);
    await tx.sale.update({
      where: { id },
      data: {
        amountPaid: paid,
        balance: newBalance,
        status: newBalance <= 0 ? 'PAID' : 'PARTIAL',
        ...(newBalance <= 0 && sale.commissionRateSnapshot !== null && sale.commissionEarnedAt === null ? { commissionEarnedAt: instant, commissionAmount: require('../utils/pricing-calculations').commissionBasis(sale,currentLedger.total) } : {}),
      },
    });
    if(newBalance<=0)await require('../utils/financial-ledger').restoreCommissionOnSettlement(tx,sale,recordedPayment,currentLedger.total);
    await audit(tx, id, req.user.id, newBalance <= 0 ? 'SETTLE' : 'PAYMENT', sale, { amount, method, receivedShiftId: receivedShift?.id ?? null });
    return receipts.commit(tx, receipt, { saleId: id, paymentId: recordedPayment.id });
  });

  res.status(operationResult.replay ? 200 : 201).json({ message: operationResult.replay ? 'Payment already recorded' : 'Payment recorded', replayed: operationResult.replay, sale: response.sale(await loadSale(id), req.permissions) });
}

/** PATCH /api/sales/:id/cancel  - needs sales.void. Unpaid orders only. Puts the stock back. */
async function cancelSale(req,res){
 req.financialLegacy=true;req.body={...req.validated.body,kind:'CANCEL',saleId:req.validated.params.id};
 return require('./financial-operations.controller').create(req,res);
}

/** POST /api/sales/merge  - combine several unpaid orders of the SAME waiter into one bill */
async function mergeSales(req, res) {
  const ids = [...new Set(req.validated.body.saleIds)];
  if (ids.length < 2) return res.status(400).json({ message: 'Pick at least 2 different orders' });

  let targetId;
  const userPermissions = await getPermissionsForUser(req.user);

  await prisma.$transaction(async (tx) => {
    const sales = await lockMutableSales(tx, ids, req.user, userPermissions, true);
    const target = sales[0]; // the oldest order becomes the merged bill
    const others = sales.slice(1);
    const otherIds = others.map((s) => s.id);
    targetId = target.id;

    // Move the items. Stock is NOT touched: nothing new is being sold.
    await tx.saleItem.updateMany({ where: { saleId: { in: otherIds } }, data: { saleId: target.id } });
    await tx.sale.updateMany({
      where: { id: { in: otherIds } },
      data: { status: 'MERGED', mergedIntoId: target.id, subtotal: 0, total: 0, balance: 0 },
    });
    await tx.sale.update({
      where: { id: target.id },
      data: {
        discount: sales.reduce((sum, s) => sum.add(s.discount), new Prisma.Decimal(0)),
        notes: [target.notes, `MERGED: ${others.map((s) => s.saleNumber).join(', ')}`]
          .filter(Boolean)
          .join(' | '),
      },
    });
    await recalcTotals(tx, target.id, sales.some(s=>s.commissionCapSnapshot!=null)?sales.reduce((n,s)=>n.add(require('../utils/commission-snapshot').entitlement(s)),new Prisma.Decimal(0)):undefined);
    const combined = await tx.sale.findUnique({ where: { id: target.id } });
    if (!combined.total.eq(sales.reduce((sum, s) => sum.add(s.total), new Prisma.Decimal(0)))) throw httpError(409, 'Combined bill value could not be preserved.');
    await audit(tx, target.id, req.user.id, 'MERGE', target, { sources: sales });
    for (const source of others) await audit(tx, source.id, req.user.id, 'MERGED_INTO', source, { targetId: target.id });
  }, TX_OPTIONS);

  res.json({ message: 'Orders merged', sale: response.sale(await loadSale(targetId), req.permissions) });
}


// Read-only reconciliation never triggers/replays a write or returns private event data.
async function mutationStatus(req, res) {
  const requestId = req.params.requestId;
  if (!receipts.UUID.test(requestId)) throw httpError(400, 'Invalid request identifier');
  const event = await prisma.saleAccountingEvent.findUnique({ where: { id: 'mutation:' + requestId.toLowerCase() } });
  if (!receipts.visible(event, req.user.id, req.permissions)) throw httpError(404, 'No committed operation is visible. A request may still be in progress; do not use a new identifier.');
  const sale = await loadSale(event.saleId);
  if (!sale || (!req.permissions.includes('sales.view_all') && sale.waiterId !== req.user.id && sale.createdById !== req.user.id)) throw httpError(403, 'Not your order');
  res.json({ status: 'COMMITTED', operation: event.details.operation, sale: response.sale(sale, req.permissions) });
}

module.exports = {
  mutationStatus,
  createSale, getSales, getSale, addItems, removeItem, addPayment, cancelSale, mergeSales,
  CREATE_SALE_SCHEMA, LIST_SALES_SCHEMA, GET_SALE_SCHEMA, ADD_ITEMS_SCHEMA, REMOVE_ITEM_SCHEMA,
  ADD_PAYMENT_SCHEMA, CANCEL_SALE_SCHEMA, MERGE_SALES_SCHEMA,
};
