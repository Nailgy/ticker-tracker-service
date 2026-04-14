/**
 * SubscriptionEngine - Subscription Loop Coordination & Resilience
 *
 * Encapsulates ALL subscription loop logic internally:
 * - Batch subscription management
 * - Exponential backoff on errors
 * - Health check / stale detection
 * - Non-retryable symbol handling
 * - Callback-based ticker delivery
 *
 * NO external calls to private methods.
 * All state is internal and protected.
 *
 * Usage:
 *   const engine = new SubscriptionEngine(adapter, registry, writer, config);
 *   engine.onTicker((symbol, ticker) => {...});
 *   engine.onError((batchId, error) => {...});
 *   await engine.startSubscriptions();
 *   await engine.stopSubscriptions();
 */

const RetryScheduler = require('../utils/retry.scheduler');

class SubscriptionEngine {
  constructor(adapter, registry, writer, config = {}) {
    this.adapter = adapter;
    this.registry = registry;
    this.writer = writer;

    this.config = {
      batchSize: config.batchSize || 100,
      healthCheckIntervalMs: config.healthCheckIntervalMs || 15000,
      healthCheckTimeoutMs: config.healthCheckTimeoutMs || 60000,
      retryBaseDelayMs: config.retryBaseDelayMs || 1000,
      retryMaxDelayMs: config.retryMaxDelayMs || 60000,
      logger: config.logger || this._defaultLogger,
      subscriptionDelay: config.subscriptionDelay || 100,
    };

    // Subscription state (ALL internal)
    this.isRunning = false;
    this.subscriptionLoops = new Map();      // Map<batchId, {symbols, lastDataAt, retryAttempts}>
    this.subscriptionTimers = [];            // Stagger startup timers
    this.healthCheckInterval = null;
    this.healthCheckTimers = new Map();      // Per-batch health check

    // Resilience state
    this.retryScheduler = new RetryScheduler({
      baseDelayMs: this.config.retryBaseDelayMs,
      maxDelayMs: this.config.retryMaxDelayMs,
    });

    // Callbacks
    this.tickerCallbacks = [];
    this.errorCallbacks = [];
    this.healthCheckCallbacks = [];

    // Metrics
    this.metrics = {
      isRunning: false,
      activeConnections: 0,
      failedBatches: 0,
      retryQueue: 0,
      totalTickers: 0,
      totalErrors: 0,
      staleDetections: 0,
    };
  }

  /**
   * Default logger
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[SubscriptionEngine:${level.toUpperCase()}] ${message}`, data || '');
  }

  /**
   * Register ticker callback
   */
  onTicker(callback) {
    this.tickerCallbacks.push(callback);
  }

  /**
   * Register error callback
   */
  onError(callback) {
    this.errorCallbacks.push(callback);
  }

  /**
   * Register health check callback
   */
  onHealthCheck(callback) {
    this.healthCheckCallbacks.push(callback);
  }

