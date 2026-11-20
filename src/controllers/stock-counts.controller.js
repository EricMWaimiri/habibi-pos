const response = require('../utils/responses');
const { quantity: exactQuantity, quantitySchema, applyStockDelta } = require('../utils/quantity');
const prisma = require('../config/prisma');
const { z } = require('zod');
const { getPermissionsForUser } = require('../utils/permissions');
const { lockProducts } = require('../utils/product-locks');
const c = require('../utils/stock-counts');
const id = z.string().min(1).max(100);
const quantity = quantitySchema({ min: 0, max: '999999.999999' });
const START_COUNT_SCHEMA = z.object({ body: z.object({ productIds: z.array(id).min(1).max(20), notes: z.string().max(500).optional() }) });
const COUNT_SCHEMA = z.object({ body: z.object({ sessionId: id, items: z.array(z.object({ productId: id, countedQty: quantity })).min(1).max(20) }) });
const READY_SCHEMA = z.object({ body: z.object({ physicalReady: z.literal(true) }) });
const APPROVE_SCHEMA = z.object({ body: z.object({ updateStock: z.boolean() }) });
const manager = async req => (await getPermissionsForUser(req.user)).includes('stock.count_approve');
const phase = (count, at) => count.status !== 'DRAFT' ? count.status : !count.baselineAt ? 'LEGACY' : count.submittedAt ? 'SUBMITTED' : count.expiresAt <= at ? 'EXPIRED' : count.readyAt ? 'COUNTING' : 'PREPARING';
async function send(res, count, status = 200) {
  const at = await c.now(prisma);
  res.status(status).json({ count: { ...response.count(count), phase: phase(count, at) }, serverNow: at });
}

