'use strict';

// Shared uncached session checks. No global database client or environment load.
const MAX_SESSION_VERSION = 2147483647;
const unavailableCodes = new Set([
  'P1000', 'P1001', 'P1002', 'P1008', 'P1010', 'P1011', 'P1017',
  'P2024', 'P2028', '55P03', '57014', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
]);

function failure(status, message) {
  // Never retain a driver error, submitted claims, token or credential as cause.
  return Object.assign(new Error(message), { status });
}

function authenticationError() {
  return failure(401, 'Please log in again');
}

function isValidSessionVersion(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SESSION_VERSION;
}

function assertSessionVersion(value) {
  if (!isValidSessionVersion(value)) throw authenticationError();
  return value;
}

function assertMatchingSessionVersions(tokenVersion, databaseVersion) {
  if (assertSessionVersion(tokenVersion) !== assertSessionVersion(databaseVersion)) throw authenticationError();
}

function nextSessionVersion(currentVersion) {
  assertSessionVersion(currentVersion);
  if (currentVersion === MAX_SESSION_VERSION) {
    throw failure(409, 'Session changes require manual review');
  }
  // Pure overflow check, NOT a writer. Future callers must lock and use the
  // transaction client's atomic increment, never persist a stale computed value.
  return currentVersion + 1;
}

function assertSessionClaims(claims, now = Math.floor(Date.now() / 1000)) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims) ||
      !Object.hasOwn(claims, 'id') || typeof claims.id !== 'string' || !claims.id.trim() ||
      !Object.hasOwn(claims, 'sessionVersion') ||
      !Number.isSafeInteger(claims.iat) || claims.iat < 0 || !Number.isSafeInteger(claims.exp) ||
      claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 43200) throw authenticationError();
  assertSessionVersion(claims.sessionVersion);
}

async function assertCurrentSession(client, claims) {
  // Recheck expiry AFTER acquiring the guard/rows, not only at middleware admission.
  assertSessionClaims(claims);
  return verifySessionUser(client, claims);
}

/**
 * Call only AFTER cryptographic JWT signature/expiry verification. This helper
 * does not authenticate a raw JWT or implement permission/ownership checks.
 * Supply the PRIMARY Prisma client, or its READ COMMITTED transaction client
 * after acquiring the administration guard/user locks. Never pass a replica,
 * long-lived snapshot, cached user, or substitute the global client in a tx.
 * Each invocation performs a new read. No .env loading or connections on import.
 * Future guarded callers must also recheck token expiry after waiting for locks.
 */
async function verifySessionUser(client, verifiedClaims) {
  if (!verifiedClaims || typeof verifiedClaims !== 'object' || Array.isArray(verifiedClaims) ||
      !Object.hasOwn(verifiedClaims, 'id') || typeof verifiedClaims.id !== 'string' || !verifiedClaims.id.trim() ||
      !Object.hasOwn(verifiedClaims, 'sessionVersion')) throw authenticationError();
  const id = verifiedClaims.id;
  const version = assertSessionVersion(verifiedClaims.sessionVersion);
  if (typeof client?.user?.findUnique !== 'function') {
    throw failure(500, 'Authentication could not be verified');
  }
  let user;
  try {
    user = await client.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true, sessionVersion: true, name: true, createdAt: true },
    });
  } catch (error) {
    const unavailable = unavailableCodes.has(error?.code) || unavailableCodes.has(error?.meta?.code);
    throw failure(unavailable ? 503 : 500,
      unavailable ? 'Authentication temporarily unavailable' : 'Authentication could not be verified');
  }
  if (!user || user.id !== id || user.isActive !== true || !['MANAGER', 'CASHIER', 'WAITER'].includes(user.role)) {
    throw authenticationError();
  }
  assertMatchingSessionVersions(version, user.sessionVersion);
  // Identity only. Effective grants still come from the existing resolver;
  // claims.role is deliberately ignored and no session internals are returned.
  return Object.freeze({ id: user.id, role: user.role, isActive: true,
    ...(Object.hasOwn(user, 'name') ? { name: user.name } : {}),
    ...(Object.hasOwn(user, 'createdAt') ? { createdAt: user.createdAt } : {}),
  });
}

module.exports = {
  MAX_SESSION_VERSION, isValidSessionVersion, assertSessionVersion,
  assertMatchingSessionVersions, nextSessionVersion, authenticationError, verifySessionUser,
  assertSessionClaims, assertCurrentSession,
};
