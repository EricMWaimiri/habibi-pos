const { quantity: exactQuantity, applyStockDelta } = require('./quantity');
const { Prisma } = require('@prisma/client');
const { lockProducts } = require('./product-locks');
const { assertStockAvailable } = require('./stock-counts');

const review = () => Object.assign(new Error('Exact original stock deductions cannot be verified. Manual review is required; no stock or sale changes were made.'), { status: 409 });

// Caller owns the sale lock (or is creating the sale), then sorted product locks.
// Reject unsupported precision before increment/ledger insertion. Never round.
async function changeStock(tx, change, info) {
  const movement = await applyStockDelta(tx, change.productId, change.quantityChange);

  return tx.stockMovement.create({ data: {
    ...change, ...movement, type: 'SALE', saleId: info.saleId, userId: info.userId, reason: info.reason,
  } });
}

// Only persisted, newly-created items are accepted. Restoration never loads
// current recipes/types; it uses exactly the movements recorded here.
async function deductStockForItems(tx, items, info) {
  const products = await tx.product.findMany({
    where: { id: { in: [...new Set(items.map(i => i.productId))] } }, include: { components: { where: { quantity: { gt: 0 } } } },
  });
  const byId = new Map(products.map(p => [p.id, p]));
  const changes = [];
  const counts = new Map();
  for (const item of items) {
    if (!item.id || item.stockDeductionCount !== null || item.removedAt) throw review();
    const product = byId.get(item.productId);
    if (!product) throw review();
    const parts = product.type === 'composite' ? product.components.map(c => ({ id: c.componentProductId, quantity: c.quantity })) : [{ id: product.id, quantity: new Prisma.Decimal(1) }];
    counts.set(item.id, 0);
    for (const part of parts) {
      const quantity = exactQuantity(exactQuantity(part.quantity, { min: 0, status: 409, label: 'Recipe quantity' }).mul(exactQuantity(item.quantity, { positive: true, status: 409, label: 'Order quantity' })), { min: 0, status: 409, label: 'Calculated deduction' });
      if (!quantity.isFinite() || quantity.lt(0)) throw review();
      if (quantity.isZero()) continue; // Verified exact zero; never phantom stock.
      changes.push({ productId: part.id, saleItemId: item.id, quantityChange: quantity.negated() });
      counts.set(item.id, counts.get(item.id) + 1);
    }
  }
  await lockProducts(tx, changes.map(c => c.productId));
  await assertStockAvailable(tx, changes.map(c => c.productId));
  for (const change of changes) await changeStock(tx, change, info);
  for (const [id, count] of counts) await tx.saleItem.update({ where: { id }, data: { stockDeductionCount: count } });
}

async function restoreStockForItems(tx, items, info) {
  // Validate the ENTIRE batch before any inverse. Missing history is not zero.
  const originals = [];
  for (const item of items) {
    if (item.removedAt || !Number.isInteger(item.stockDeductionCount) || item.stockDeductionCount < 0) throw review();
    const movements = await tx.stockMovement.findMany({ where: { saleItemId: item.id }, include: { reversal: { select: { id: true } } } });
    if (movements.length !== item.stockDeductionCount) throw review();
    for (const m of movements) {
      if (m.type !== 'SALE' || !m.saleId || m.reversalOfId || m.reversal || !m.quantityChange.lt(0) ||
          !m.previousQty.add(m.quantityChange).eq(m.quantityAfter)) throw review();
      originals.push(m);
    }
  }
  await lockProducts(tx, originals.map(m => m.productId));
  await assertStockAvailable(tx, originals.map(m => m.productId));
  try {
    for (const m of originals) await changeStock(tx, {
      productId: m.productId, saleItemId: m.saleItemId,
      quantityChange: m.quantityChange.negated(), reversalOfId: m.id,
    }, info);
  } catch (err) {
    // Unique reversal constraint is the final guard; rollback undoes increments.
    if (err.code === 'P2002') throw review();
    throw err;
  }
}

module.exports = { deductStockForItems, restoreStockForItems, lockProducts };
