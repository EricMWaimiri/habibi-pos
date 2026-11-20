const response = require('../utils/responses');
const { quantitySchema, applyStockDelta } = require('../utils/quantity');
const prisma = require('../config/prisma');
const { z } = require('zod');
const { lockProducts } = require('../utils/stock');
const { assertStockAvailable } = require('../utils/stock-counts');

const TX_OPTIONS = { timeout: 30000 };

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Change the stock of ONE product and write a line in the stock ledger.
// Returns the new quantity.
async function changeProductStock(tx, { productId, change, type, reason, userId }) {
  const movement = await applyStockDelta(tx, productId, change);

  await tx.stockMovement.create({
    data: {
      productId,
      type,
      ...movement,
      reason,
      userId,
    },
  });

  return movement.quantityAfter;
}

// GET /api/stock
const F = require('../utils/filters');
async function getStock(req, res) {
  const f=F.filters(req.query);
  const paged=Object.keys(req.query||{}).length>0;
  if(f.range||f.shiftId||f.staffId)throw Object.assign(new Error('This is a current stock/catalogue view. Use the movement ledger for historical date and shift filters.'),{status:400});
  const where={...(f.q?{OR:[{name:F.contains(f.q)},{productCode:F.contains(f.q)}]}:{}),isActive:true};
  const products = await prisma.product.findMany({
    where, ...(paged?{take:f.pageSize,skip:(f.page-1)*f.pageSize}:{}),
    select: {
      id: true,
      name: true,
      type: true,
      unitOfMeasure: true,
      quantity: true,
      cost: true,
      price: true,
      category: { select: { name: true } },
    },
    orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }, { id:'asc' }],
  });
  const total=paged?await prisma.product.count({where}):products.length;
  res.json({ products: products.map(product => response.stock(product, req.permissions)), ...(paged?{pagination:{page:f.page,pageSize:f.pageSize,total,pages:Math.ceil(total/f.pageSize)}}:{}) });
}

// ---------- receive stock ----------

const RECEIVE_SCHEMA = z.object({
  body: z.object({
    productId: z.string().min(1),
    quantity: quantitySchema({ positive: true }),
    reason: z.string().max(200).optional(),
  }),
});

// POST /api/stock/receive
async function receiveStock(req, res) {
  const { productId, quantity, reason } = req.validated.body;

  await prisma.$transaction(async (tx) => {
    await lockProducts(tx, [productId]);
    await assertStockAvailable(tx, [productId]);
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product || !product.isActive) throw httpError(404, 'Product not found');
    if (product.type === 'composite') {
      throw httpError(400, 'Recipe items have no stock of their own. Receive the ingredient instead.');
    }

    await changeProductStock(tx, {
      productId,
      change: quantity,
      type: 'IN',
      reason: reason || 'Stock received',
      userId: req.user.id,
    });
  }, TX_OPTIONS);

  res.status(201).json({ message: 'Stock received successfully' });
}

// ---------- adjust stock (needs stock.adjust) ----------

const ADJUST_SCHEMA = z.object({
  body: z.object({
    productId: z.string().min(1),
    // + adds stock, - removes stock (for example broken or spilled items)
    change: quantitySchema({ min: -100000, max: 100000, nonzero: true }),
    reason: z.string().trim().min(3).max(200),
  }),
});

// POST /api/stock/adjust
async function adjustStock(req, res) {
  const { productId, change, reason } = req.validated.body;
  let newQuantity;

  await prisma.$transaction(async (tx) => {
    await lockProducts(tx, [productId]);
    await assertStockAvailable(tx, [productId]);
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product || !product.isActive) throw httpError(404, 'Product not found');
    if (product.type === 'composite') {
      throw httpError(400, 'Recipe items have no stock of their own. Adjust the ingredient instead.');
    }

    newQuantity = await changeProductStock(tx, {
      productId,
      change,
      type: 'ADJUSTMENT',
      reason: `Adjustment: ${reason}`,
      userId: req.user.id,
    });

    // Removing stock may not push it below zero (this undoes the whole change)
    if (change.lt(0) && newQuantity.lt(0)) {
      throw httpError(400, 'You cannot remove more than the stock on hand');
    }
  }, TX_OPTIONS);

  res.status(201).json({ message: 'Stock adjusted', quantity: Number(newQuantity) });
}

module.exports = { getStock, receiveStock, adjustStock, RECEIVE_SCHEMA, ADJUST_SCHEMA };
