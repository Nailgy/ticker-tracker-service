/**
 * CCXTAdapter - CCXT Pro Implementation of ExchangeAdapter
 *
 * Wraps CCXT Pro exchange instances and applies watch strategy pattern.
 * This is the ONLY place where CCXT Pro is directly used.
 *
 * Usage:
 *   const adapter = new CCXTAdapter({
 *     exchange: 'binance',
 *     marketType: 'spot',
 *     strategy: 'allTickers',
 *     logger: (level, msg, data) => console.log(msg),
 *     proxyProvider: proxyProvider // optional
 *   });
 *   await adapter.initialize();
 *   const subscription = await adapter.subscribe(['BTC/USDT']);
 */

const ExchangeAdapter = require('./exchange.adapter');
const AllTickersStrategy = require('./strategies/all-tickers.strategy');
const PerSymbolStrategy = require('./strategies/per-symbol.strategy');
const https = require('https');

// Lazy load CCXT to avoid issues if not installed
let ccxt;
function getCCXT() {
  if (!ccxt) {
    ccxt = require('ccxt').pro;
  }
  return ccxt;
}

class CCXTAdapter extends ExchangeAdapter {
  constructor(config) {
    super();
    this.config = {
      exchange: config.exchange,
      marketType: config.marketType || 'spot',
      strategy: config.strategy || 'allTickers',
      logger: config.logger || this._defaultLogger,
      proxyProvider: config.proxyProvider,
            ...config,
    };

    this.exchangeInstance = null;
    this.strategy = null;
    this.metrics = {
      subscriptionStatus: 'not-initialized',
      lastDataAt: null,
      symbolsSubscribed: 0,
      errorCount: 0,
      reconnectCount: 0,
    };
  }

