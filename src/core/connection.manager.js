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
 * - Exchange-aware resilience tuning (stable vs unstable exchanges)
 *
 * Usage:
 *   const manager = new ConnectionManager({
 *     exchangeFactory: factory,
 *     redisService: redis,
 *     batchSize: 100,
 *     // Optional: override exchange-specific resilience config
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

const { getResilienceConfig } = require('../constants/exchanges');

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
    if (!config.exchangeFactory) {
      throw new Error('ConnectionManager: exchangeFactory is required');
    }
    if (!config.redisService) {
      throw new Error('ConnectionManager: redisService is required');
    }

    // Load exchange-specific resilience config, allow overrides
    // Handle case where factory doesn't have config yet (e.g., in tests)
    const exchangeName = config.exchangeFactory?.config?.exchange || 'default';
    const exchangeResilienceConfig = getResilienceConfig(exchangeName);

    this.config = {
      exchangeFactory: config.exchangeFactory,
      redisService: config.redisService,
      batchSize: config.batchSize || 100,
      // Use exchange-specific resilience config, then allow config overrides
      retryBaseDelayMs: config.retryBaseDelayMs ?? exchangeResilienceConfig.retryBaseDelayMs,
      retryMaxDelayMs: config.retryMaxDelayMs ?? exchangeResilienceConfig.retryMaxDelayMs,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? exchangeResilienceConfig.healthCheckIntervalMs,
      healthCheckTimeoutMs: config.healthCheckTimeoutMs ?? exchangeResilienceConfig.healthCheckTimeoutMs,
      logger: config.logger || this._defaultLogger,
    };

    this.config.logger('info', 'ConnectionManager: Resilience config loaded', {
      exchange: exchangeName,
      retryBaseDelayMs: this.config.retryBaseDelayMs,
      retryMaxDelayMs: this.config.retryMaxDelayMs,
      healthCheckIntervalMs: this.config.healthCheckIntervalMs,
      healthCheckTimeoutMs: this.config.healthCheckTimeoutMs,
    });

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
    this.batchState = new Map();           // Map<batchId, {lastMessageAt, stale}>
    this.healthCheckInterval = null;       // Global health check timer

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

    // Phase 5: Start global health check timer (runs every 10 seconds)
    this.healthCheckInterval = setInterval(() => {
      this._healthCheck();
    }, 10000);

    this.config.logger('info', 'ConnectionManager: Health check timer started (10s interval)');
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

      // Initialize batch state for health checks
      this.batchState.set(batchId, {
        lastMessageAt: Date.now(),
        stale: false,
      });

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

          // ✅ Phase 5: Update batch state - CRITICAL for health checks
          const batchState = this.batchState.get(batchId);
          if (batchState) {
            batchState.lastMessageAt = Date.now();
            batchState.stale = false;  // Reset stale flag on successful data
          }
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

          // Log full error details for debugging
          this.config.logger('debug', `ConnectionManager: Error caught [${batchId}]`, {
            errorName: error.name,
            errorCode: error.code,
            errorMessage: error.message,
            fullError: error.toString(),
          });

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
      this.batchState.delete(batchId);
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
    const errorName = (error.name || '').toLowerCase();

    // Pattern matching for permanent failures
    const nonRetryablePatterns = [
      // Standard patterns
      'not found',
      'invalid',
      'delisted',
      'disabled',
      'suspended',
      '404',
      '400',
      'bad request',
      'symbol not found',
      'market not found',
      // CCXT specific patterns for invalid symbols
      'badsymbol',
      'does not have market',
      'unknown symbol',
      'invalid symbol',
      'symbol is not supported',
      'market is not active',
      'no such market',
      'trading not allowed',
      'pair not found',
      'no permission',
    ];

    // Check message patterns
    const matchesMessage = nonRetryablePatterns.some(pattern => message.includes(pattern));

    // Check error name (CCXT exceptions)
    const matchesName = errorName.includes('badsymbol') ||
                        errorName.includes('notfound') ||
                        errorName.includes('http400') ||
                        errorName.includes('http404') ||
                        errorName.includes('permissiondenied');

    return matchesMessage || matchesName;
  }

  /**
   * Phase 5: Handle non-retryable error - mark symbol as permanently failed
   * Extracts symbol from error message and adds to non-retryable set
   * @private
   */
  _handleNonRetryableError(batchId, error) {
    this.stats.nonRetryableDetected++;

    // Try to extract symbol from error message
    const symbol = this._extractSymbolFromError(error);

    if (symbol) {
      this.nonRetryableSymbols.add(symbol);

      // ✅ UPDATE MAIN BATCH STATE: Remove from this.batches so tests/externals see the change
      const batchIndex = parseInt(batchId.split('-')[1], 10);
      if (!isNaN(batchIndex) && this.batches[batchIndex]) {
        if (Array.isArray(this.batches[batchIndex])) {
          // batches is array of arrays
          this.batches[batchIndex] = this.batches[batchIndex].filter(s => s !== symbol);
        } else if (this.batches[batchIndex] && Array.isArray(this.batches[batchIndex].symbols)) {
          // batches is array of objects with .symbols property
          this.batches[batchIndex].symbols = this.batches[batchIndex].symbols.filter(s => s !== symbol);
        }
      }

      this.config.logger('warn',
        `ConnectionManager: Symbol marked non-retryable [${batchId}]`,
        { symbol, message: error.message }
      );
    } else {
      this.config.logger('warn',
        `ConnectionManager: Non-retryable error [${batchId}]`,
        { message: error.message }
      );
    }
  }

  /**
   * Phase 5: Extract symbol from error message
   * Looks for patterns like "BTC/USDT" in error messages
   * @private
   */
  _extractSymbolFromError(error) {
    if (!error || !error.message) {
      return null;
    }

    const message = error.message;

    // Pattern 1: Direct symbol mention (e.g., "BTC/USDT not found")
    const match = message.match(/([A-Z0-9]+\/[A-Z0-9]+)/);
    if (match) {
      return match[1];
    }

    // Pattern 2: symbol= format (e.g., "invalid symbol='FAKE/USDT'")
    const match2 = message.match(/symbol=['"]([A-Z0-9]+\/[A-Z0-9]+)['"]/i);
    if (match2) {
      return match2[1];
    }

    return null;
  }

  /**
   * Phase 5: Global health check - runs every 10 seconds
   * Detects stale connections (no messages for 60+ seconds)
   * @private
   */
  _healthCheck() {
    if (!this.isRunning) {
      return;
    }

    // Check all active batches
    for (const [batchId, batchState] of this.batchState.entries()) {
      if (!batchState) continue;

      const timeSinceLastMessage = Date.now() - batchState.lastMessageAt;
      const staleThreshold = this.config.healthCheckTimeoutMs || 60000;

      // Detect stale connection (no data for > 60 seconds)
      if (timeSinceLastMessage > staleThreshold && !batchState.stale) {
        batchState.stale = true;  // Mark as stale to avoid duplicate logs
        this.stats.staleConnectionsDetected++;

        this.config.logger('warn',
          `ConnectionManager: Stale connection detected [${batchId}]`,
          {
            timeSinceLastMessage: `${(timeSinceLastMessage / 1000).toFixed(1)}s`,
            threshold: `${(staleThreshold / 1000).toFixed(1)}s`,
          }
        );

        // Force reconnect by closing current exchange connection
        // This will cause watchTickers to fail and trigger exponential backoff
        if (this.exchange && this.exchange.close) {
          this.exchange.close().catch(() => {
            // Silently ignore errors from close
          });
        }
      }

      // Reset stale flag if data is flowing again
      if (timeSinceLastMessage <= staleThreshold && batchState.stale) {
        batchState.stale = false;
        this.config.logger('info', `ConnectionManager: Connection recovered [${batchId}]`);
      }
    }
  }

  /**
   * Phase 5: Initialize health check for a batch (sets initial timestamp)
   * @private
   */
  _startHealthCheck(batchId) {
    // Initialize last message time
    this.lastMessageTime.set(batchId, Date.now());
  }

  /**
   * Phase 5: Stop health check timer for a batch
   * @private
   */
  _stopHealthCheck(batchId) {
    this.lastMessageTime.delete(batchId);
  }

  /**
   * Stop all subscription loops and cleanup
   * @returns {Promise<void>}
   */
  async stop() {
    this.isRunning = false;

    this.config.logger('info', 'ConnectionManager: Stopping subscriptions');

    // Clear global health check timer
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

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
    this.batchState.clear();

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
