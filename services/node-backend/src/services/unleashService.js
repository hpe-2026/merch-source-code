import { initialize } from 'unleash-client';
import logger from '../config/logger.js';

const UNLEASH_URL = process.env.UNLEASH_URL || 'http://unleash:4242/api';
const UNLEASH_API_TOKEN = process.env.UNLEASH_API_TOKEN || 'default:development.unleash-insecure-api-token';

const unleash = initialize({
  url: UNLEASH_URL,
  appName: 'nitte-merch-shop',
  customHeaders: { Authorization: UNLEASH_API_TOKEN },
});

unleash.on('error', (err) => {
  logger.warn(`Unleash connection error: ${err.message} — falling back to defaults`);
});

unleash.on('synchronized', () => {
  logger.info('Unleash flags synchronized');
});

/**
 * Get all feature flags for a given role.
 * Falls back to safe defaults if Unleash is unreachable.
 */
export const getFlagsForRole = (role, userId = 'anonymous') => {
  const context = {
    userId,
    properties: { role },
  };

  try {
    return {
      showSupplierPages:  unleash.isEnabled('show-supplier-pages',  context, false),
      showShopPages:      unleash.isEnabled('show-shop-pages',      context, false),
      showAdminPages:     unleash.isEnabled('show-admin-pages',     context, false),
      showAddToCart:      unleash.isEnabled('show-add-to-cart',     context, false),
      showOrdersPage:     unleash.isEnabled('show-orders-page',     context, false),
      showSupplierNav:    unleash.isEnabled('show-supplier-nav',    context, false),
    };
  } catch (err) {
    logger.warn(`Flag evaluation failed, using defaults: ${err.message}`);
    return getDefaultFlags(role);
  }
};

/**
 * Fallback flags based purely on role — used when Unleash is down.
 */
export const getDefaultFlags = (role) => {
  const isMerchant = ['merchant-admin', 'merchant-staff', 'merchant-amazon', 'merchant-flipkart'].includes(role);
  const isAdmin    = ['platform-admin', 'admin-internal'].includes(role);
  const isAlumni   = ['alumni-verified', 'alumni'].includes(role);

  return {
    showSupplierPages:  isMerchant || isAdmin,
    showShopPages:      isAlumni   || isAdmin,
    showAdminPages:     isAdmin,
    showAddToCart:      isAlumni   || isAdmin,
    showOrdersPage:     isAlumni   || isAdmin,
    showSupplierNav:    isMerchant || isAdmin,
  };
};

export default unleash;