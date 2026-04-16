/**
 * AdapterPool - Per-Batch Connection Isolation
 *
 * CRITICAL: This provides TRUE per-connection isolation (NOT just health isolation).
 * Each batch gets its OWN exchange instance with its OWN connection.
 *
 * What this solves:
 * - Before: Single shared adapter → one connection failure kills ALL batches
 * - After: Per-batch adapters via factory → each batch has independent connection
 *
 * Architecture:
 * - Factory pattern: adapterFactory() called ONCE PER BATCH
 * - Each batch gets unique adapter instance with own CCXT exchange and WebSocket
 * - Per-batch health tracking on metadata (state, health counters)
 * - TRUE connection isolation: Batch-1 failure DOESN'T affect Batch-2/Batch-3 connections
 *
 * Usage:
 *   const pool = new AdapterPool(adapterFactory, config);  // Factory creates adapters, NOT single adapter
 *   await pool.initialize();
 *   const wrapper = await pool.getBatchAdapter('batch-0');  // Creates NEW adapter per batch
 *   pool.recordDataForBatch('batch-0');
 *   pool.recordErrorForBatch('batch-0', error);
 */

class AdapterPool {
  constructor(adapterFactory, config = {}) {
    this.adapterFactory = adapterFactory;  // Function that CREATES NEW adapters
    this.config = config;
    this.logger = config.logger || this._defaultLogger;

    this.adapters = new Map(); // Map<batchId, {id, adapter, state, health, subscriptionPromise}>
    this.isInitialized = false;
  }

  /**
   * Default logger
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[AdapterPool:${level.toUpperCase()}] ${message}`, data || '');
  }

  /**
   * Initialize pool (mark ready, adapters created on-demand per batch)
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      this.logger('info', `AdapterPool: Initializing (factory-based, per-batch)`);
      this.isInitialized = true;
      this.logger('info', `AdapterPool: Ready - will create new adapter per batch`);
    } catch (error) {
      this.logger('error', `AdapterPool: Initialization failed`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get or create adapter for a batch (CREATES NEW adapter per batch via factory)
   * CRITICAL: Each batch gets its OWN adapter instance (per-connection isolation)
   */
  async getBatchAdapter(batchId) {
    if (!this.adapters.has(batchId)) {
      try {
        this.logger('debug', `AdapterPool: Creating new adapter for ${batchId}`);

        // CRITICAL: Call factory to create NEW adapter instance per batch
        const newAdapter = await this.adapterFactory();

        this.adapters.set(batchId, {
          id: batchId,
          adapter: newAdapter,  // UNIQUE adapter per batch - OWN connection
          state: 'idle', // idle | subscribing | stale | failed | recovering
          health: {
            lastDataAt: Date.now(),
            errorCount: 0,
            retryAttempts: 0,
            lastError: null,
          },
          subscriptionPromise: null,
        });

        this.logger('debug', `AdapterPool: Created unique adapter for ${batchId} (per-connection isolation)`);
      } catch (error) {
        this.logger('error', `AdapterPool: Failed to create adapter for ${batchId}`, { error: error.message });
        throw error;
      }
    }

    return this.adapters.get(batchId);
  }

  /**
   * Start subscription for batch (returns async generator for that batch)
   * Each batch uses its OWN adapter instance
   */
  async subscribeForBatch(batchId, symbols) {
    const wrapper = await this.getBatchAdapter(batchId);  // Get this batch's unique adapter

    if (wrapper.state === 'subscribing') {
      throw new Error(`Batch ${batchId} already subscribing`);
    }

    wrapper.state = 'subscribing';
    wrapper.health.retryAttempts = 0;

    // Return async generator from this batch's OWN adapter
    return wrapper.adapter.subscribe(symbols);
  }

  /**
   * Record successful data reception for batch (batch-local health update)
   * When this batch gets data, only THIS batch's health improves
   */
  recordDataForBatch(batchId) {
    const wrapper = this.adapters.get(batchId);
    if (wrapper) {
      wrapper.health.lastDataAt = Date.now();
      wrapper.health.errorCount = 0;
      wrapper.state = 'idle';
    }
  }

