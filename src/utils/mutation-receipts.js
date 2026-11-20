'use strict';
const { createHash } = require('node:crypto');
const { assertCurrentSession } = require('./session-version');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
function context(req, operation) {
  const value = req.get('Idempotency-Key');
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(400, 'A stable UUID Idempotency-Key is required.');
  const requestId = value.toLowerCase();
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ operation,
    target: req.validated.params?.id || null, body: req.validated.body }))).digest('hex');
  return { id: 'mutation:' + requestId, requestId, fingerprint, operation, actorId: req.user.id };
}
// Lock order: request advisory guard -> existing owner -> shift -> sale -> sorted products.
// This namespace is independent of administration/retained-test guards. Hash collisions
// only serialize unrelated requests; the full UUID primary key remains authoritative.
async function begin(tx, req, operation) {
  const c = context(req, operation);
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  try { await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(180022, hashtext(${c.requestId}))`; }
  catch (error) {
    if (error.code === '55P03' || error.meta?.code === '55P03') throw fail(409, 'Operation is busy. Reconcile using the same request identifier.');
    throw error;
  }
  await assertCurrentSession(tx, req.auth);
  const event = await tx.saleAccountingEvent.findUnique({ where: { id: c.id } });
  if (!event) return { context: c, replay: false };
  if (event.actorId !== c.actorId || event.action !== 'MUTATION_COMMITTED' ||
      event.details?.operation !== operation || event.details?.fingerprint !== c.fingerprint) {
    throw fail(409, 'This request identifier was already used for a different operation.');
  }
  const sale = await tx.sale.findUnique({ where: { id: event.saleId } });
  if (!sale || (!req.permissions.includes('sales.view_all') && sale.createdById !== c.actorId && sale.waiterId !== c.actorId)) {
    throw fail(403, 'Not your order');
  }
  return { context: c, replay: true, result: event.details.result };
}
async function commit(tx, receipt, result) {
  const c = receipt.context;
  await tx.saleAccountingEvent.create({ data: { id: c.id, actorId: c.actorId, saleId: result.saleId,
    action: 'MUTATION_COMMITTED', details: { requestId: c.requestId, operation: c.operation,
      fingerprint: c.fingerprint, result } } });
  return { ...result, replay: false };
}
const permission = operation => ({ CREATE_ORDER: 'sales.make', ADD_ITEMS: 'sales.make', CASH_PAYMENT: 'pay.cash', MPESA_PAYMENT: 'pay.mpesa' })[operation];
function visible(event, actorId, permissions) {
  return event?.actorId === actorId && event.action === 'MUTATION_COMMITTED' &&
    permissions.includes(permission(event.details?.operation));
}
module.exports = { UUID, context, begin, commit, visible };
