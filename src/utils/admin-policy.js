'use strict';

// Pure authorization policy; no persistence, environment reads
// or permission-cache access. Build context from fresh trusted transaction reads
// inside the 3.3A guard, NEVER from request/JWT-supplied roles or grants.
const { timingSafeEqual } = require('node:crypto');
const { z } = require('zod');
const { hashPin } = require('./pin');
const { PERMISSIONS, ROLE_VALUES, MANDATORY_MANAGER_PERMISSIONS } = require('./permission-definitions');
const knownPermissions = new Set(PERMISSIONS.map(p => p.key));
const contexts = new WeakSet();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const unavailable = () => fail(409, 'Administration authorization context cannot be verified. Refresh and retry.');
const denied = () => fail(403, 'This administration action is not permitted.');
const invalid = () => fail(400, 'Invalid administration change.');
const own = (value, key) => Object.hasOwn(value, key);

function effectivePermissions(role, enabledKeys) {
  if (!ROLE_VALUES.includes(role) || !Array.isArray(enabledKeys) || Array.from(enabledKeys).some(key => typeof key !== 'string' || !knownPermissions.has(key))) unavailable();
  const keys = new Set(enabledKeys);
  if (role === 'MANAGER') for (const key of MANDATORY_MANAGER_PERMISSIONS) keys.add(key);
  else keys.delete('permissions.manage');
  return Object.freeze([...keys].sort());
}

function account(value) {
  if (!value || typeof value !== 'object' || ['id', 'role', 'isActive'].some(key => !own(value, key) || !own(Object.getOwnPropertyDescriptor(value, key), 'value')) || typeof value.id !== 'string' || !value.id.trim() ||
      !ROLE_VALUES.includes(value.role) || typeof value.isActive !== 'boolean') unavailable();
  return Object.freeze({ id: value.id, role: value.role, isActive: value.isActive });
}

/** enabledByRole must contain complete enabled-key arrays for ALL three roles.
 * Empty arrays explicitly mean no stored enabled grants; missing/unknown data
 * never defaults to ordinary staff. Freshness is the integrating caller's duty.
 * Only identity and effective keys enter this immutable snapshot, never secrets.
 */
function createAdminContext(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ['actor', 'enabledByRole'].some(key => !own(input, key) || !own(Object.getOwnPropertyDescriptor(input, key), 'value'))) unavailable();
  const { actor, enabledByRole } = input;
  const identity = account(actor);
  if (!identity.isActive) denied();
  if (!enabledByRole || typeof enabledByRole !== 'object' || Array.isArray(enabledByRole) ||
      Object.keys(enabledByRole).some(role => !ROLE_VALUES.includes(role))) unavailable();
  const permissions = {};
  for (const role of ROLE_VALUES) {
    if (!own(enabledByRole, role) || !own(Object.getOwnPropertyDescriptor(enabledByRole, role), 'value')) unavailable();
    permissions[role] = effectivePermissions(role, enabledByRole[role]);
  }
  const actorPermissions = input.actorPermissions === undefined ? permissions[identity.role] : input.actorPermissions;
  if (!Array.isArray(actorPermissions) || actorPermissions.some(key => !permissions[identity.role].includes(key)) || (identity.role === 'MANAGER' && MANDATORY_MANAGER_PERMISSIONS.some(key => !actorPermissions.includes(key)))) unavailable();
  const context = Object.freeze({ actor: identity, actorPermissions: Object.freeze([...new Set(actorPermissions)].sort()), permissions: Object.freeze(permissions) });
  contexts.add(context);
  return context;
}