  /**
   * Start subscriptions for all batches (staggered)
   */
  async startSubscriptions(batches) {
    if (this.isRunning) {
      this.config.logger('warn', `SubscriptionEngine: Already running`);
      return;
    }

    if (!batches || batches.length === 0) {
      throw new Error('Cannot start subscriptions with empty batches');
    }

    try {
      this.isRunning = true;
      this.metrics.isRunning = true;
      this.metrics.activeConnections = batches.length;

      this.config.logger('info', `SubscriptionEngine: Starting ${batches.length} subscription loops`, {
        batches: batches.length,
        batchSize: this.config.batchSize,
      });

      // Initialize subscription state for each batch
      for (let i = 0; i < batches.length; i++) {
        const batchId = `batch-${i}`;
        const symbols = batches[i];

        this.subscriptionLoops.set(batchId, {
          symbols,
          lastDataAt: Date.now() + (this.config.healthCheckTimeoutMs || 60000) + 30000, // Grace period
          retryAttempts: 0,
          stale: false,
        });

        // Stagger batch startup
        const delay = i * (this.config.subscriptionDelay || 100);
        const timer = setTimeout(() => {
          if (this.isRunning) {
            this._subscriptionLoop(batchId).catch(error => {
              this.config.logger('error', `SubscriptionEngine: Loop error [${batchId}]`, {
                error: error.message,
              });
            });
          }
        }, delay);

        this.subscriptionTimers.push(timer);
      }

      // Start global health check
      this._startHealthCheck();

      this.config.logger('info', `SubscriptionEngine: Subscriptions started`);
    } catch (error) {
      this.isRunning = false;
      this.metrics.isRunning = false;
      this.config.logger('error', `SubscriptionEngine: Start failed`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Stop all subscriptions gracefully
   */
  async stopSubscriptions() {
    this.isRunning = false;
    this.metrics.isRunning = false;

    this.config.logger('info', `SubscriptionEngine: Stopping subscriptions`);

    // Clear timers
    for (const timer of this.subscriptionTimers) {
      clearTimeout(timer);
    }
    this.subscriptionTimers = [];

    // Clear health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Clear per-batch health checks
    for (const timer of this.healthCheckTimers.values()) {
      clearTimeout(timer);
    }
    this.healthCheckTimers.clear();

    // Close adapter
    try {
      await this.adapter.close();
    } catch (error) {
      this.config.logger('warn', `SubscriptionEngine: Error closing adapter`, {
        error: error.message,
      });
    }

    this.subscriptionLoops.clear();
    this.config.logger('info', `SubscriptionEngine: Stopped`);
  }

  /**
   * Internal subscription loop for a batch
   * This runs in background as fire-and-forget async
   *
   * @private
   */
  async _subscriptionLoop(batchId) {
    try {
      const loopState = this.subscriptionLoops.get(batchId);
      if (!loopState) return;

      this.config.logger('info', `SubscriptionEngine: Subscription loop started [${batchId}]`, {
        symbols: loopState.symbols.length,
      });

      while (this.isRunning && this.subscriptionLoops.has(batchId)) {
        try {
          // Get active symbols (exclude non-retryable)
          const activeSymbols = loopState.symbols.filter(
            s => !this.registry.getNonRetryableSymbols().has(s)
          );

          if (activeSymbols.length === 0) {
            this.config.logger('warn', `SubscriptionEngine: All symbols non-retryable [${batchId}]`);
            await this._sleep(5000);
            continue;
          }

          // Subscribe and iterate through tickers
          for await (const { symbol, ticker } of this.adapter.subscribe(activeSymbols)) {
            if (!this.isRunning) break;

            // Update health state
            const loopState = this.subscriptionLoops.get(batchId);
            if (loopState) {
              loopState.lastDataAt = Date.now();
              loopState.stale = false;
              loopState.retryAttempts = 0; // Reset on success
            }

            // Write to Redis
            try {
              await this.writer.writeTicker(
                this.adapter.getExchangeId(),
                this.adapter.getMarketType(),
                symbol,
                ticker
              );
              this.metrics.totalTickers++;
            } catch (writeError) {
              this._callErrorCallbacks(batchId, writeError);
            }

            // Deliver ticker to callbacks
            for (const callback of this.tickerCallbacks) {
              try {
                await callback(symbol, ticker);
              } catch (cbError) {
                this.config.logger('error', `SubscriptionEngine: Callback error`, {
                  error: cbError.message,
                });
              }
            }
          }
        } catch (error) {
          this.metrics.totalErrors++;
          this._callErrorCallbacks(batchId, error);

          // Check if non-retryable error
          if (this._isNonRetryableError(error)) {
            this.config.logger('warn', `SubscriptionEngine: Non-retryable error [${batchId}]`, {
              error: error.message,
            });

            // Extract symbol if possible
            const symbol = this._extractSymbolFromError(error);
            if (symbol) {
              this.config.logger('info', `SubscriptionEngine: Marking symbol non-retryable [${batchId}]`, {
                symbol,
              });
              this.registry.markNonRetryable([symbol]);
            }

            // Don't backoff for non-retryable errors
            await this._sleep(1000);
          } else {
            // Retryable error - apply exponential backoff
            const loopState = this.subscriptionLoops.get(batchId);
            if (loopState) {
              loopState.retryAttempts++;
              const delay = this.retryScheduler.calculateBackoff(loopState.retryAttempts);

              this.config.logger('warn', `SubscriptionEngine: Exponential backoff [${batchId}]`, {
                attempt: loopState.retryAttempts,
                delayMs: delay,
              });

              this.metrics.retryQueue++;
              await this._sleep(delay);
              this.metrics.retryQueue--;
            }
          }
        }
      }

      this.config.logger('info', `SubscriptionEngine: Subscription loop ended [${batchId}]`);
    } catch (fatalError) {
      this.config.logger('error', `SubscriptionEngine: Fatal error in loop [${batchId}]`, {
        error: fatalError.message,
      });
      this.metrics.failedBatches++;
      this._callErrorCallbacks(batchId, fatalError);
    }
  }

  /**
   * Global health check - detect stale connections
   *
   * @private
   */
  _startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      if (!this.isRunning) return;

      for (const [batchId, loopState] of this.subscriptionLoops.entries()) {
        const timeSinceLastMessage = Date.now() - loopState.lastDataAt;
        const threshold = this.config.healthCheckTimeoutMs || 60000;

        if (timeSinceLastMessage > threshold && !loopState.stale) {
          loopState.stale = true;
          this.metrics.staleDetections++;

          this.config.logger('warn', `SubscriptionEngine: Stale connection detected [${batchId}]`, {
            timeSinceLastMessageMs: timeSinceLastMessage,
            thresholdMs: threshold,
          });

          // Force reconnection by closing exchange
          try {
            this.adapter.close().catch(() => {}); // Silently ignore close errors
          } catch (error) {
            // Ignore
          }

          // Call health check callbacks
          for (const callback of this.healthCheckCallbacks) {
            try {
              callback(batchId, { stale: true });
            } catch (cbError) {
              this.config.logger('error', `SubscriptionEngine: Health check callback error`, {
                error: cbError.message,
              });
            }
          }
        }

        // Reset stale flag if data is flowing
        if (timeSinceLastMessage <= threshold && loopState.stale) {
          loopState.stale = false;
          this.config.logger('info', `SubscriptionEngine: Connection recovered [${batchId}]`);
        }
      }
    }, this.config.healthCheckIntervalMs || 15000);
  }

