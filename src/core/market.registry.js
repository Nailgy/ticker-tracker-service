/**
 * MarketRegistry - Symbol State Machine with Hard Non-Retryable Eviction (STAGE 3)
 *
 * Encapsulates all symbol lifecycle management:
 * - Desired symbols (from exchange markets)
 * - Active symbols (currently tracking)
 * - Non-retryable symbols (permanently failed/delisted)
 * - Batch allocations (which batch owns which symbols)
 *
 * Stage 3 Enhancement:
 * - Hard eviction: removes from BOTH desired AND active sets
 * - Metadata tracking: reason, firstSeen, lastSeen, batchId
 * - Can't be re-added by market refresh (removal from desired is hard)
 *
 * No external mutations of state - all changes go through public methods.
 *
 * Usage:
 *   const registry = new MarketRegistry(config);
 *   await registry.loadDesiredMarkets(exchangeAdapter);
 *   registry.addSymbols(newSymbols);
 *   const {added, removed} = registry.getDiffSince(previousState);
 *   registry.markNonRetryable(failedSymbols, 'delisted');  // Hard eviction + metadata
 */

const NonRetryableRegistry = require('./non-retryable-registry');

class MarketRegistry {
  constructor(config = {}) {
    this.config = {
      logger: config.logger || this._defaultLogger,
      ...config,
    };

    // Symbol tracking
    this.desiredSymbols = new Set();          // What exchange offers
    this.activeSymbols = new Set();           // Currently tracking
    this.nonRetryableSymbols = new Set();     // Permanently failed

    // Batch allocation
    this.batchAllocations = new Map();        // Map<batchId, Set<symbol>>
    this.symbolToBatchMap = new Map();        // Map<symbol, batchId> (reverse lookup)

    // Stage 3: Non-retryable metadata registry
    this.nonRetryableMetadata = new NonRetryableRegistry({ logger: this.config.logger });

    // Metrics
    this.metrics = {
      desiredCount: 0,
      activeCount: 0,
      nonRetryableCount: 0,
      batchAllocations: 0,
    };
  }

  /**
   * Default logger
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[MarketRegistry:${level.toUpperCase()}] ${message}`, data || '');
  }

  /**
   * Load desired markets from adapter
   */
  async loadDesiredMarkets(adapter) {
    try {
      this.config.logger('debug', `MarketRegistry: Loading desired markets from adapter`);

      const markets = await adapter.loadMarkets();
      const symbols = markets.map(m => m.symbol);

      this.desiredSymbols = new Set(symbols);
      this._updateMetrics();

      this.config.logger('info', `MarketRegistry: Desired markets loaded`, {
        symbolCount: this.desiredSymbols.size,
      });

      return { symbols, count: symbols.length };
    } catch (error) {
      this.config.logger('error', `MarketRegistry: Failed to load desired markets`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Add new symbols to active tracking
   * Automatically allocates to batches
   */
  addSymbols(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return { added: [], existingCount: this.activeSymbols.size };
    }

    const added = [];

    for (const symbol of symbols) {
      if (!this.activeSymbols.has(symbol)) {
        this.activeSymbols.add(symbol);
        added.push(symbol);

        // Remove from non-retryable if it was there (re-enabling)
        this.nonRetryableSymbols.delete(symbol);
      }
    }

    this._updateMetrics();

    if (added.length > 0) {
      this.config.logger('debug', `MarketRegistry: Symbols added to active tracking`, {
        count: added.length,
        examples: added.slice(0, 3),
      });
    }

    return { added, existingCount: this.activeSymbols.size };
  }

  /**
   * Remove symbols from active tracking
   * (but keep in desired and leave non-retryable alone)
   */
  removeSymbols(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return { removed: [], remainingCount: this.activeSymbols.size };
    }

    const removed = [];

    for (const symbol of symbols) {
      if (this.activeSymbols.has(symbol)) {
        this.activeSymbols.delete(symbol);
        removed.push(symbol);

        // Also remove from batch allocations
        const batchId = this.symbolToBatchMap.get(symbol);
        if (batchId) {
          const batch = this.batchAllocations.get(batchId);
          if (batch) {
            batch.delete(symbol);
          }
          this.symbolToBatchMap.delete(symbol);
        }
      }
    }

    this._updateMetrics();

    if (removed.length > 0) {
      this.config.logger('debug', `MarketRegistry: Symbols removed from active tracking`, {
        count: removed.length,
        examples: removed.slice(0, 3),
      });
    }

    return { removed, remainingCount: this.activeSymbols.size };
  }

  /**
   * Mark symbols as non-retryable (permanent failure)
   * Stage 3: Hard eviction from BOTH active AND desired (can't be re-added by refresh)
   * @param {Array} symbols - Symbols to mark
   * @param {string} reason - Reason (delisted, invalid, banned, etc.)
   * @param {Object} metadata - Additional context ({batchId, errorMessage, etc.})
   */
  markNonRetryable(symbols, reason = 'unknown', metadata = {}) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return { marked: [] };
    }

