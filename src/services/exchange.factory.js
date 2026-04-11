/**
 * ExchangeFactory - CCXT Pro Exchange Instantiation & Normalization
 *
 * Responsible for:
 * - Creating CCXT Pro exchange instances with proper configuration
 * - Applying exchange-specific normalization rules to ticker payloads
 * - Supporting local IPv4 binding via https.Agent
 * - Managing market filtering and caching
 *
 * Usage:
 *   const factory = new ExchangeFactory({ exchange: 'binance', marketType: 'spot' });
 *   const exchangeInstance = factory.createExchange();
 *   const normalized = factory.normalizeTicker('BTC/USDT', rawTicker);
 */

const https = require('https');

/**
 * Exchange-specific field mappings for ticker normalization
 * Maps raw exchange fields to normalized schema
 */
const EXCHANGE_NORMALIZATION_RULES = {
  binance: {
    symbol: 'symbol',
    last: 'last',
    bid: 'bid',
    ask: 'ask',
    bidVolume: 'bidVolume',
    askVolume: 'askVolume',
    high: 'high',
    low: 'low',
    open: 'open',
    close: 'close',
    previousClose: 'previousClose',
    change: 'change',
    percentage: 'percentage',
    average: 'average',
    baseVolume: 'baseVolume',
    quoteVolume: 'quoteVolume',
    vwap: 'vwap',
    timestamp: 'timestamp',
  },
  bybit: {
    symbol: 'symbol',
    last: 'last',
    bid: 'bid',
    ask: 'ask',
    bidVolume: 'bidVolume',
    askVolume: 'askVolume',
    high: 'high',
    low: 'low',
    open: 'open',
    close: 'close',
    baseVolume: 'baseVolume',
    quoteVolume: 'quoteVolume',
    timestamp: 'timestamp',
  },
  kraken: {
    symbol: 'symbol',
    last: 'last',
    bid: 'bid',
    ask: 'ask',
    high: 'high',
    low: 'low',
    open: 'open',
    close: 'close',
    baseVolume: 'baseVolume',
    quoteVolume: 'quoteVolume',
    timestamp: 'timestamp',
  },
  // Fallback for unmapped exchanges
  default: {
    symbol: 'symbol',
    last: 'last',
    bid: 'bid',
    ask: 'ask',
    timestamp: 'timestamp',
  },
};

/**
 * Exchange-specific transformations after mapping
 * Handles special cases and computed fields
 */
const EXCHANGE_TRANSFORMS = {
  binance: (ticker) => {
    // Binance tick data is usually complete
    return ticker;
  },
  bybit: (ticker) => {
    // Bybit may have bid1/ask1 instead of bid/ask
    if (!ticker.bid && ticker.info && ticker.info.bid1) {
      ticker.bid = parseFloat(ticker.info.bid1);
    }
    if (!ticker.ask && ticker.info && ticker.info.ask1) {
      ticker.ask = parseFloat(ticker.info.ask1);
    }
    return ticker;
  },
  kraken: (ticker) => {
    // Kraken uses different naming
    return ticker;
  },
};

class ExchangeFactory {
  /**
   * Initialize ExchangeFactory
   * @param {Object} config - Configuration
   * @param {string} config.exchange - Exchange name (binance, bybit, kraken)
   * @param {string} config.marketType - Market type (spot or swap)
   * @param {ProxyService} config.proxyService - ProxyService instance (optional)
   * @param {Array<string>} config.localIps - Local IPs for binding (optional)
   * @param {Function} config.logger - Logger function
   */
  constructor(config = {}) {
    // Validate exchange is provided
    if (!config.exchange) {
      throw new Error('ExchangeFactory: exchange is required');
    }

    this.config = {
      exchange: config.exchange.toLowerCase(),
      marketType: (config.marketType || 'spot').toLowerCase(),
      proxyService: config.proxyService || null,
      localIps: config.localIps || [],
      logger: config.logger || this._defaultLogger,
    };

    // State
    this.localIpIndex = 0;
    this.exchangeInstance = null;

    // Validate market type
    if (!['spot', 'swap'].includes(this.config.marketType)) {
      throw new Error('ExchangeFactory: marketType must be spot or swap');
    }

    this.config.logger('info', 'ExchangeFactory: Initialized', {
      exchange: this.config.exchange,
      marketType: this.config.marketType,
      localIps: this.config.localIps.length,
    });
  }