  /**
   * Check if error is non-retryable
   *
   * @private
   */
  _isNonRetryableError(error) {
    const message = error.message?.toLowerCase() || '';

    const nonRetryablePatterns = [
      'not found', 'invalid', 'delisted', 'disabled', 'suspended',
      '404', '400', 'bad request', 'symbol not found', 'market not found',
      'badsymbol', 'does not have market', 'unknown symbol',
      'invalid symbol', 'symbol is not supported', 'market is not active',
      'no such market', 'trading not allowed', 'pair not found', 'no permission',
    ];

    return nonRetryablePatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Extract symbol from error message
   *
   * @private
   */
  _extractSymbolFromError(error) {
    const message = error.message || '';

    // Pattern 1: Direct mention (BTC/USDT)
    const match = message.match(/([A-Z0-9]+\/[A-Z0-9]+)/);
    if (match) return match[1];

    // Pattern 2: symbol= format
    const match2 = message.match(/symbol=['"]([A-Z0-9]+\/[A-Z0-9]+)['"]/i);
    if (match2) return match2[1];

    return null;
  }

  /**
   * Call error callbacks
   *
   * @private
   */
  _callErrorCallbacks(batchId, error) {
    for (const callback of this.errorCallbacks) {
      try {
        callback(batchId, error);
      } catch (cbError) {
        this.config.logger('error', `SubscriptionEngine: Error callback error`, {
          error: cbError.message,
        });
      }
    }
  }

  /**
   * Sleep helper
   *
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeConnections: this.subscriptionLoops.size,
      failedBatches: this.metrics.failedBatches,
      retryQueue: this.metrics.retryQueue,
      metrics: { ...this.metrics },
    };
  }
}

module.exports = SubscriptionEngine;
