'use strict';

const { z } = require('zod');

// Required, including for legacy clients. null deliberately means unassigned
// M-Pesa; omission must never infer another shift or detach a stale request.
const SHIFT_CONTEXT_SCHEMA = z.string({ error: 'shiftId is required: choose an open shift, or explicitly use null for unassigned M-Pesa' }).trim().min(1).nullable();
const error = (status, message) => Object.assign(new Error(message), { status });

async function withShiftTransaction(prisma, work, timeout = 15000) {
  try {
    return await prisma.$transaction(work, { isolationLevel: 'ReadCommitted', timeout, maxWait: 5000 });
  } catch (err) {
    if (err.code === '55P03' || err.meta?.code === '55P03' || err.code === 'P2034') {
      throw error(409, 'Shift transaction is busy. Refresh and retry.');
    }
    throw err;
  }
}

async function lockShiftOwner(tx, ownerId) {
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  const rows = await tx.$queryRaw`SELECT id FROM users WHERE id = ${ownerId} FOR NO KEY UPDATE`;
  if (!rows.length) throw error(404, 'Shift owner not found');
}

async function lockOpenShift(tx, ownerId, shiftId, method, {allowExpired=false}={}) {
  if (shiftId === undefined) throw error(400, 'Choose a shift explicitly before submitting this transaction.');
  // This ordinary read takes no row lock. Reject foreign shift IDs BEFORE
  // locking, so a caller cannot invert another owner's lock hierarchy.
  if (shiftId !== null) {
    const intended = await tx.shift.findUnique({ where: { id: shiftId }, select: { openedById: true } });
    if (!intended) throw error(404, 'Shift not found');
    if (intended.openedById !== ownerId) throw error(403, 'You can only record transactions in your own shift.');
  }
  await lockShiftOwner(tx, ownerId);
  if (shiftId === null) {
    if (method !== 'MPESA') throw error(409, 'Cash requires an open shift. Choose a shift before submitting.');
    return null; // Caller explicitly chose unassigned and passed method permission checks.
  }
  const rows = await tx.$queryRaw`
    SELECT id, "openedById", status, "openingCash" FROM shifts WHERE id = ${shiftId} FOR NO KEY UPDATE
  `;
  const shift = rows[0];
  if (!shift) throw error(404, 'Shift not found');
  if (shift.openedById !== ownerId) throw error(403, 'Shift ownership changed. Refresh and retry.');
  if (shift.status !== 'OPEN') throw error(409, 'This shift is closed. Refresh and explicitly choose an open shift.');
  if(!allowExpired)await require('./business-day-runtime').dateForShift(tx,await require('./accounting').databaseInstant(tx),shift.id);
  return shift;
}

// Participating paths must acquire: owner user -> shift -> sale -> sorted
// products. Never call these helpers while already holding a sale/product lock.
// NO KEY UPDATE is compatible with FK KEY SHARE locks in other sale/stock paths.
module.exports = { SHIFT_CONTEXT_SCHEMA, withShiftTransaction, lockShiftOwner, lockOpenShift };