    const marked = [];

    for (const symbol of symbols) {
      if (!this.nonRetryableSymbols.has(symbol)) {
        // Stage 1: Remove from active
        this.activeSymbols.delete(symbol);

        // Stage 2 (NEW): Remove from DESIRED - hard eviction, can't be re-added by refresh
        this.desiredSymbols.delete(symbol);

        marked.push(symbol);

        // Stage 3: Remove from batch allocations
        const batchId = this.symbolToBatchMap.get(symbol);
        if (batchId) {
          const batch = this.batchAllocations.get(batchId);
          if (batch) {
            batch.delete(symbol);
          }
          this.symbolToBatchMap.delete(symbol);
        }

        // Stage 4 (NEW): Add to non-retryable set
        this.nonRetryableSymbols.add(symbol);

        // Stage 5 (NEW): Track metadata for forensics
        this.nonRetryableMetadata.markNonRetryable(symbol, reason, {
          ...metadata,
          batchId: batchId || null
        });
      }
    }

    this._updateMetrics();

    if (marked.length > 0) {
      this.config.logger('info', `MarketRegistry: Symbols marked non-retryable (hard eviction from desired+active)`, {
        count: marked.length,
        reason: reason,
        examples: marked.slice(0, 3),
      });
    }

    return { marked, auditTrail: this.nonRetryableMetadata.getAuditTrail() };
  }

  /**
   * Allocate symbols to batches
   */
  allocateToBatches(batchIds) {
    if (!Array.isArray(batchIds) || batchIds.length === 0) {
      return { totalSymbols: this.activeSymbols.size, batches: 0 };
    }

    // Clear existing allocations
    this.batchAllocations.clear();
    this.symbolToBatchMap.clear();

    // Initialize batch sets
    for (const batchId of batchIds) {
      this.batchAllocations.set(batchId, new Set());
    }

    // Allocate symbols round-robin
    const activeArray = Array.from(this.activeSymbols);
    for (let i = 0; i < activeArray.length; i++) {
      const symbol = activeArray[i];
      const batchIndex = i % batchIds.length;
      const batchId = batchIds[batchIndex];

      this.batchAllocations.get(batchId).add(symbol);
      this.symbolToBatchMap.set(symbol, batchId);
    }

    this.config.logger('debug', `MarketRegistry: Symbols allocated to batches`, {
      totalSymbols: activeArray.length,
      batches: batchIds.length,
      symbolsPerBatch: Math.ceil(activeArray.length / batchIds.length),
    });

    this._updateMetrics();

    return {
      totalSymbols: activeArray.length,
      batches: batchIds.length,
      allocations: this.batchAllocations,
    };
  }

  /**
   * Get diff between desired markets and current active
   */
  getDiffSince(previousState) {
    const previousDesired = previousState?.desiredSymbols || new Set();

    const currentDesired = this.desiredSymbols;
    const added = [...currentDesired].filter(s => !previousDesired.has(s));
    const removed = [...previousDesired].filter(s => !currentDesired.has(s));

    return { added, removed };
  }

  /**
   * Get all desired symbols
   */
  getDesiredSymbols() {
    return new Set(this.desiredSymbols);
  }

  /**
   * Get all active symbols
   */
  getActiveSymbols() {
    return new Set(this.activeSymbols);
  }

  /**
   * Get all non-retryable symbols
   */
  getNonRetryableSymbols() {
    return new Set(this.nonRetryableSymbols);
  }

  /**
   * Get non-retryable metadata audit trail (Stage 3)
   * For forensics: when, why, and where each symbol was evicted
   */
  getNonRetryableAuditTrail() {
    return this.nonRetryableMetadata.getAuditTrail();
  }

  /**
   * Get non-retryable stats (Stage 3)
   * Break down by reason, batch, attempts
   */
  getNonRetryableStats() {
    return this.nonRetryableMetadata.getStats();
  }

  /**
   * Get batch allocations as array format for compatibility
   */
  getAllocationsAsArray() {
    const result = [];
    for (const [batchId, symbols] of this.batchAllocations.entries()) {
      result.push({
        batchId,
        symbols: Array.from(symbols),
        count: symbols.size,
      });
    }
    return result;
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Update metrics
   */
  _updateMetrics() {
    this.metrics = {
      desiredCount: this.desiredSymbols.size,
      activeCount: this.activeSymbols.size,
      nonRetryableCount: this.nonRetryableSymbols.size,
      batchAllocations: this.batchAllocations.size,
    };
  }
}

module.exports = MarketRegistry;