  /**
   * Default logger (no-op)
   * @private
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    const prefix = `[ExchangeFactory:${level.toUpperCase()}]`;
    console.log(prefix, message, data ? JSON.stringify(data, null, 2) : '');
  }

  /**
   * Create CCXT Pro exchange instance
   * @param {Object} overrideOptions - Optional override options for exchange
   * @returns {Object} CCXT exchange instance
   */
  createExchange(overrideOptions = {}) {
    // Import CCXT dynamically
    const ccxt = require('ccxt').pro;

    if (!ccxt[this.config.exchange]) {
      throw new Error(`ExchangeFactory: Exchange '${this.config.exchange}' not supported by CCXT`);
    }

    // Build exchange options
    const options = {
      enableRateLimit: true,
      rateLimit: 100, // ms between requests
      ...overrideOptions,
    };

    // Apply local IP binding if available
    if (this.config.localIps.length > 0) {
      const localIp = this._getNextLocalIp();
      const agent = this._createHttpsAgent(localIp);

      options.agent = agent;
      options.httpAgent = agent;
      options.httpsAgent = agent;

      this.config.logger('debug', 'ExchangeFactory: Binding to local IP', { localIp });
    }

    // Apply proxy if available
    if (this.config.proxyService) {
      const proxy = this.config.proxyService.getNextProxy();
      if (proxy) {
        options.proxy = proxy;
        this.config.logger('debug', 'ExchangeFactory: Using proxy', { proxy });
      }
    }

    // Create exchange instance
    try {
      const ExchangeClass = ccxt[this.config.exchange];
      this.exchangeInstance = new ExchangeClass(options);

      this.config.logger('info', 'ExchangeFactory: Exchange instance created', {
        exchange: this.config.exchange,
        rateLimit: options.rateLimit,
      });

      return this.exchangeInstance;
    } catch (error) {
      this.config.logger('error', 'ExchangeFactory: Failed to create exchange', {
        message: error.message,
      });
      throw error;
    }
  }

  /**
   * Get the current exchange instance
   * @returns {Object|null}
   */
  getExchange() {
    return this.exchangeInstance;
  }

  /**
   * Normalize a ticker payload to standard schema
   * @param {string} symbol - Trading symbol
   * @param {Object} rawTicker - Raw ticker from exchange
   * @returns {Object} Normalized ticker
   */
  normalizeTicker(symbol, rawTicker) {
    if (!rawTicker) {
      return null;
    }

    // Get normalization rules for this exchange (or default)
    const rules = EXCHANGE_NORMALIZATION_RULES[this.config.exchange] ||
                  EXCHANGE_NORMALIZATION_RULES.default;

    // Start with normalized data
    const normalized = {
      symbol,
      exchange: this.config.exchange,
      marketType: this.config.marketType,
    };

    // Map fields according to rules
    for (const [normalizedField, rawField] of Object.entries(rules)) {
      if (normalizedField === 'symbol') continue; // Already set
      const value = rawTicker[rawField];
      if (value !== undefined && value !== null) {
        normalized[normalizedField] = value;
      }
    }

    // Ensure timestamp is set
    if (!normalized.timestamp && rawTicker.timestamp) {
      normalized.timestamp = rawTicker.timestamp;
    }
    if (!normalized.timestamp) {
      normalized.timestamp = Date.now();
    }

    // Apply exchange-specific transforms
    const transform = EXCHANGE_TRANSFORMS[this.config.exchange];
    if (transform) {
      Object.assign(normalized, transform(normalized));
    }

    return normalized;
  }

  /**
   * Load and filter markets from exchange
   * @returns {Promise<Array>} Filtered markets
   */
  async loadMarkets() {
    if (!this.exchangeInstance) {
      throw new Error('ExchangeFactory: Exchange not initialized. Call createExchange() first.');
    }

    try {
      const marketData = await this.exchangeInstance.loadMarkets();

      // CCXT returns an object keyed by symbol, convert to array
      const allMarkets = Array.isArray(marketData)
        ? marketData
        : Object.values(marketData);

      // Filter by market type
      const filtered = allMarkets.filter(market => {
        if (this.config.marketType === 'spot') {
          return market.spot === true;
        } else if (this.config.marketType === 'swap') {
          return market.swap === true || market.future === true;
        }
        return true;
      });

      // Further filter: only active markets
      const active = filtered.filter(market => market.active === true);

      this.config.logger('info', 'ExchangeFactory: Markets loaded', {
        total: allMarkets.length,
        filtered: filtered.length,
        active: active.length,
      });

      return active;
    } catch (error) {
      this.config.logger('error', 'ExchangeFactory: Failed to load markets', {
        message: error.message,
      });
      throw error;
    }
  }

  /**
   * Get next local IP for binding (round-robin)
   * @private
   * @returns {string}
   */
  _getNextLocalIp() {
    if (this.config.localIps.length === 0) {
      return null;
    }

    const ip = this.config.localIps[this.localIpIndex];
    this.localIpIndex = (this.localIpIndex + 1) % this.config.localIps.length;
    return ip;
  }

  /**
   * Create HTTPS agent with local IP binding
   * @private
   * @param {string} localIp - Local IP to bind to
   * @returns {https.Agent}
   */
  _createHttpsAgent(localIp) {
    return new https.Agent({
      localAddress: localIp,
      keepAlive: true,
      keepAliveMsecs: 1000,
    });
  }

  /**
   * Get normalization rules for this exchange
   * @returns {Object}
   */
  getNormalizationRules() {
    return EXCHANGE_NORMALIZATION_RULES[this.config.exchange] ||
           EXCHANGE_NORMALIZATION_RULES.default;
  }

  /**
   * Get service status
   * @returns {Object}
   */
  getStatus() {
    return {
      exchange: this.config.exchange,
      marketType: this.config.marketType,
      exchangeInitialized: this.exchangeInstance !== null,
      localIpCount: this.config.localIps.length,
      localIpIndex: this.localIpIndex,
      proxyServiceReady: this.config.proxyService !== null,
    };
  }
}

module.exports = ExchangeFactory;
