/**
 * ConnectionManager - WebSocket Subscription Coordination
 *
 * Manages active WebSocket subscriptions to exchange ticker streams.
 *
 * Responsibilities:
 * - Initialize and load available markets from exchange
 * - Batch symbols for efficient subscription management
 * - Maintain subscription loops for continuous ticker updates
 * - Normalize incoming tickers and persist to Redis
 * - Handle connection lifecycle (start, stop, cleanup)
 *
 * Usage:
 *   const manager = new ConnectionManager({
 *     exchangeFactory: factory,
 *     redisService: redis,
 *     batchSize: 100,
 *     logger: logger
 *   });
 *   await manager.initialize();
 *   await manager.startSubscriptions();
 *   // ... later ...
 *   await manager.stop();
 */

class ConnectionManager {
  /**
   * Initialize ConnectionManager
   * @param {Object} config - Configuration object
   * @param {ExchangeFactory} config.exchangeFactory - Exchange factory instance
   * @param {RedisService} config.redisService - Redis service instance
   * @param {number} config.batchSize - Number of symbols per batch (default 100)
   * @param {Function} config.logger - Logger function
   */
  constructor(config = {}) {
    this.config = {
      exchangeFactory: config.exchangeFactory,
      redisService: config.redisService,
      batchSize: config.batchSize || 100,
      logger: config.logger || this._defaultLogger,
    };

    if (!this.config.exchangeFactory) {
      throw new Error('ConnectionManager: exchangeFactory is required');
    }
    if (!this.config.redisService) {
      throw new Error('ConnectionManager: redisService is required');
    }

    // State
    this.exchange = null;
    this.symbols = [];
    this.batches = [];
    this.isRunning = false;
    this.subscriptionTasks = [];
    this.subscriptionTimers = [];

    // Metrics
    this.stats = {
      totalUpdates: 0,
      failedUpdates: 0,
      normalizationErrors: 0,
      batchesStarted: 0,
    };
  }

  /**
   * Default logger (no-op)
   * @private
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    const prefix = `[ConnectionManager:${level.toUpperCase()}]`;
    console.log(prefix, message, data ? JSON.stringify(data, null, 2) : '');
  }

  /**
   * Initialize: Load markets and create batches
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      // Create exchange instance
      this.exchange = this.config.exchangeFactory.createExchange();

      // Load available markets
      const markets = await this.config.exchangeFactory.loadMarkets();
      this.symbols = markets.map(m => m.symbol).sort();

      this.config.logger('info', 'ConnectionManager: Markets loaded', {
        totalSymbols: this.symbols.length,
      });

      // Create batches
      this._createBatches();

      this.config.logger('info', 'ConnectionManager: Batches created', {
        totalBatches: this.batches.length,
        symbolsPerBatch: this.config.batchSize,
      });
    } catch (error) {
      this.config.logger('error', 'ConnectionManager: Initialization failed', {
        message: error.message,
      });
      throw error;
    }
  }

  /**
   * Create symbol batches based on batchSize
   * @private
   */
  _createBatches() {
    this.batches = [];
    for (let i = 0; i < this.symbols.length; i += this.config.batchSize) {
      const batch = this.symbols.slice(i, i + this.config.batchSize);
      this.batches.push(batch);
    }
  }

  /**
   * Start subscription loops for all batches
   * @returns {Promise<void>}
   */
  async startSubscriptions() {
    if (this.isRunning) {
      this.config.logger('warn', 'ConnectionManager: Already running');
      return;
    }

    if (!this.exchange) {
      throw new Error('ConnectionManager: Not initialized. Call initialize() first.');
    }

    this.isRunning = true;

    this.config.logger('info', 'ConnectionManager: Starting subscriptions', {
      batches: this.batches.length,
    });

    // Start subscription loop for each batch
    for (let i = 0; i < this.batches.length; i++) {
      const batch = this.batches[i];
      const batchId = `batch-${i}`;

      // Stagger batch starts to avoid thundering herd
      const delay = i * 100; // 100ms between batch starts
      const timer = setTimeout(() => {
        this._subscriptionLoop(batchId, batch);
      }, delay);

      this.subscriptionTimers.push(timer);
    }
  }

  /**
   * Subscription loop for a single batch
   * INTERNAL: Runs in background as a fire-and-forget async task
   * @private
   */
  async _subscriptionLoop(batchId, symbols) {
    try {
      this.stats.batchesStarted++;
      this.config.logger('info', `ConnectionManager: Subscription loop started [${batchId}]`, {
        symbols: symbols.length,
      });

      // Main subscription loop
      while (this.isRunning) {
        try {
          // Watch tickers for this batch via CCXT Pro
          // watchTickers() returns ticker updates on each call
          const tickers = await this.exchange.watchTickers(symbols);

          if (!this.isRunning) {
            break;
          }

          // Ticker data: {symbol: rawTickerData, ...}
          if (tickers && typeof tickers === 'object') {
            for (const [symbol, rawTicker] of Object.entries(tickers)) {
              try {
                // Normalize ticker data
                const normalized = this.config.exchangeFactory.normalizeTicker(
                  symbol,
                  rawTicker
                );

                if (normalized) {
                  // Persist to Redis
                  const exchangeName = this.config.exchangeFactory.config.exchange;
                  const marketType = this.config.exchangeFactory.config.marketType;

                  await this.config.redisService.updateTicker(
                    exchangeName,
                    marketType,
                    symbol,
                    normalized
                  );

                  this.stats.totalUpdates++;
                }
              } catch (error) {
                this.stats.normalizationErrors++;
                this.config.logger('error',
                  `ConnectionManager: Normalization error [${batchId}]`,
                  { symbol, message: error.message }
                );
              }
            }
          }
        } catch (error) {
          this.stats.failedUpdates++;
          this.config.logger('error',
            `ConnectionManager: Subscription error [${batchId}]`,
            { message: error.message }
          );

          // Wait before retrying
          if (this.isRunning) {
            await this._sleep(1000);
          }
        }
      }

      this.config.logger('info', `ConnectionManager: Subscription loop stopped [${batchId}]`);
    } catch (error) {
      this.config.logger('error',
        `ConnectionManager: Subscription loop fatal error [${batchId}]`,
        { message: error.message }
      );
    }
  }

  /**
   * Stop all subscription loops and cleanup
   * @returns {Promise<void>}
   */
  async stop() {
    this.isRunning = false;

    this.config.logger('info', 'ConnectionManager: Stopping subscriptions');

    // Clear subscription timers
    for (const timer of this.subscriptionTimers) {
      clearTimeout(timer);
    }
    this.subscriptionTimers = [];

    // Flush Redis batch
    try {
      await this.config.redisService.flush();
    } catch (error) {
      this.config.logger('error', 'ConnectionManager: Final Redis flush failed', {
        message: error.message,
      });
    }

    // Close exchange connections
    if (this.exchange && this.exchange.close) {
      try {
        await this.exchange.close();
      } catch (error) {
        this.config.logger('error', 'ConnectionManager: Exchange close failed', {
          message: error.message,
        });
      }
    }

    this.config.logger('info', 'ConnectionManager: Stopped', {
      stats: this.stats,
    });
  }

  /**
   * Get service status
   * @returns {Object}
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      symbols: this.symbols.length,
      batches: this.batches.length,
      subscriptionTimers: this.subscriptionTimers.length,
      stats: { ...this.stats },
    };
  }

  /**
   * Sleep helper
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ConnectionManager;
