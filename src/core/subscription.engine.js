/**
 * SubscriptionEngine - Subscription Loop Coordination & Per-Connection Resilience
 *
 * CRITICAL UPDATE: Uses AdapterPool with factory pattern for TRUE per-connection isolation
 * - Each batch gets its OWN adapter instance (unique connection)
 * - Batch connection failure ONLY affects that batch
 * - Per-batch health tracking (via AdapterPool)
 *
 * Encapsulates ALL subscription loop logic internally:
 * - Per-batch adapter allocation (factory-based)
 * - Per-batch subscription management
 * - Per-batch health tracking (via AdapterPool)
 * - Exponential backoff on errors
 * - Per-batch stale detection
 * - Non-retryable symbol handling
 * - Callback-based ticker delivery
 *
 * NO external calls to private methods.
 * All state is internal and protected.
 *
 * Usage:
 *   const engine = new SubscriptionEngine(adapterFactory, registry, writer, config);
 *   engine.onTicker((symbol, ticker) => {...});
 *   engine.onError((batchId, error) => {...});
 *   await engine.startSubscriptions(batches);
 *   await engine.stopSubscriptions();
 */

const RetryScheduler = require('../utils/retry.scheduler');
const AdapterPool = require('./adapter.pool');
const RetryTimerRegistry = require('./retry-timer-registry');
const HealthRatioPolicy = require('./health-ratio-policy');

