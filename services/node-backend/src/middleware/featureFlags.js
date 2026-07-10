import { getFlagsForRole, getDefaultFlags } from '../services/unleashService.js';
import logger from '../config/logger.js';

/**
 * Middleware that attaches feature flags to req.flags
 * based on the user's Keycloak realm role.
 * Must be used AFTER keycloakAuthMiddleware.
 */
export const attachFeatureFlags = (req, res, next) => {
  try {
    if (!req.user) {
      req.flags = getDefaultFlags('guest');
      return next();
    }

    const roles = req.user.roles || [];

    // Pick the most privileged role present
    const role =
      roles.find(r => ['platform-admin', 'admin-internal'].includes(r)) ||
      roles.find(r => ['merchant-admin', 'merchant-staff', 'merchant-amazon', 'merchant-flipkart'].includes(r)) ||
      roles.find(r => ['alumni-verified', 'alumni'].includes(r)) ||
      roles[0] ||
      'guest';

    req.flags = getFlagsForRole(role, req.user.userId);

    logger.debug(`Flags for ${req.user.email} (${role}): ${JSON.stringify(req.flags)}`);

    next();
  } catch (err) {
    logger.warn(`featureFlags middleware error: ${err.message}`);
    req.flags = getDefaultFlags('guest');
    next();
  }
};