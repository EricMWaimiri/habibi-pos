
const {
  getPermissionsForUser,
} = require('../utils/permissions');

/**
 * Load the current user's enabled permissions onto the request.
 * Must run after authentication middleware.
 */
async function loadPermissions(req, res, next) {
  try {
    const role = req.user?.role;

    if (!role) {
      return res.status(401).json({
        message: 'Authentication required',
      });
    }

    req.permissions = await getPermissionsForUser(req.user);
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Protect a route using a specific permission key.
 * Example: router.post('/', authenticate, can('sales.make'), handler)
 */
function can(...permissionKeys) {
  return async function permissionCheck(req, res, next) {
    try {
      const role = req.user?.role;

      if (!role) {
        return res.status(401).json({ message: 'Authentication required' });
      }

      const permissions =
        Array.isArray(req.permissions)
          ? req.permissions
          : await getPermissionsForUser(req.user);

      // Check if the user has AT LEAST ONE of the required permissions
      const hasPermission = permissionKeys.some(key => permissions.includes(key));
      // Reuse server-resolved grants for response projection, including writes.
      req.permissions = permissions;

      if (!hasPermission) {
        return res.status(403).json({
          message: 'Permission denied',
          required: permissionKeys.join(' OR '),
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  loadPermissions,
  can,
};