  /**
   * Record error for batch (batch-local error tracking)
   * Error in this batch's connection doesn't affect other batches' connections
   */
  recordErrorForBatch(batchId, error) {
    const wrapper = this.adapters.get(batchId);
    if (wrapper) {
      wrapper.health.errorCount++;
      wrapper.health.lastError = error;
      wrapper.health.retryAttempts++;
      wrapper.state = 'failed';

      this.logger('warn', `AdapterPool: Error for batch [${batchId}] (attempt ${wrapper.health.retryAttempts})`, {
        error: error.message,
      });
    }
  }

  /**
   * Check batch health independently (per-batch stale detection, not global)
   */
  getHealthForBatch(batchId) {
    const wrapper = this.adapters.get(batchId);
    if (!wrapper) return null;

    const timeSinceLastData = Date.now() - wrapper.health.lastDataAt;
    const healthCheckTimeout = this.config.healthCheckTimeoutMs || 60000;
    const isStale = timeSinceLastData > healthCheckTimeout;

    return {
      id: batchId,
      state: wrapper.state,
      isStale,
      timeSinceLastDataMs: timeSinceLastData,
      errorCount: wrapper.health.errorCount,
      retryAttempts: wrapper.health.retryAttempts,
      lastError: wrapper.health.lastError?.message || null,
    };
  }

  /**
   * Get all batch health states (for monitoring and diagnosing)
   */
  getAllBatchHealth() {
    const health = [];
    for (const batchId of this.adapters.keys()) {
      health.push(this.getHealthForBatch(batchId));
    }
    return health;
  }

  /**
   * Reset batch to recover from failure (batch-local recovery)
   * Doesn't affect other batches' connections
   */
  resetBatchForRecovery(batchId) {
    const wrapper = this.adapters.get(batchId);
    if (wrapper) {
      wrapper.state = 'recovering';
      wrapper.health.lastDataAt = Date.now();
      wrapper.health.errorCount = 0;
      // Note: Don't reset retryAttempts - use for exponential backoff
    }
  }

  /**
   * Remove batch from tracking (batch completed or removed)
   */
  async removeBatch(batchId) {
    const wrapper = this.adapters.get(batchId);
    if (wrapper && wrapper.adapter && wrapper.adapter.close) {
      try {
        await wrapper.adapter.close();
      } catch (error) {
        this.logger('warn', `AdapterPool: Error closing adapter for ${batchId}`, { error: error.message });
      }
    }

    this.adapters.delete(batchId);
    this.logger('debug', `AdapterPool: Removed adapter for ${batchId}`);
  }

  /**
   * Get batch state
   */
  getBatchState(batchId) {
    const wrapper = this.adapters.get(batchId);
    return wrapper?.state || null;
  }

  /**
   * Check if batch is currently subscribing
   */
  isBatchSubscribing(batchId) {
    const wrapper = this.adapters.get(batchId);
    return wrapper?.state === 'subscribing';
  }

  /**
   * Get metrics for all batches (for status reporting)
   */
  getMetrics() {
    const metrics = {
      totalBatches: this.adapters.size,
      byState: {
        idle: 0,
        subscribing: 0,
        stale: 0,
        failed: 0,
        recovering: 0,
      },
      health: this.getAllBatchHealth(),
    };

    for (const health of metrics.health) {
      metrics.byState[health.state]++;
    }

    return metrics;
  }

  /**
   * Close all adapters gracefully
   */
  async close() {
    try {
      this.logger('info', `AdapterPool: Closing all batch adapters`);

      // Close each batch's adapter independently
      for (const [batchId, wrapper] of this.adapters.entries()) {
        try {
          if (wrapper.adapter && wrapper.adapter.close) {
            await wrapper.adapter.close();
          }
        } catch (error) {
          this.logger('warn', `AdapterPool: Error closing batch ${batchId}`, { error: error.message });
        }
      }

      this.adapters.clear();
      this.isInitialized = false;

      this.logger('info', `AdapterPool: All adapters closed successfully`);
    } catch (error) {
      this.logger('warn', `AdapterPool: Error during close`, { error: error.message });
    }
  }
}

module.exports = AdapterPool;