function requirePermission(context, permission) {
  if (!contexts.has(context)) unavailable();
  if (!context.actor.isActive || !context.actorPermissions.includes(permission)) denied();
}
function requireManager(context, permission) {
  requirePermission(context, permission);
  if (context.actor.role !== 'MANAGER') denied();
}
function checkedTarget(context, target) {
  if (!contexts.has(context)) unavailable();
  const value = account(target);
  if (value.id === context.actor.id && (value.role !== context.actor.role || value.isActive !== context.actor.isActive)) unavailable();
  return value;
}
function isProtectedAccount(context, target) {
  const value = checkedTarget(context, target);
  return value.role === 'MANAGER' || context.permissions[value.role].some(key => key === 'users.manage' || key === 'permissions.manage');
}
function requireOrdinaryScope(context, role) {
  if (role === 'MANAGER' || context.permissions[role].some(key => key === 'users.manage' || key === 'permissions.manage')) denied();
  const actorKeys = context.actorPermissions;
  if (!context.permissions[role].every(key => actorKeys.includes(key))) denied();
}

const role = z.enum(ROLE_VALUES);
const name = z.string().min(2).max(100).refine(value => value.trim().length >= 2);
const pin = z.string().regex(/^\d{4,6}$/);
const rate = z.number().finite().min(0).max(100);
const createSchema = z.strictObject({ name, role, pin: pin.optional(), payrollOnly:z.boolean().optional(), commissionRate: rate.optional() }).refine(v=>v.payrollOnly===true?v.pin===undefined:v.pin!==undefined,'Choose a PIN account or payroll-only employee, not both.');
const changeSchema = z.strictObject({ name: name.optional(), role: role.optional(), pin: pin.optional(),
  currentPin: pin.optional(), isActive: z.boolean().optional(), commissionRate: rate.optional() });
const permissionSchema = z.strictObject({ role, permissions: z.array(z.strictObject({ permission: z.string(), enabled: z.boolean() })).min(1).max(PERMISSIONS.length) });

function parse(schema, input) {
  // Reject explicit undefined and accessor properties as well as unknown keys;
  // return only fixed errors, never Zod issues containing submitted credentials.
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' || !own(Object.getOwnPropertyDescriptor(input, key), 'value') || input[key] === undefined)) invalid();
  const result = schema.safeParse(input);
  if (!result.success) invalid();
  return result.data;
}

function plan(action, input, credentialAction = null) {
  // This is a decision descriptor, NOT ORM data or an API payload containing PINs.
  // Caller keeps request credentials transient, hashes only after authorization,
  // and writes explicitly allowed noncredential fields within the guarded tx.
  const fields = Object.keys(input).filter(key => key !== 'pin' && key !== 'currentPin').sort();
  return Object.freeze({ action, fields: Object.freeze(fields), changes: Object.freeze(Object.fromEntries(fields.map(key => [key, input[key]]))), credentialAction });
}

// Syntax-only entry points for rejecting whole payloads before acquiring locks.
// They deliberately return no credential-bearing parsed object.
function validateCreateUserInput(input) { parse(createSchema, input); }
function validateUserChangeInput(input) {
  const data = parse(changeSchema, input);
  if (!Object.keys(data).length || (own(data, 'currentPin') && !own(data, 'pin'))) invalid();
}
function validatePermissionChangeInput(input) { parse(permissionSchema, input); }
function authorizeUserList(context) { requirePermission(context, 'users.manage'); return true; }

function requireCreationRole(context, destinationRole) {
  requirePermission(context, 'users.manage');
  if (!ROLE_VALUES.includes(destinationRole)) unavailable();
  if (destinationRole === 'MANAGER') requireManager(context, 'users.manage');
  else if (context.actor.role !== 'MANAGER') requireOrdinaryScope(context, destinationRole);
  return destinationRole;
}

// Shared by write authorization and UI metadata; never accepts client grants.
function editableUserFields(context, target) {
  requirePermission(context, 'users.manage');
  const current = checkedTarget(context, target);
  if (current.id === context.actor.id) return ['name', 'pin'];
  if (context.actor.role !== 'MANAGER') {
    if (isProtectedAccount(context, current)) denied();
    requireOrdinaryScope(context, current.role);
    return ['name', 'isActive', 'commissionRate'];
  }
  requireManager(context, 'users.manage');
  return ['name', 'role', 'pin', 'isActive', 'commissionRate'];
}

