/**
 * ProxyService - Proxy Management & Rotation
 *
 * Handles proxy list management and round-robin rotation for requests.
 * Supports multiple proxy providers or direct IP binding.
 *
 * Usage:
 *   const proxyService = new ProxyService(['http://proxy1:8080', 'http://proxy2:8080']);
 *   const nextProxy = proxyService.getNextProxy();
 */

class ProxyService {
  /**
   * Initialize ProxyService
   * @param {Object} config - Configuration object
   * @param {Array<string>} config.proxies - List of proxy URLs
   * @param {Function} config.logger - Logger function
   */
  constructor(config = {}) {
    this.config = {
      proxies: config.proxies || [],
      logger: config.logger || this._defaultLogger,
    };

    // Round-robin state
    this.currentIndex = 0;

    // Metrics
    this.stats = {
      totalRequests: 0,
      rotations: 0,
    };
  }

  /**
   * Default logger (no-op)
   * @private
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    const prefix = `[ProxyService:${level.toUpperCase()}]`;
    console.log(prefix, message, data ? JSON.stringify(data, null, 2) : '');
  }

  /**
   * Get next proxy in round-robin rotation
   * @returns {string|null} Proxy URL or null if no proxies configured
   */
  getNextProxy() {
    if (this.config.proxies.length === 0) {
      return null;
    }

    this.stats.totalRequests++;

    const proxy = this.config.proxies[this.currentIndex];

    // Advance to next index (wrap around)
    this.currentIndex = (this.currentIndex + 1) % this.config.proxies.length;

    // Track rotations (when we wrap back to 0)
    if (this.currentIndex === 0 && this.config.proxies.length > 1) {
      this.stats.rotations++;
      this.config.logger('debug', 'ProxyService: Rotation cycle complete', {
        totalRequests: this.stats.totalRequests,
      });
    }

    return proxy;
  }

  /**
   * Get current proxy without advancing
   * @returns {string|null} Current proxy URL or null
   */
  getCurrentProxy() {
    if (this.config.proxies.length === 0) {
      return null;
    }
    return this.config.proxies[this.currentIndex];
  }

  /**
   * Reset rotation to start
   */
  reset() {
    this.currentIndex = 0;
    this.stats.rotations = 0;
    this.stats.totalRequests = 0;
    this.config.logger('info', 'ProxyService: Rotation reset');
  }

  /**
   * Set new proxy list
   * @param {Array<string>} proxies - New proxy list
   */
  setProxies(proxies) {
    this.config.proxies = proxies || [];
    this.currentIndex = 0;
    this.config.logger('info', 'ProxyService: Proxy list updated', {
      count: proxies.length,
    });
  }

  /**
   * Get proxy list size
   * @returns {number}
   */
  getProxyCount() {
    return this.config.proxies.length;
  }

  /**
   * Get service status
   * @returns {Object}
   */
  getStatus() {
    return {
      proxyCount: this.config.proxies.length,
      currentIndex: this.currentIndex,
      currentProxy: this.getCurrentProxy(),
      stats: { ...this.stats },
    };
  }
}

module.exports = ProxyService;
