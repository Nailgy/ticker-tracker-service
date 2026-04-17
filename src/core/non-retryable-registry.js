/**
 * NonRetryableRegistry - Metadata tracking for permanently non-retryable symbols
 * Tracks reason, firstSeen, lastSeen, attempts, and batch context
 * Enables hard eviction from BOTH active AND desired symbol sets
 * Stage 3: Resilience & State Machine Implementation
 */

class NonRetryableRegistry {
  /**
   * Create a non-retryable registry
   * @param {Object} config - Configuration options
   * @param {Function} config.logger - Logger function (optional)
   */
  constructor(config = {}) {
    this.symbolsRegistry = new Map(); // symbol → { metadata }
    this.logger = config.logger || (() => {});
  }

  /**
   * Mark a symbol as permanently non-retryable with full metadata
   * @param {string} symbol - Symbol to mark
   * @param {string} reason - Reason for marking (delisted, invalid, banned, etc.)
   * @param {Object} metadata - Additional context (batchId, errorMessage, etc.)
   * @returns {Object} Registration record
   */
  markNonRetryable(symbol, reason = 'unknown', metadata = {}) {
    let record = this.symbolsRegistry.get(symbol);

    if (!record) {
      // First time seeing this symbol as non-retryable
      record = {
        symbol,
        reason,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        attempts: 1,
        batchId: metadata.batchId || null,
        errorMessage: metadata.errorMessage || null,
        metadata: metadata,
      };
    } else {
      // Already marked, increment attempt count
      record.lastSeen = Date.now();
      record.attempts++;
    }

    this.symbolsRegistry.set(symbol, record);

    this.logger(
      'warn',
      `[NonRetryableRegistry] Marked ${symbol} as non-retryable: ${reason}` +
        (metadata.batchId ? ` [batch: ${metadata.batchId}]` : '')
    );

    return record;
  }

  /**
   * Check if a symbol is marked as non-retryable
   * @param {string} symbol - Symbol to check
   * @returns {boolean} True if non-retryable
   */
  isNonRetryable(symbol) {
    return this.symbolsRegistry.has(symbol);
  }

  /**
   * Get metadata for a specific non-retryable symbol
   * @param {string} symbol - Symbol to query
   * @returns {Object|null} Symbol record or null if not found
   */
  getSymbolRecord(symbol) {
    return this.symbolsRegistry.get(symbol) || null;
  }

  /**
   * Get all non-retryable symbols
   * @returns {Array<string>} Array of symbols marked non-retryable
   */
  getAllNonRetryableSymbols() {
    return Array.from(this.symbolsRegistry.keys());
  }

  /**
   * Get full audit trail for all non-retryable symbols
   * @returns {Array} Array of all symbol records
   */
  getAuditTrail() {
    return Array.from(this.symbolsRegistry.values()).map(rec => ({ ...rec }));
  }

  /**
   * Get stats on non-retryable symbols
   * @returns {Object} Stats including count, reasons breakdown, etc.
   */
  getStats() {
    const stats = {
      totalNonRetryable: this.symbolsRegistry.size,
      byReason: {},
      byBatch: {},
      totalAttempts: 0,
    };

    for (const record of this.symbolsRegistry.values()) {
      // Count by reason
      stats.byReason[record.reason] = (stats.byReason[record.reason] || 0) + 1;

      // Count by batch
      if (record.batchId) {
        stats.byBatch[record.batchId] = (stats.byBatch[record.batchId] || 0) + 1;
      }

      // Total attempts
      stats.totalAttempts += record.attempts;
    }

    return stats;
  }

  /**
   * Get symbols marked non-retryable in a specific batch
   * @param {string} batchId - Batch identifier
   * @returns {Array<string>} Symbols from that batch
   */
  getSymbolsByBatch(batchId) {
    const symbols = [];

    for (const [symbol, record] of this.symbolsRegistry.entries()) {
      if (record.batchId === batchId) {
        symbols.push(symbol);
      }
    }

    return symbols;
  }

  /**
   * Get symbols marked for a specific reason
   * @param {string} reason - Reason to filter by
   * @returns {Array<string>} Symbols with that reason
   */
  getSymbolsByReason(reason) {
    const symbols = [];

    for (const [symbol, record] of this.symbolsRegistry.entries()) {
      if (record.reason === reason) {
        symbols.push(symbol);
      }
    }

    return symbols;
  }

  /**
   * Clear a symbol from non-retryable (allow retry again)
   * @param {string} symbol - Symbol to allow retry
   * @returns {boolean} True if was marked non-retryable
   */
  clearSymbol(symbol) {
    const wasMarked = this.symbolsRegistry.has(symbol);

    if (wasMarked) {
      this.symbolsRegistry.delete(symbol);
      this.logger('info', `[NonRetryableRegistry] Cleared non-retryable status for ${symbol}`);
    }

    return wasMarked;
  }

  /**
   * Clear all non-retryable symbols (for testing or reset)
   */
  clearAll() {
    const count = this.symbolsRegistry.size;
    this.symbolsRegistry.clear();

    if (count > 0) {
      this.logger('debug', `[NonRetryableRegistry] Cleared all ${count} non-retryable symbols`);
    }
  }

  /**
   * Get full registry snapshot for debugging
   * @returns {Object} Complete state
   */
  getSnapshot() {
    return {
      totalNonRetryable: this.symbolsRegistry.size,
      stats: this.getStats(),
      symbols: this.getAuditTrail(),
    };
  }
}

module.exports = NonRetryableRegistry;