function administrationMetadata(context, targets) {
  requirePermission(context, 'users.manage');
  if (!Array.isArray(targets)) unavailable();
  const allowed = work => {
    try { return work(); } catch (error) { if (error.status === 403) return null; throw error; }
  };
  const createRoles = ROLE_VALUES.filter(role => allowed(() => requireCreationRole(context, role)) !== null);
  return Object.freeze({ actorId: context.actor.id, canCreate: createRoles.length > 0,
    createRoles: Object.freeze(createRoles),
    targets: Object.freeze(Object.fromEntries(targets.map(target => {
      const current = checkedTarget(context, target);
      const fields = allowed(() => editableUserFields(context, current)) || [];
      return [current.id, Object.freeze({ canEdit: fields.length > 0, editableFields: Object.freeze(fields),
        canChangeRole: fields.includes('role'), canResetPin: current.id !== context.actor.id && fields.includes('pin'),
        requiresCurrentPin: current.id === context.actor.id && fields.includes('pin') })];
    }))),
  });
}

function authorizeCreateUser(context, input) {
  requirePermission(context, 'users.manage');
  const data = parse(createSchema, input);
  requireCreationRole(context, data.role);
  if(data.payrollOnly===true){requireManager(context,'users.manage');if(data.role==='MANAGER')denied();const {payrollOnly,...values}=data;return plan('create-user',values,'payroll-only-no-login');}
  const {payrollOnly,...values}=data;return plan('create-user', values, 'initial-pin');
}

function verifySelfPin(data, credentials) {
  if (!own(data, 'currentPin')) denied();
  if (!credentials || typeof credentials.currentPinHash !== 'string' || !/^[a-f0-9]{64}$/i.test(credentials.currentPinHash) ||
      typeof credentials.pinPepper !== 'string' || !credentials.pinPepper) unavailable();
  const supplied = Buffer.from(hashPin(data.currentPin, credentials.pinPepper), 'hex');
  if (!timingSafeEqual(supplied, Buffer.from(credentials.currentPinHash, 'hex'))) denied();
}

function authorizeUserChanges(context, target, input, credentials) {
  requirePermission(context, 'users.manage');
  const current = checkedTarget(context, target);
  const data = parse(changeSchema, input);
  if (!Object.keys(data).length || (own(data, 'currentPin') && !own(data, 'pin'))) invalid();
  const self = current.id === context.actor.id;
  const fields = editableUserFields(context, current);
  if (Object.keys(data).some(key => key !== 'currentPin' && !fields.includes(key))) denied();
  if (self) {
    if (own(data, 'pin')) verifySelfPin(data, credentials);
  } else {
    if (own(data, 'currentPin')) invalid();
  }
  return plan('update-user', data, own(data, 'pin') ? (self ? 'self-pin' : 'reset-pin') : null);
}

function authorizePermissionMatrixRead(context) {
  requireManager(context, 'permissions.manage');
  return true;
}
function authorizePermissionChanges(context, input) {
  requireManager(context, 'permissions.manage');
  const data = parse(permissionSchema, input);
  const seen = new Set();
  for (const item of data.permissions) {
    if (!knownPermissions.has(item.permission) || seen.has(item.permission)) invalid();
    seen.add(item.permission);
    if (data.role !== 'MANAGER' && item.permission === 'permissions.manage' && item.enabled) denied();
    if (data.role === 'MANAGER' && MANDATORY_MANAGER_PERMISSIONS.includes(item.permission) && !item.enabled) invalid();
  }
  return Object.freeze({ role: data.role, permissions: Object.freeze(data.permissions.map(item => Object.freeze({ ...item })).sort((a, b) => a.permission.localeCompare(b.permission))) });
}

module.exports = { effectivePermissions, createAdminContext, requireManager, isProtectedAccount, authorizeCreateUser,
  authorizeUserChanges, authorizePermissionMatrixRead, authorizePermissionChanges, authorizeUserList,
  validateCreateUserInput, validateUserChangeInput, validatePermissionChangeInput, administrationMetadata };
