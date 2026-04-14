/**
 * ⚠️  DEPRECATED: ProxyService
 *
 * This module is deprecated and no longer used in Phase 1 architecture.
 * Its functionality has been replaced by:
 * - ProxyProvider (src/services/proxy.provider.js) - Abstract interface
 * - RoundRobinProvider - Round-robin proxy rotation
 * - LocalIPProvider - Local IP binding via ProxyProvider
 * - NoProxyProvider - Direct connection (no proxy)
 *
 * DEPRECATION POLICY: This code will be removed in v2.0
 * See PHASE_1_CONTRACT_FIXES.md for migration guide.
 *
 * DO NOT use in new code. Use ProxyProvider hierarchy instead.
 *
 * STRICT MODE: This module is completely blocked from loading and use.
 * All access attempts will throw immediately.
 */

const DeprecatedError = new Error(
  'ProxyService is DEPRECATED and removed from Phase 1 architecture.\n' +
  'Use ProxyProvider (src/services/proxy.provider.js) hierarchy instead.\n' +
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