async function startStockCount(req, res) {
  const { productIds, notes } = req.validated.body;
  if (new Set(productIds).size !== productIds.length) throw c.error(400, 'Duplicate count products are not allowed.');
  const minutes = (await require('../utils/settings').read(prisma)).data.inventory.countSessionMinutes;
  const count = await c.transaction(prisma, async tx => {
    await lockProducts(tx, productIds);
    const products = await tx.product.findMany({ where: { id: { in: productIds } }, include: { countSession: true } });
    const at = await c.now(tx);const reclaimed = [];
    for (const p of products) {
      if (!p.isActive || p.type !== 'simple') throw c.error(400, 'Only active stock ingredients can be counted.');
      const previous = p.countSession;
      if (previous?.status === 'DRAFT') {
        if (previous.submittedAt || !previous.expiresAt || previous.expiresAt > at) throw c.conflict('A count for this product is already counting or awaiting approval.');
        reclaimed.push(previous.id);
      }
    }
    const record = await tx.stockCount.create({ data: { countedById: req.user.id, createdAt: at, baselineAt: at, expiresAt: new Date(at.getTime() + minutes * 60000), notes: notes || 'Physical stock count' } });
    for (const p of products) await tx.stockCountItem.create({ data: { stockCountId: record.id, productId: p.id, systemQty: p.quantity,
      baselineMovementCount: await tx.stockMovement.count({ where: { productId: p.id } }) } });
    await tx.product.updateMany({ where: { id: { in: productIds } }, data: { countSessionId: record.id } });
    await c.event(tx, record.id, req.user.id, 'START', { minutes, reclaimedSessionIds: [...new Set(reclaimed)] });
    return tx.stockCount.findUnique({ where: { id: record.id }, include: c.include });
  });
  await send(res, count, 201);
}
async function getStockCount(req, res) {
  const count = await prisma.stockCount.findUnique({ where: { id: req.params.id }, include: c.include });
  if (!count) throw c.error(404, 'Stock count not found');
  c.authorize(count, req.user.id, await manager(req));await send(res, count);
}
async function getPendingCounts(req, res) {
  const canManage = await manager(req);const at = await c.now(prisma);
  const counts = await prisma.stockCount.findMany({ where: { status: 'DRAFT', ...(canManage ? {} : { countedById: req.user.id }) }, include: c.include, orderBy: { createdAt: 'desc' } });
  res.json({ counts: counts.map(count => ({ ...response.count(count), phase: phase(count, at) })), serverNow: at });
}
async function countHistory(req,res){
 const F=require('../utils/filters'),f=F.filters(req.query,{statuses:['DRAFT','COMPLETED','CANCELLED']});
 if(f.shiftId||f.method||f.type||f.balances)throw c.error(400,'Stock-count history has no authoritative shift, payment method or balance basis.');
 const basis=req.query.dateBasis||'created';if(typeof basis!=='string'||!['created','submitted','completed'].includes(basis))throw c.error(400,'Choose created, submitted or completed count date basis.');const field={created:'createdAt',submitted:'submittedAt',completed:'completedAt'}[basis];
 const canManage=await manager(req),where=F.and(canManage?{}:{countedById:req.user.id},f.staffId?{countedById:F.id(f.staffId)}:{},f.productId?{items:{some:{productId:f.productId}}}:{},require('../utils/business-day-context').timeScope(f,field),f.status?{status:f.status}:{},f.q?{OR:[{notes:F.contains(f.q)},{id:F.contains(f.q)}]}:{});
 const result=await prisma.$transaction(tx=>F.page(tx,'stockCount',{where,include:c.include,orderBy:[{createdAt:'desc'},{id:'desc'}]},f),{isolationLevel:'RepeatableRead',timeout:15000});
 res.json({counts:result.rows.map(response.count),pagination:result.pagination,dateBasis:basis,attribution:'Count session '+basis+' time; shift attribution unavailable. Ownership and count-approval access preserved.'});
}
async function readyStockCount(req, res) {
  const canManage = await manager(req);
  const count = await c.transaction(prisma, async tx => {
    const current = await c.lockSession(tx, req.params.id);c.authorize(current, req.user.id, canManage);
    const at = await c.verifyCounting(tx, current);
    if (!current.readyAt) {
      await tx.stockCount.update({ where: { id: current.id }, data: { readyAt: at } });
      await c.event(tx, current.id, req.user.id, 'PHYSICAL_READY', { confirmation: 'Pending pours/reserved units segregated; deliveries and physical returns held outside counted stock.' });
    }
    return tx.stockCount.findUnique({ where: { id: current.id }, include: c.include });
  });await send(res, count);
}
async function extendStockCount(req, res) {
  const canManage = await manager(req);const minutes = c.leaseMinutes();
  const count = await c.transaction(prisma, async tx => {
    const current = await c.lockSession(tx, req.params.id);c.authorize(current, req.user.id, canManage);
    await c.verifyCounting(tx, current);
    const expiresAt = new Date(current.expiresAt.getTime() + minutes * 60000);
    await tx.stockCount.update({ where: { id: current.id }, data: { expiresAt } });
    await c.event(tx, current.id, req.user.id, 'EXTEND', { previousExpiry: current.expiresAt.toISOString(), expiresAt: expiresAt.toISOString(), minutes });
    return tx.stockCount.findUnique({ where: { id: current.id }, include: c.include });
  });await send(res, count);
}
async function discardStockCount(req, res) {
  const canManage = await manager(req);
  const count = await c.transaction(prisma, async tx => {
    const current = await c.lockSession(tx, req.params.id);c.authorize(current, req.user.id, canManage);
    if (current.status !== 'DRAFT') throw c.conflict('This count has already been processed.');
    await tx.stockCount.update({ where: { id: current.id }, data: { status: 'CANCELLED', completedAt: await c.now(tx) } });
    await c.release(tx, current.id);await c.event(tx, current.id, req.user.id, 'DISCARD');
    return tx.stockCount.findUnique({ where: { id: current.id }, include: c.include });
  });await send(res, count);
}
async function submitStockCount(req, res) {
  const { sessionId, items } = req.validated.body;const canManage = await manager(req);
  const count = await c.transaction(prisma, async tx => {
    const current = await c.lockSession(tx, sessionId);c.authorize(current, req.user.id, canManage);
    const at = await c.verifyCounting(tx, current);
    if (!current.readyAt) throw c.conflict('Confirm physical readiness before counting and submitting.');
    const byId = new Map(items.map(i => [i.productId, i.countedQty]));
    if (byId.size !== items.length || byId.size !== current.items.length || current.items.some(i => !byId.has(i.productId))) throw c.conflict('Submit the exact session product set once each.');
    for (const item of current.items) {
      const countedQty = exactQuantity(byId.get(item.productId), { min: 0 });const difference = exactQuantity(countedQty.sub(item.systemQty), { label: 'Count variance' });
      if (difference.abs().gt('999999.999999')) throw c.error(400, 'Count variance exceeds supported stock precision.');
      await tx.stockCountItem.update({ where: { id: item.id }, data: { countedQty, difference } });
    }
    await tx.stockCount.update({ where: { id: current.id }, data: { submittedAt: at, submittedById: req.user.id } });
    await c.event(tx, current.id, req.user.id, 'SUBMIT');
    return tx.stockCount.findUnique({ where: { id: current.id }, include: c.include });
  });await send(res, count, 201);
}
async function approveStockCount(req, res) {
  const { updateStock } = req.validated.body;
  const count = await c.transaction(prisma, async tx => {
    const current = await c.lockSession(tx, req.params.id);
    if (current.status !== 'DRAFT') throw c.conflict('This count has already been processed.');
    const verified = current.baselineAt && current.readyAt && current.submittedAt && current.items.length;
    if (updateStock && !verified) throw c.conflict('This count has no verified physical baseline. Manual review and a new count are required.');
    if (current.baselineAt && !current.submittedAt) throw c.conflict('Submit or discard the count before approval.');
    for (const item of current.items) {
      const p = await tx.product.findUnique({ where: { id: item.productId } });
      if (current.baselineAt && (p.countSessionId !== current.id || !p.isActive || p.type !== 'simple')) throw c.conflict('The count claim is stale. Discard and recount.');
      if (updateStock && (item.baselineMovementCount === null || item.countedQty === null || item.difference === null || !item.countedQty.sub(item.systemQty).eq(item.difference))) throw c.conflict('This count variance cannot be verified. Manual review is required.');
    }
    if (updateStock) for (const item of current.items) {
      const movement = await applyStockDelta(tx, item.productId, exactQuantity(item.difference, { status: 409, label: 'Approved variance' }));
      await tx.stockMovement.create({ data: { productId: item.productId, stockCountItemId: item.id, type: 'COUNT', ...movement, reason: 'Approved physical count ' + current.id, userId: req.user.id } });
    }
    const completed = await tx.stockCount.update({ where: { id: current.id }, data: { status: 'COMPLETED', completedAt: await c.now(tx), approvedById: req.user.id, stockApplied: updateStock } });
    await c.release(tx, current.id);await c.event(tx, current.id, req.user.id, updateStock ? 'APPROVE_APPLIED' : verified ? 'APPROVE_RECORD_ONLY' : 'ARCHIVE_UNVERIFIED');
    return completed;
  });res.json({ message: updateStock ? 'Stock variance applied once; subsequent movements preserved.' : 'Count archived without changing stock.', count: response.count(count) });
}
module.exports = { countHistory, startStockCount, getStockCount, getPendingCounts, readyStockCount, extendStockCount, discardStockCount, submitStockCount, approveStockCount,
  START_COUNT_SCHEMA, COUNT_SCHEMA, READY_SCHEMA, APPROVE_SCHEMA };
