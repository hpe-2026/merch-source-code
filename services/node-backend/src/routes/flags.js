import express from 'express';
import { keycloakAuthMiddleware } from '../middleware/keycloak.js';
import { attachFeatureFlags } from '../middleware/featureFlags.js';
import logger from '../config/logger.js';

const router = express.Router();

/**
 * GET /api/v1/flags
 * Returns the feature flags applicable to the logged-in user,
 * based on their Keycloak realm role.
 */
router.get('/', keycloakAuthMiddleware, attachFeatureFlags, (req, res) => {
  try {
    res.json({
      success: true,
      role: req.user?.roles || [],
      flags: req.flags,
    });
  } catch (err) {
    logger.error(`/api/v1/flags error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch feature flags' });
  }
});

export default router;