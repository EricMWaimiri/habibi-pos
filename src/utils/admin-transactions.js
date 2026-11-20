'use strict';

// Infrastructure only: not authorization and not a last-manager invariant.
// Call before holding any user/grant/financial locks. Participating writers use:
// advisory guard -> sorted user rows -> sorted role/key permission writes.
// Callbacks must not acquire shift, sale or product locks, use the global client,
// nest transactions, perform network I/O or wait for human input.
const { Prisma } = require('@prisma/client');

const ADMIN_LOCK_KEY = Object.freeze([180021, 33]); // (180021,1) is the test-run guard.
const TRANSACTION_OPTIONS = Object.freeze({ isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 15000 });
const guardedTransactions = new WeakSet();
const contentionCodes = new Set(['55P03', '40P01', '40001', '57014', 'P2024', 'P2028', 'P2034']);

function userIds(actorId, targetIds) {
  if (!Array.isArray(targetIds)) throw new TypeError('targetIds must be an array of user IDs.');
  const ids = actorId === null ? [...targetIds] : [actorId, ...targetIds];
  if (ids.some(id => typeof id !== 'string' || !id.trim())) throw new TypeError('Administration requires nonempty user IDs.');
  return [...new Set(ids)].sort();
}

/**
 * Uses an existing Prisma client; never loads .env or creates a connection pool.
 * actorId:null supports future default seeding (not an authorization bypass for
 * HTTP callers). Existing targets must be listed up front; new users have no row
 * to lock yet. Callback receives the transaction client for fresh uncached reads.
 */
async function withAdminTransaction(prisma, { actorId = null, targetIds = [] } = {}, work) {
  if (!prisma || typeof prisma.$transaction !== 'function' || typeof work !== 'function') {
    throw new TypeError('An administration transaction requires a Prisma client and callback.');
  }
  const ids = userIds(actorId, targetIds);
  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
      // Select an integer, not PostgreSQL's void lock result (Prisma raw decoding).
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADMIN_LOCK_KEY[0]}::integer, ${ADMIN_LOCK_KEY[1]}::integer)`;
      const users = ids.length ? await tx.$queryRaw(Prisma.sql`
        SELECT id, role, "isActive" FROM public.users
        WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR NO KEY UPDATE
      `) : [];
      const byId = new Map(users.map(user => [user.id, user]));
      if (ids.some(id => !byId.has(id))) {
        throw Object.assign(new Error('Administration account not found. Refresh and retry.'), { status: 404 });
      }
      guardedTransactions.add(tx);
      try {
        return await work(tx, { actor: actorId === null ? null : byId.get(actorId), users });
      } finally {
        guardedTransactions.delete(tx);
      }
    }, { ...TRANSACTION_OPTIONS });
  } catch (error) {
    if (contentionCodes.has(error?.code) || contentionCodes.has(error?.meta?.code)) {
      // Throw only after Prisma has rejected/rolled back the transaction. Do not
      // retry an operation that may change credentials, roles or permissions.
      throw Object.assign(new Error('Administration is busy. Refresh and retry.'), { status: 409 });
    }
    throw error;
  }
}

async function countActiveManagers(tx) {
  if (!guardedTransactions.has(tx)) throw new TypeError('Count active managers inside the administration guard.');
  // GLOBAL production predicate: no actor, fixture, cohort, PIN or target filter.
  // The integrating writer must enforce its invariant in this same transaction.
  return tx.user.count({ where: { role: 'MANAGER', isActive: true } });
}

module.exports = { ADMIN_LOCK_KEY, TRANSACTION_OPTIONS, withAdminTransaction, countActiveManagers };
