const { lockProducts } = require('./product-locks');
const error = (status, message) => Object.assign(new Error(message), { status });
const conflict = message => error(409, message);
const include = { items: { include: { product: { select: { name: true, unitOfMeasure: true } } } }, countedBy: { select: { name: true } }, events: { orderBy: { createdAt: 'asc' } } };

function leaseMinutes() {
  const n = Number(process.env.STOCK_COUNT_SESSION_MINUTES ?? 5);
  if (!Number.isFinite(n) || n < 1 || n > 60) throw error(503, 'Stock count duration must be configured between 1 and 60 minutes.');
  return n;
}
async function now(tx) { const [r] = await tx.$queryRaw`SELECT clock_timestamp() AS now`; return r.now; }
async function transaction(prisma, work) {
  try { return await prisma.$transaction(work, { isolationLevel: 'ReadCommitted', timeout: 30000, maxWait: 5000 }); }
  catch (e) {
    if (e.code === 'P2034' || e.code === '55P03' || e.meta?.code === '55P03') throw conflict('Inventory is busy. Refresh and retry.');
    throw e;
  }
}
async function event(tx, countId, userId, action, details) {
  return tx.stockCountEvent.create({ data: { stockCountId: countId, userId, action, createdAt: await now(tx), ...(details ? { details } : {}) } });
}

// MUST be called after locking the complete affected product set, before writes.
// A submitted count reserves the next count slot, but no longer pauses stock.
async function assertStockAvailable(tx, ids, maintenance = false) {
  if (!ids.length) return;
  const products = await tx.product.findMany({ where: { id: { in: [...new Set(ids)] } }, include: { countSession: true } });
  const at = await now(tx);
  for (const product of products) {
    const c = product.countSession;
    if (!c || c.status !== 'DRAFT') continue;
    if (c.submittedAt) {
      if (maintenance) throw conflict('A stock count is awaiting approval. Quantity imports are blocked for this product.');
      continue;
    }
    if (!c.expiresAt || c.expiresAt > at) throw conflict('Stock counting is in progress for ' + product.name + '. Finish or discard the count before changing this stock.');
  }
}

// Never lock a count row before products. Ordinary discovery reads take no row locks.
async function lockSession(tx, id) {
  const found = await tx.stockCount.findUnique({ where: { id }, select: { items: { select: { productId: true } } } });
  if (!found) throw error(404, 'Stock count not found');
  await lockProducts(tx, found.items.map(i => i.productId));
  await tx.$queryRaw`SELECT id FROM stock_counts WHERE id = ${id} FOR NO KEY UPDATE`;
  return tx.stockCount.findUnique({ where: { id }, include });
}
function authorize(count, userId, manager) {
  if (count.countedById !== userId && !manager) throw error(403, 'This stock count belongs to another user.');
}
async function verifyCounting(tx, count) {
  const at = await now(tx);
  if (count.status !== 'DRAFT' || !count.baselineAt || !count.expiresAt || count.submittedAt || count.expiresAt <= at || !count.items.length) throw conflict('This count is expired, unverified or already submitted. Start a new physical count.');
  for (const item of count.items) {
    const p = await tx.product.findUnique({ where: { id: item.productId } });
    if (p.countSessionId !== count.id || !p.isActive || p.type !== 'simple' || !p.quantity.eq(item.systemQty) || item.baselineMovementCount === null ||
        await tx.stockMovement.count({ where: { productId: p.id } }) !== item.baselineMovementCount) throw conflict('The original count baseline cannot be verified. Discard this session and recount.');
  }
  return at;
}
async function release(tx, countId) { await tx.product.updateMany({ where: { countSessionId: countId }, data: { countSessionId: null } }); }
module.exports = { error, conflict, include, leaseMinutes, now, transaction, event, assertStockAvailable, lockSession, authorize, verifyCounting, release };
