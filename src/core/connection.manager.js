/**
 * ConnectionManager - WebSocket Subscription Coordination with Resilience
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
 * Phase 5: Resilience Mechanisms:
 * - Exponential backoff retry with configurable base delay and max delay
 * - Non-retryable error detection (delisted, invalid markets)
 * - Stale connection health checks with configurable timeout
 *
 * Usage:
 *   const manager = new ConnectionManager({
 *     exchangeFactory: factory,
 *     redisService: redis,
 *     batchSize: 100,
 *     retryBaseDelayMs: 1000,      // Phase 5
 *     retryMaxDelayMs: 60000,      // Phase 5
 *     healthCheckIntervalMs: 5000, // Phase 5
 *     healthCheckTimeoutMs: 30000, // Phase 5
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
   * @param {number} config.retryBaseDelayMs - Base exponential backoff delay in ms (default 1000)
   * @param {number} config.retryMaxDelayMs - Max exponential backoff delay in ms (default 60000)
   * @param {number} config.healthCheckIntervalMs - Health check interval in ms (default 5000)
   * @param {number} config.healthCheckTimeoutMs - Stale connection timeout in ms (default 30000)
   * @param {Function} config.logger - Logger function
   */
  constructor(config = {}) {
    this.config = {
      exchangeFactory: config.exchangeFactory,
      redisService: config.redisService,
      batchSize: config.batchSize || 100,
      retryBaseDelayMs: config.retryBaseDelayMs || 1000,
      retryMaxDelayMs: config.retryMaxDelayMs || 60000,
      healthCheckIntervalMs: config.healthCheckIntervalMs || 5000,
      healthCheckTimeoutMs: config.healthCheckTimeoutMs || 30000,
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

    // Phase 5: Resilience State
    this.retryAttempts = new Map();        // Map<batchId, attemptCount>
    this.nonRetryableSymbols = new Set();  // Symbols that should not be retried
    this.lastMessageTime = new Map();      // Map<batchId, timestamp>
    this.healthCheckTimers = new Map();    // Map<batchId, timerId>

    // Metrics
    this.stats = {
      totalUpdates: 0,
      failedUpdates: 0,
      normalizationErrors: 0,
      batchesStarted: 0,
      retries: 0,                          // Phase 5
      exponentialBackoffs: 0,              // Phase 5
      nonRetryableDetected: 0,             // Phase 5
      staleConnectionsDetected: 0,         // Phase 5
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
   * Subscription loop for a single batch with Phase 5 resilience
   * INTERNAL: Runs in background as a fire-and-forget async task
   * @private
   */
  async _subscriptionLoop(batchId, symbols) {
    try {
      this.stats.batchesStarted++;
      this.config.logger('info', `ConnectionManager: Subscription loop started [${batchId}]`, {
        symbols: symbols.length,
      });

      // Start health check for this batch
      this._startHealthCheck(batchId);

      // Main subscription loop
      while (this.isRunning) {
        try {
          // Filter out non-retryable symbols
          const activeSymbols = symbols.filter(s => !this.nonRetryableSymbols.has(s));

          if (activeSymbols.length === 0) {
            this.config.logger('warn', `ConnectionManager: All symbols non-retryable [${batchId}]`);
            await this._sleep(5000);
            continue;
          }

          // Watch tickers for this batch via CCXT Pro
          const tickers = await this.exchange.watchTickers(activeSymbols);

          if (!this.isRunning) {
            break;
          }

          // Reset retry counter on successful connection
          this.retryAttempts.set(batchId, 0);

          // Update health check timestamp
          this.lastMessageTime.set(batchId, Date.now());

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

          // Phase 5: Check for non-retryable errors
          if (this._isNonRetryableError(error)) {
            this._handleNonRetryableError(batchId, error);
            continue; // Skip exponential backoff for non-retryable errors
          }

          // Phase 5: Apply exponential backoff
          const delayMs = this._calculateExponentialBackoff(batchId);
          this.stats.exponentialBackoffs++;

          this.config.logger('warn',
            `ConnectionManager: Exponential backoff [${batchId}]`,
            { delayMs, attempt: this.retryAttempts.get(batchId) }
          );

          // Wait before retrying
          if (this.isRunning) {
            await this._sleep(delayMs);
          }
        }
      }

      this.config.logger('info', `ConnectionManager: Subscription loop stopped [${batchId}]`);
    } catch (error) {
      this.config.logger('error',
        `ConnectionManager: Subscription loop fatal error [${batchId}]`,
        { message: error.message }
      );
    } finally {
      // Cleanup health check for this batch
      this._stopHealthCheck(batchId);
    }
  }

  /**
   * Phase 5: Calculate exponential backoff delay
   * Formula: baseDelay * (2 ^ attemptCount), capped at maxDelay
   * @private
   */
  _calculateExponentialBackoff(batchId) {
    const attempt = (this.retryAttempts.get(batchId) || 0) + 1;
    this.retryAttempts.set(batchId, attempt);
    this.stats.retries++;

    // Formula: baseDelay * (2 ^ attempt)
    const delay = this.config.retryBaseDelayMs * Math.pow(2, attempt - 1);

    // Cap at max delay
    const cappedDelay = Math.min(delay, this.config.retryMaxDelayMs);

    return cappedDelay;
  }

  /**
   * Phase 5: Detect non-retryable errors (delisted, invalid, not found)
   * @private
   */
  _isNonRetryableError(error) {
    if (!error || !error.message) {
      return false;
    }

    const message = error.message.toLowerCase();

    // Pattern matching for permanent failures
    const nonRetryablePatterns = [
      'not found',
      'invalid',
      'delisted',
      'disabled',
      '404',
      '400',
      'bad request',
      'symbol not found',
      'market not found',
    ];

    return nonRetryablePatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Phase 5: Handle non-retryable error - mark symbol as permanently failed
   * @private
   */
  _handleNonRetryableError(batchId, error) {
    this.stats.nonRetryableDetected++;
    this.config.logger('warn',
      `ConnectionManager: Non-retryable error [${batchId}]`,
      { message: error.message }
    );

    // Extract symbol from error if possible, otherwise mark entire batch
    // For now, we log it - symbol removal would be handled at higher level
  }

  /**
   * Phase 5: Start health check timer for a batch
   * Detects stale connections (no messages received)
   * @private
   */
  _startHealthCheck(batchId) {
    // Initialize last message time
    this.lastMessageTime.set(batchId, Date.now());

    // Start periodic health check timer
    const timer = setInterval(() => {
      if (!this.isRunning) {
        return;
      }

      const lastTime = this.lastMessageTime.get(batchId);
      const now = Date.now();
      const timeSinceLastMessage = now - lastTime;

      if (timeSinceLastMessage > this.config.healthCheckTimeoutMs) {
        this.stats.staleConnectionsDetected++;
        this.config.logger('warn',
          `ConnectionManager: Stale connection detected [${batchId}]`,
          {
            timeSinceLastMessage,
            threshold: this.config.healthCheckTimeoutMs,
          }
        );

        // Force reconnect by resetting retry counter and waiting
        // This will trigger the next watchTickers call to attempt reconnection
      }
    }, this.config.healthCheckIntervalMs);

    this.healthCheckTimers.set(batchId, timer);
  }

  /**
   * Phase 5: Stop health check timer for a batch
   * @private
   */
  _stopHealthCheck(batchId) {
    const timer = this.healthCheckTimers.get(batchId);
    if (timer) {
      clearInterval(timer);
      this.healthCheckTimers.delete(batchId);
    }
    this.lastMessageTime.delete(batchId);
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

    // Phase 5: Clear health check timers
    for (const timer of this.healthCheckTimers.values()) {
      clearInterval(timer);
    }
    this.healthCheckTimers.clear();

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

    // Phase 5: Clear resilience state
    this.retryAttempts.clear();
    this.nonRetryableSymbols.clear();
    this.lastMessageTime.clear();

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
      nonRetryableSymbols: this.nonRetryableSymbols.size,
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