class SubscriptionEngine {
  constructor(adapterFactory, registry, writer, config = {}) {
    this.adapterFactory = adapterFactory;  // Factory to CREATE new adapters per batch
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

    // Exchange metadata (same for all batches, set when first adapter created)
    this.exchangeId = null;
    this.marketType = null;

    // Subscription state (ALL internal)
    this.isRunning = false;
    this.subscriptionLoops = new Map();      // Map<batchId, {symbols, retryAttempts}>
    this.subscriptionTimers = [];            // Stagger startup timers
    this.healthCheckInterval = null;

    // Resilience state
    this.retryScheduler = new RetryScheduler({
      baseDelayMs: this.config.retryBaseDelayMs,
      maxDelayMs: this.config.retryMaxDelayMs,
    });

    // Stage 3 Resilience Modules - CREATE BEFORE AdapterPool
    this.timerRegistry = new RetryTimerRegistry({ logger: this.config.logger });

    // Use per-exchange health ratio policy config if provided
    const healthRatioCfg = config.healthRatioPolicyConfig || {};
    this.healthRatioPolicy = new HealthRatioPolicy({
      minHealthyRatio: healthRatioCfg.minHealthyRatio || 0.5,
      ratioBreachCycles: healthRatioCfg.ratioBreachCycles || 3,
      restartCooldownMs: healthRatioCfg.restartCooldownMs || 30000,
      logger: this.config.logger,
    });

    // Store stale watchdog config for AdapterPool
    this.config.staleWatchdogConfig = config.staleWatchdogConfig || {};

    // Adapter pool for per-batch connection isolation (CRITICAL: Stage 2 Per-Connection)
    // Each batch gets its OWN adapter instance via factory
    // NOW has all Stage 3 resilience modules available (timer registry, stale config)
    this.adapterPool = new AdapterPool(
      this.adapterFactory,  // Factory creates NEW adapters per batch
      {
        ...this.config,
        timerRegistry: this.timerRegistry,  // Pass timer registry for lifecycle cleanup
      }
    );

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
      // Initialize adapter pool (creates adapters on-demand per batch)
      await this.adapterPool.initialize();

      this.isRunning = true;
      this.metrics.isRunning = true;
      this.metrics.activeConnections = batches.length;

      this.config.logger('info', `SubscriptionEngine: Starting ${batches.length} subscription loops (per-batch adapters)`, {
        batches: batches.length,
        batchSize: this.config.batchSize,
      });

      // Initialize subscription state for each batch
      for (let i = 0; i < batches.length; i++) {
        const batchId = `batch-${i}`;
        const symbols = batches[i];

        this.subscriptionLoops.set(batchId, {
          symbols,
          retryAttempts: 0,
          lastActiveSymbols: [],  // STAGE 4 FIX #1: Track what we subscribed to
          paused: false,          // STAGE 4 FIX #2: Track if batch is paused for removal
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

    // Clear all retry timers (Stage 3 - RetryTimerRegistry)
    const result = this.timerRegistry.cancelAllTimers();
    if (result.totalCancelled > 0) {
      this.config.logger('debug', `SubscriptionEngine: Cancelled ${result.totalCancelled} pending retry timers`);
    }

    // Close adapter pool (closes all per-batch adapters)
    try {
      await this.adapterPool.close();
    } catch (error) {
      this.config.logger('warn', `SubscriptionEngine: Error closing adapter pool`, {
        error: error.message,
      });
    }

    this.subscriptionLoops.clear();
    this.config.logger('info', `SubscriptionEngine: Stopped`);
  }

  /**
   * Internal subscription loop for a batch (with per-batch adapter and health tracking)
   * CRITICAL: Each batch uses its OWN adapter instance (per-connection isolation)
   *
   * @private
   */
  async _subscriptionLoop(batchId) {
    let batchAdapterWrapper = null;

    try {
      const loopState = this.subscriptionLoops.get(batchId);
      if (!loopState) return;

      // Get THIS BATCH'S adapter instance (creates new if not exists)
      batchAdapterWrapper = await this.adapterPool.getBatchAdapter(batchId);
      const batchAdapter = batchAdapterWrapper.adapter;

      // Set exchange metadata from first adapter
      if (!this.exchangeId && batchAdapter.getExchangeId) {
        this.exchangeId = batchAdapter.getExchangeId();
        this.marketType = batchAdapter.getMarketType();
      }

      this.config.logger('info', `SubscriptionEngine: Subscription loop started [${batchId}]`, {
        symbols: loopState.symbols.length,
        hasOwnAdapter: true,
      });

      while (this.isRunning && this.subscriptionLoops.has(batchId)) {
        try {
          // Get active symbols (exclude non-retryable)
          const activeSymbols = loopState.symbols.filter(
            s => !this.registry.getNonRetryableSymbols().has(s)
          );

          if (activeSymbols.length === 0) {
            // STAGE 4 FIX #2: Check if batch is being paused for removal
            if (loopState.paused) {
              this.config.logger('info', `SubscriptionEngine: Batch paused and empty, exiting loop [${batchId}]`);
              break;  // Exit while loop cleanly
            }

            // Not paused, just all non-retryable - wait and retry
            this.config.logger('warn', `SubscriptionEngine: All symbols non-retryable [${batchId}]`);
            // Use registered timer instead of blocking sleep
            await new Promise(resolve => {
              this._registerRetryTimer(batchId, 5000, resolve);
            });
            continue;
          }

          // Subscribe through AdapterPool (sets state to 'connecting' before first data)
          // This ensures state machine is authoritative: connecting → subscribed on first data
          const subscription = await this.adapterPool.subscribeForBatch(batchId, activeSymbols);

          // STAGE 4 FIX #1: Store what symbols we subscribed to
          loopState.lastActiveSymbols = [...activeSymbols];

          for await (const { symbol, ticker } of subscription) {
            if (!this.isRunning) break;

            // STAGE 4 FIX #1: Check if symbols changed during iteration
            const currentSymbols = loopState.symbols.filter(
              s => !this.registry.getNonRetryableSymbols().has(s)
            );
            const symbolsChanged = currentSymbols.length !== loopState.lastActiveSymbols.length ||
              !currentSymbols.every(s => loopState.lastActiveSymbols.includes(s));

            if (symbolsChanged) {
              this.config.logger('info', `SubscriptionEngine: Symbols changed, restarting subscription [${batchId}]`, {
                before: loopState.lastActiveSymbols.length,
                after: currentSymbols.length,
              });
              break;  // Exit for await to restart with new symbols in while loop
            }

            // Update batch-local health
            this.adapterPool.recordDataForBatch(batchId);

            // Update retry attempts (reset on success)
            loopState.retryAttempts = 0;

            // Write to Redis
            try {
              await this.writer.writeTicker(
                this.exchangeId,
                this.marketType,
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

          // Record error in batch-local health (isolated per batch)
          this.adapterPool.recordErrorForBatch(batchId, error);

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
            await new Promise(resolve => {
              this._registerRetryTimer(batchId, 1000, resolve);
            });
          } else {
            // Retryable error - apply exponential backoff
            loopState.retryAttempts++;
            const delay = this.retryScheduler.calculateBackoff(loopState.retryAttempts);

            this.config.logger('warn', `SubscriptionEngine: Exponential backoff [${batchId}]`, {
              attempt: loopState.retryAttempts,
              delayMs: delay,
            });

            this.metrics.retryQueue++;
            await new Promise(resolve => {
              this._registerRetryTimer(batchId, delay, resolve);
            });
            this.metrics.retryQueue--;
          }
        }
      }

      this.config.logger('info', `SubscriptionEngine: Subscription loop ended [${batchId}]`);

      // STAGE 4 FIX #2: Clean up batch if it was paused for removal
      if (loopState && loopState.paused) {
        this.config.logger('info', `SubscriptionEngine: Cleaning up paused batch [${batchId}]`);
        await this.adapterPool.closeBatch(batchId);
        this.subscriptionLoops.delete(batchId);
      }
    } catch (fatalError) {
      this.config.logger('error', `SubscriptionEngine: Fatal error in loop [${batchId}]`, {
        error: fatalError.message,
      });
      this.metrics.failedBatches++;
      this._callErrorCallbacks(batchId, fatalError);
    }
  }

  /**
   * Global health check - per-batch stale detection via escalation (via AdapterPool)
   * Each batch has isolated health state (per-connection)
   * Uses stale watchdog escalation: WARN → RECOVER → FAIL
   *
   * @private
   */
  _startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      if (!this.isRunning) return;

      // Get health for all batches from AdapterPool (per-batch isolation)
      const allBatchHealth = this.adapterPool.getAllBatchHealth();

      for (const health of allBatchHealth) {
        // Use escalation model instead of simple isStale check
        const escalation = this.adapterPool.checkStaleEscalation(health.id);

        if (escalation && escalation.action) {
          this.config.logger('debug', `SubscriptionEngine: Stale escalation check [${health.id}]`, {
            action: escalation.action,
            level: escalation.level,
            reason: escalation.reason,
          });

          if (escalation.action === 'recover') {
            // Per-batch recovery attempt - escalated from WARNED
            this.metrics.staleDetections++;
            this.config.logger('warn', `SubscriptionEngine: Escalated to recovery [${health.id}]`, {
              level: escalation.level,
              reason: escalation.reason,
            });

            // Attempt per-batch recovery
            this.adapterPool.resetBatchForRecovery(health.id);

            // Call health check callbacks
            for (const callback of this.healthCheckCallbacks) {
              try {
                callback(health.id, { stale: true, action: 'recover' });
              } catch (cbError) {
                this.config.logger('error', `SubscriptionEngine: Health check callback error`, {
                  error: cbError.message,
                });
              }
            }
          } else if (escalation.action === 'fail') {
            // Escalated to FAILED - transition batch state and let global health ratio policy handle restart
            this.adapterPool.transitionBatchToFailed(health.id, escalation.reason);

            this.config.logger('warn', `SubscriptionEngine: Batch escalated to FAILED [${health.id}]`, {
              reason: escalation.reason,
            });

            // Call health check callbacks for monitoring
            for (const callback of this.healthCheckCallbacks) {
              try {
                callback(health.id, { stale: true, action: 'fail' });
              } catch (cbError) {
                this.config.logger('error', `SubscriptionEngine: Health check callback error`, {
                  error: cbError.message,
                });
              }
            }
          }
          // action === 'warn' means just log, don't recover yet - next cycle will escalate
        }
      }

      // Stage 3: Evaluate global health ratio (triggers restart if degraded)
      this._evaluateHealthRatio().catch(error => {
        this.config.logger('error', `SubscriptionEngine: Health ratio evaluation error`, {
          error: error.message,
        });
      });
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
   * Evaluate global health ratio and trigger restart if needed (Stage 3)
   * Called from health check interval
   * @private
   */
  async _evaluateHealthRatio() {
    if (!this.isRunning) return;

    const batchHealth = this.adapterPool.getAllBatchHealth();
    if (batchHealth.length === 0) return;

    const decision = this.healthRatioPolicy.evaluate(batchHealth);

    if (decision.shouldRestart) {
      this.config.logger('warn', `SubscriptionEngine: Health ratio trigger restart [${decision.reason}]`, {
        healthy: decision.healthy,
        total: decision.total,
        ratio: decision.ratio,
      });

      this.metrics.ratioRestartCount = (this.metrics.ratioRestartCount || 0) + 1;

      // Controlled recycle: stop + restart subscriptions (if batches still exist)
      if (this.subscriptionLoops.size > 0) {
        try {
          const batches = Array.from(this.subscriptionLoops.values()).map(loop => loop.symbols);
          await this.stopSubscriptions();
          // Small delay before restart
          await this._sleep(1000);
          await this.startSubscriptions(batches);
        } catch (error) {
          this.config.logger('error', `SubscriptionEngine: Error during health ratio restart`, {
            error: error.message,
          });
        }
      }
    }
  }

  /**
   * STAGE 4: Reconcile batch allocations without full restart
   *
   * Incremental reconciliation: add/remove symbols from running batches
   * - Adds new symbols to existing batches (extends current subscription)
   * - Removes stale symbols from existing batches (subscription continues)
   * - Preserves batch connection state and health metrics
   * - NO stopSubscriptions() call (zero downtime)
   *
   * @param {Array} nextPlan - New batch allocation [{batchId, symbols}, ...]
   * @returns {Object} - {added: [], removed: [], modified: [], unchanged: []}
   */
  async reconcileBatches(nextPlan) {
    if (!this.isRunning) {
      this.config.logger('debug', `SubscriptionEngine: reconcileBatches called but engine not running`);
      return { added: [], removed: [], modified: [], unchanged: [] };
    }

    if (!Array.isArray(nextPlan)) {
      throw new Error('nextPlan must be an array');
    }

    const diff = {
      added: [],      // New batches created
      removed: [],    // Batches that became empty/removed
      modified: [],   // Batches with symbol changes
      unchanged: []   // Batches with no changes
    };

    const nextPlanMap = new Map(nextPlan.map(p => [p.batchId, p.symbols]));

    this.config.logger('info', `SubscriptionEngine: Starting reconciliation`, {
      currentBatches: this.subscriptionLoops.size,
      nextBatches: nextPlan.length,
    });

    try {
      // Step 1: Process existing batches (modify or remove symbols)
      for (const [batchId, loopState] of this.subscriptionLoops.entries()) {
        if (!nextPlanMap.has(batchId)) {
          // Batch being removed - mark as paused (STAGE 4 FIX #2)
          loopState.paused = true;
          loopState.symbols = [];

          diff.removed.push(batchId);

          // STAGE 4 FIX #3: IMMEDIATELY close adapter (don't wait for loop to detect)
          // This forces the active subscription to end, so cleanup happens immediately
          try {
            await this.adapterPool.closeBatch(batchId);
            this.config.logger('info', `SubscriptionEngine: Batch removed and adapter closed [${batchId}]`);
          } catch (error) {
            this.config.logger('warn', `SubscriptionEngine: Error closing adapter for ${batchId}`, {
              error: error.message,
            });
          }
        } else {
          const nextSymbols = nextPlanMap.get(batchId);
          const currentSymbols = loopState.symbols;

          const added = nextSymbols.filter(s => !currentSymbols.includes(s));
          const removed = currentSymbols.filter(s => !nextSymbols.includes(s));

          if (added.length > 0 || removed.length > 0) {
            // Update loop state with new symbol list
            loopState.symbols = nextSymbols;

            diff.modified.push({
              batchId,
              removed,
              added
            });

            this.config.logger('info', `SubscriptionEngine: Batch modified [${batchId}]`, {
              added: added.length,
              removed: removed.length,
              totalSymbols: nextSymbols.length,
            });
          } else {
            diff.unchanged.push(batchId);
          }
        }
      }

      // Step 2: Start new batches (if any)
      for (const [batchId, symbols] of nextPlanMap.entries()) {
        if (!this.subscriptionLoops.has(batchId)) {
          // New batch - add to loop state and start subscription
          this.subscriptionLoops.set(batchId, {
            symbols,
            retryAttempts: 0,
            lastActiveSymbols: [],
            paused: false,
          });

          // Start subscription loop (staggered)
          const currentBatchCount = this.subscriptionLoops.size - 1;
          const delay = currentBatchCount * (this.config.subscriptionDelay || 100);

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

          diff.added.push({
            batchId,
            symbols,
            count: symbols.length,
          });

          this.config.logger('info', `SubscriptionEngine: New batch started [${batchId}]`, {
            symbols: symbols.length,
          });
        }
      }

      this.metrics.activeConnections = this.subscriptionLoops.size;

      this.config.logger('info', `SubscriptionEngine: Reconciliation complete (Stage 4 - zero downtime)`, {
        newBatches: diff.added.length,
        modifiedBatches: diff.modified.length,
        unchangedBatches: diff.unchanged.length,
        pausedBatches: diff.removed.length,
        totalBatches: this.subscriptionLoops.size,
      });

      return diff;
    } catch (error) {
      this.config.logger('error', `SubscriptionEngine: Reconciliation failed`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Register a retry timer with the timer registry (Stage 3)
   * @private
   */
  _registerRetryTimer(batchId, delayMs, callback) {
    const timeoutHandle = setTimeout(() => {
      this.timerRegistry.removeTimer(batchId, timeoutHandle);
      callback();
    }, delayMs);

    this.timerRegistry.registerTimer(batchId, timeoutHandle);
    return timeoutHandle;
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
      // Add batch health from AdapterPool (Stage 2D)
      batchHealth: this.adapterPool?.getAllBatchHealth() || [],
    };
  }
}

module.exports = SubscriptionEngine;