  /**
   * Default logger
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[CCXTAdapter:${level.toUpperCase()}] ${message}`, data || '');
  }

  /**
   * Initialize - create CCXT instance and select strategy
   */
  async initialize() {
    try {
      this.config.logger('info', `CCXTAdapter: Initializing ${this.config.exchange}`, {
        exchange: this.config.exchange,
        marketType: this.config.marketType,
        strategy: this.config.strategy,
      });

      const ccxtLib = getCCXT();
      const ExchangeClass = ccxtLib[this.config.exchange];

      if (!ExchangeClass) {
        throw new Error(`Exchange ${this.config.exchange} not found in CCXT`);
      }

      // Create exchange instance with configuration
      const exchangeOptions = {
        enableRateLimit: true,
        // Note: CCXT Pro might need API credentials for some exchanges
        // We can add them here from config if needed
      };

      if (this.config.proxyProvider && typeof this.config.proxyProvider.getNextProxy === 'function') {
        const networkConfig = await this.config.proxyProvider.getNextProxy();
        if (networkConfig) {
          if (networkConfig.localAddress) {
            const agent = new https.Agent({
              localAddress: networkConfig.localAddress,
              keepAlive: true,
              keepAliveMsecs: 1000,
            });
            exchangeOptions.agent = agent;
            exchangeOptions.httpAgent = agent;
            exchangeOptions.httpsAgent = agent;
          }

          if (networkConfig.host && networkConfig.port) {
            const protocol = networkConfig.protocol || 'http';
            const auth = networkConfig.auth
              ? `${networkConfig.auth.username}:${networkConfig.auth.password}@`
              : '';
            exchangeOptions.proxy = `${protocol}://${auth}${networkConfig.host}:${networkConfig.port}`;
          }
        }
      }

      this.exchangeInstance = new ExchangeClass(exchangeOptions);

      // Select strategy based on what the exchange supports
      this._selectStrategy();

      this.metrics.subscriptionStatus = 'initialized';
      this.config.logger('info', `CCXTAdapter: Initialized successfully`, {
        exchange: this.config.exchange,
        selectedStrategy: this.strategy.constructor.name,
      });
    } catch (error) {
      this.metrics.subscriptionStatus = 'initialization-failed';
      this.config.logger('error', `CCXTAdapter: Initialization failed`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Select strategy based on exchange capabilities and config
   */
  _selectStrategy() {
    // Try AllTickersStrategy first (faster, more efficient)
    const allTickersStrategy = new AllTickersStrategy(this.config);
    if (allTickersStrategy.isSupported(this.exchangeInstance)) {
      this.strategy = allTickersStrategy;
      this.config.logger('debug', `CCXTAdapter: Selected AllTickersStrategy`);
      return;
    }

    // Fall back to PerSymbolStrategy
    const perSymbolStrategy = new PerSymbolStrategy(this.config);
    if (perSymbolStrategy.isSupported(this.exchangeInstance)) {
      this.strategy = perSymbolStrategy;
      this.config.logger('debug', `CCXTAdapter: Selected PerSymbolStrategy`);
      return;
    }

    throw new Error(`No suitable strategy found for ${this.config.exchange}`);
  }

  /**
   * Load available markets
   */
  async loadMarkets() {
    try {
      this.config.logger('debug', `CCXTAdapter: Loading markets`, {
        exchange: this.config.exchange,
      });

      const markets = await this.exchangeInstance.loadMarkets();
      let marketArray = Array.isArray(markets) ? markets : Object.values(markets);

      // Filter by market type
      if (this.config.marketType === 'spot') {
        marketArray = marketArray.filter(m => m.spot === true);
      } else if (this.config.marketType === 'swap') {
        marketArray = marketArray.filter(m => m.swap === true || m.future === true);
      }

      // Filter active only
      marketArray = marketArray.filter(m => m.active === true);

      this.config.logger('info', `CCXTAdapter: Markets loaded`, {
        exchange: this.config.exchange,
        marketType: this.config.marketType,
        total: Object.keys(markets).length,
        active: marketArray.length,
      });

      return marketArray;
    } catch (error) {
      this.config.logger('error', `CCXTAdapter: Market loading failed`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Subscribe to symbols using the selected strategy
   */
  async *subscribe(symbols) {
    if (!this.strategy) {
      throw new Error('Adapter not initialized - call initialize() first');
    }

    if (!symbols || symbols.length === 0) {
      throw new Error('Cannot subscribe to empty symbol list');
    }

    this.metrics.subscriptionStatus = 'subscribing';
    this.metrics.symbolsSubscribed = symbols.length;

    try {
      this.config.logger('info', `CCXTAdapter: Starting subscription`, {
        exchange: this.config.exchange,
        symbolCount: symbols.length,
        strategy: this.strategy.constructor.name,
      });

      for await (const { symbol, ticker } of this.strategy.execute(this.exchangeInstance, symbols)) {
        this.metrics.lastDataAt = Date.now();
        yield { symbol, ticker };
      }
    } catch (error) {
      this.metrics.errorCount++;
      this.metrics.subscriptionStatus = 'error';
      this.config.logger('error', `CCXTAdapter: Subscription error`, {
        error: error.message,
        errorName: error.name,
      });
      throw error;
    }
  }

  /**
   * Close adapter gracefully
   */
  async close() {
    try {
      this.config.logger('debug', `CCXTAdapter: Closing`, {
        exchange: this.config.exchange,
      });

      if (this.strategy && this.strategy.close) {
        await this.strategy.close();
      }

      if (this.exchangeInstance && this.exchangeInstance.close) {
        await this.exchangeInstance.close();
      }

      this.metrics.subscriptionStatus = 'closed';
      this.config.logger('info', `CCXTAdapter: Closed successfully`);
    } catch (error) {
      this.config.logger('warn', `CCXTAdapter: Error during close`, {
        error: error.message,
      });
    }
  }

  /**
   * Get exchange ID
   */
  getExchangeId() {
    return this.config.exchange;
  }

  /**
   * Get market type
   */
  getMarketType() {
    return this.config.marketType;
  }

  /**
   * Check if watchTickers is supported
   */
  isWatchTickersSupported() {
    return this.strategy instanceof AllTickersStrategy;
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    return { ...this.metrics };
  }
}

module.exports = CCXTAdapter;
