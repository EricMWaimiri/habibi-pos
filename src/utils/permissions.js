const prisma = require('../config/prisma'); // <-- Shared client (fixes duplicate connections)

const { PERMISSIONS, DEFAULTS, ROLE_VALUES } = require('./permission-definitions');
const { withAdminTransaction } = require('./admin-transactions');
const { effectivePermissions, createAdminContext } = require('./admin-policy');

// Compatibility hook for existing callers. Authorization has no process-local
// cache to invalidate: every resolver call reads the primary database.
function invalidatePermissionCache() {}

async function ensureDefaults() {
  // Called before server.listen. No actor/context lookup or recursion into
  // ensureDefaults: a fresh database may not have any permission rows yet.
  await withAdminTransaction(prisma, {}, async tx => {
    for (const role of [...ROLE_VALUES].sort()) {
      for (const permission of [...PERMISSIONS].sort((a, b) => a.key.localeCompare(b.key))) {
        await tx.rolePermission.upsert({
          where: {
            role_permission: {
              role,
              permission: permission.key,
            },
          },
          update: {}, // Do NOT overwrite existing permissions
          create: {
            role,
            permission: permission.key,
            enabled: DEFAULTS[role].includes(permission.key),
          },
        });
      }
    }
  });
  invalidatePermissionCache();
}

async function getPermissionsForUser(actor,db=prisma) {
  return require('./custom-role-policy').resolveUserPermissions(db,actor);
}

async function getPermissionsForRole(role) {
  if (!ROLE_VALUES.includes(role)) {
    return [];
  }

  // Admission is the READ COMMITTED statement snapshot of this primary read.
  // An in-flight read may retain its snapshot, but cannot publish shared grants
  // for later requests. No cache, coalescing, retry, replica or extra locks.
  const rows = await prisma.rolePermission.findMany({
    where: { role, enabled: true },
    select: { permission: true },
  });

  return effectivePermissions(role, rows.map(row => row.permission));
}

// Use only the caller's transaction, after the admin guard has locked its actor.
// No role cache and no implicit seeding; complete enabled arrays for all roles.
async function readAdminContext(tx, actorId) {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, isActive: true } });
  const rows = await tx.rolePermission.findMany({ where: { enabled: true }, select: { role: true, permission: true }, orderBy: [{ role: 'asc' }, { permission: 'asc' }] });
  const enabledByRole = Object.fromEntries(ROLE_VALUES.map(role => [role, []]));
  for (const row of rows) {
    if (!Object.hasOwn(enabledByRole, row.role)) throw Object.assign(new Error('Administration authorization context cannot be verified.'), { status: 409 });
    enabledByRole[row.role].push(row.permission);
  }
  const actorPermissions=await getPermissionsForUser(actor,tx);
  return createAdminContext({ actor, enabledByRole, actorPermissions });
}

function publishPermissionChange(app, role, userId) {
  // Database commit has already succeeded. A failed notification must not make
  // an administrative write appear rolled back or invite an automatic retry.
  invalidatePermissionCache();
  try {
    const service = app.get('io')?.posSecurity;
    if (service) {
      if (userId) void service.revalidateUser(userId).catch(() => {});
      void service.publish('permissions:changed').catch(() => {});
    }
  }
  catch { console.error('Administration refresh notification failed.'); }
}

module.exports = {
  prisma,
  PERMISSIONS,
  DEFAULTS,
  ensureDefaults,
  getPermissionsForRole,
  getPermissionsForUser,
  invalidatePermissionCache,
  readAdminContext,
  publishPermissionChange,
};
