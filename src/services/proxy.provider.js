/**
 * ProxyProvider - Abstract Provider Interface
 *
 * Allows pluggable proxy strategies:
 * - NoProxyProvider: Direct connection (no proxy)
 * - RoundRobinProvider: Simple list rotation
 * - LocalIPProvider: Bind to specific local IPs
 * - OxylabsProvider: Redis-cached pool with API rotation
 *
 * Usage:
 *   const provider = new RoundRobinProvider(proxyList, config);
 *   const proxy = await provider.getNextProxy();
 *   await provider.reportRotationTrigger('403');
 */

/**
 * Abstract proxy provider interface
 */
class ProxyProvider {
  /**
   * Get next proxy configuration
   * @returns {Promise<Object|null>} {protocol, host, port, auth} or null for direct
   */
  async getNextProxy() {
    throw new Error('getNextProxy() must be implemented by subclass');
  }

  /**
   * Report that a proxy failed with a specific reason
   * May trigger rotation or fallback
   * @param {string} reason - 'timeout'|'403'|'429'|'socket'|'dns'|'other'
   */
  async reportRotationTrigger(reason) {
    throw new Error('reportRotationTrigger() must be implemented by subclass');
  }

  /**
   * Close provider gracefully
   */
  async close() {
    throw new Error('close() must be implemented by subclass');
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    throw new Error('getMetrics() must be implemented by subclass');
  }
}

/**
 * NoProxyProvider - No proxy, direct connection
 */
class NoProxyProvider extends ProxyProvider {
  async getNextProxy() {
    return null;
  }

  async reportRotationTrigger(reason) {
    // No-op
  }

  async close() {
    // No-op
  }

  getMetrics() {
    return { type: 'none', active: null };
  }
}

/**
 * RoundRobinProvider - Simple round-robin proxy rotation
 */
class RoundRobinProvider extends ProxyProvider {
  constructor(proxies = [], config = {}) {
    super();
    this.proxies = proxies; // Array of {protocol, host, port, auth}
    this.config = {
      logger: config.logger || this._defaultLogger,
      ...config,
    };
    this.currentIndex = 0;
    this.metrics = {
      type: 'round-robin',
      totalProxies: proxies.length,
      failedProxies: 0,
      rotationCount: 0,
      currentProxy: proxies.length > 0 ? 0 : null,
    };
  }

  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[ProxyProvider:${level.toUpperCase()}] ${message}`, data || '');
  }

  async getNextProxy() {
    if (this.proxies.length === 0) {
      return null;
    }

    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    this.metrics.currentProxy = this.currentIndex;

    this.config.logger('debug', `RoundRobinProvider: Returning proxy`, {
      index: this.currentIndex,
      host: proxy.host,
    });

    return proxy;
  }

  async reportRotationTrigger(reason) {
    this.metrics.rotationCount++;
    this.config.logger('warn', `RoundRobinProvider: Rotation triggered`, {
      reason,
      rotationCount: this.metrics.rotationCount,
    });
  }

  async close() {
    this.config.logger('info', `RoundRobinProvider: Closed`);
  }

  getMetrics() {
    return { ...this.metrics };
  }
}

/**
 * LocalIPProvider - Rotate through local IP bindings
 */
class LocalIPProvider extends ProxyProvider {
  constructor(localIps = [], config = {}) {
    super();
    this.localIps = localIps; // Array of IP addresses
    this.config = {
      logger: config.logger || this._defaultLogger,
      ...config,
    };
    this.currentIndex = 0;
    this.metrics = {
      type: 'local-ip',
      totalIps: localIps.length,
      currentIp: localIps.length > 0 ? localIps[0] : null,
      rotationCount: 0,
    };
  }

  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[ProxyProvider:${level.toUpperCase()}] ${message}`, data || '');
  }

  async getNextProxy() {
    if (this.localIps.length === 0) {
      return null;
    }

    const ip = this.localIps[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.localIps.length;
    this.metrics.currentIp = ip;

    // Return proxy config with local IP binding
    return {
      protocol: 'http',
      host: ip,
      port: null, // Binding to local IP, not a proxy
      localAddress: ip, // This tells Node to bind to this IP
    };
  }

  async reportRotationTrigger(reason) {
    this.metrics.rotationCount++;
    this.config.logger('warn', `LocalIPProvider: Rotation triggered`, {
      reason,
      currentIp: this.metrics.currentIp,
    });
  }

  async close() {
    this.config.logger('info', `LocalIPProvider: Closed`);
  }

  getMetrics() {
    return { ...this.metrics };
  }
}

module.exports = {
  ProxyProvider,
  NoProxyProvider,
  RoundRobinProvider,
  LocalIPProvider,
};
