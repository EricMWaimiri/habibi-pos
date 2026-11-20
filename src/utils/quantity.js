'use strict';
const { Prisma } = require('@prisma/client');
const { z } = require('zod');
const MAX_QUANTITY = '999999.999999';
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

// Never round an inventory input. Decimal strips insignificant trailing zeros.
// Numeric JSON callers are checked as decoded; text retains the user's digits.
function quantity(value, { positive = false, nonzero = false, min, max, label = 'Quantity', status = 400 } = {}) {
  const reject = message => { throw Object.assign(new Error(label + ': ' + message), { status }); };
  if (!Prisma.Decimal.isDecimal(value) && typeof value !== 'number' && typeof value !== 'string') reject('enter a decimal quantity.');
  if (typeof value === 'string' && (value.length > 200 || !DECIMAL_TEXT.test(value.trim()))) reject('enter a decimal quantity.');
  let decimal;
  try { decimal = new Prisma.Decimal(typeof value === 'string' ? value.trim() : value); }
  catch { reject('enter a decimal quantity.'); }
  if (!decimal.isFinite()) reject('enter a finite quantity.');
  if (decimal.decimalPlaces() > 6) reject('use at most six decimal places; quantities are never rounded.');
  if (decimal.abs().gt(MAX_QUANTITY)) reject('exceeds numeric(12,6) stock capacity.');
  if (positive && !decimal.gt(0)) reject('must be more than zero.');
  if (nonzero && decimal.isZero()) reject('cannot be zero.');
  if (min !== undefined && decimal.lt(min)) reject('is below the permitted minimum.');
  if (max !== undefined && decimal.gt(max)) reject('exceeds the permitted maximum.');
  return decimal;
}

function quantitySchema(options) {
  return z.union([z.number(), z.string()]).transform((value, ctx) => {
    try { return quantity(value, options); }
    catch (error) { ctx.addIssue({ code: 'custom', message: error.message }); return z.NEVER; }
  });
}

function csvQuantity(raw, row, options = {}) {
  return quantity(raw, { ...options, label: `CSV row ${row} quantity` });
}

// Caller already holds the product lock. No locks are acquired here: preserve
// owner -> shift -> sale -> sorted products -> count ordering in every caller.
async function applyStockDelta(tx, productId, rawDelta, productData = {}) {
  const delta = quantity(rawDelta);
  const product = await tx.product.findUnique({ where: { id: productId }, select: { quantity: true } });
  if (!product) throw Object.assign(new Error('Stock product not found.'), { status: 409 });
  const previousQty = quantity(product.quantity, { label: 'Original stock', status: 409 });
  const expected = quantity(previousQty.add(delta), { label: 'Resulting stock', status: 409 });
  const updated = await tx.product.update({ where: { id: productId },
    data: { ...productData, quantity: { increment: delta } }, select: { quantity: true } });
  if (!updated.quantity.eq(expected)) throw Object.assign(new Error('Stock movement did not reconcile; no changes were committed.'), { status: 409 });
  return { quantityChange: delta, previousQty, quantityAfter: updated.quantity };
}

module.exports = { MAX_QUANTITY, quantity, quantitySchema, csvQuantity, applyStockDelta };
