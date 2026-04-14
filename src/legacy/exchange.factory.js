/**
 * ⚠️  DEPRECATED: ExchangeFactory
 *
 * This module is deprecated and no longer used in Phase 1 architecture.
 * Its functionality has been split across:
 * - CCXTAdapter (src/adapters/ccxt.adapter.js) - CCXT instance creation
 * - ProxyProvider (src/services/proxy.provider.js) - Proxy management
 * - Strategies in src/adapters/strategies/*.js - Watch strategy patterns
 *
 * DEPRECATION POLICY: This code will be removed in v2.0
 * See PHASE_1_CONTRACT_FIXES.md for migration guide.
 *
 * DO NOT use in new code. Use CCXTAdapter and ProxyProvider instead.
 *
 * STRICT MODE: This module is completely blocked from loading and use.
 * All access attempts will throw immediately.
 */

const DeprecatedError = new Error(
  'ExchangeFactory is DEPRECATED and removed from Phase 1 architecture.\n' +
  'Use CCXTAdapter (src/adapters/ccxt.adapter.js) and ProxyProvider instead.\n' +
  'Migration guide: See PHASE_1_CONTRACT_FIXES.md'
);

// Create a blocking proxy that rejects ALL operations
const blockingProxy = new Proxy(function() {}, {
  get: () => { throw DeprecatedError; },
  construct: () => { throw DeprecatedError; },
  apply: () => { throw DeprecatedError; },
  has: () => { throw DeprecatedError; },
  ownKeys: () => { throw DeprecatedError; },
  getOwnPropertyDescriptor: () => { throw DeprecatedError; },
  defineProperty: () => { throw DeprecatedError; },
  deleteProperty: () => { throw DeprecatedError; },
  set: () => { throw DeprecatedError; },
});

module.exports = blockingProxy;
