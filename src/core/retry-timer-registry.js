/**
 * RetryTimerRegistry - Per-batch retry timer management
 * Tracks all pending retry timers to enable clean cancellation on shutdown or batch removal
 * Stage 3: Resilience & State Machine Implementation
 */

class RetryTimerRegistry {
  /**
   * Create a new timer registry
   * @param {Object} config - Configuration options
   * @param {Function} config.logger - Logger function (optional)
   */
  constructor(config = {}) {
    this.timers = new Map(); // Map<batchId, Set<timeoutHandle>>
    this.config = config;
    this.logger = config.logger || (() => {});
  }

  /**
   * Register a pending retry timer for a batch
   * @param {string} batchId - Batch identifier
   * @param {number} timeoutHandle - Timer handle returned by setTimeout
   * @returns {number} The timeout handle (for convenience)
   */
  registerTimer(batchId, timeoutHandle) {
    if (!this.timers.has(batchId)) {
      this.timers.set(batchId, new Set());
    }

    this.timers.get(batchId).add(timeoutHandle);
    return timeoutHandle;
  }

  /**
   * Cancel all pending timers for a specific batch
   * Called when a batch is being removed or stopped
   * @param {string} batchId - Batch identifier
   * @returns {Object} Result object with batchId and count of cancelled timers
   */
  cancelBatchTimers(batchId) {
    const handles = this.timers.get(batchId) || new Set();
    let cancelled = 0;

    for (const handle of handles) {
      clearTimeout(handle);
      cancelled++;
    }

    this.timers.delete(batchId);

    if (cancelled > 0) {
      this.logger(
        'debug',
        `[RetryTimerRegistry] Cancelled ${cancelled} retry timer(s) for batch: ${batchId}`
      );
    }

    return { batchId, cancelled };
  }

  /**
   * Cancel all pending timers across all batches
   * Called on engine shutdown to prevent orphaned timers
   * @returns {Object} Result object with total count of cancelled timers
   */
  cancelAllTimers() {
    let totalCancelled = 0;

    for (const [batchId, handles] of this.timers.entries()) {
      for (const handle of handles) {
        clearTimeout(handle);
        totalCancelled++;
      }
    }

    this.timers.clear();

    if (totalCancelled > 0) {
      this.logger(
        'debug',
        `[RetryTimerRegistry] Cancelled all ${totalCancelled} retry timer(s) across all batches`
      );
    }

    return { totalCancelled };
  }

  /**
   * Get count of pending timers per batch
   * Useful for monitoring and debugging
   * @returns {Object} Map of batchId to pending timer count
   */
  getStats() {
    const stats = {};

    for (const [batchId, handles] of this.timers.entries()) {
      stats[batchId] = handles.size;
    }

    return stats;
  }

  /**
   * Get total count of pending timers across all batches
   * @returns {number} Total pending timer count
   */
  getTotalPendingTimers() {
    let total = 0;

    for (const handles of this.timers.values()) {
      total += handles.size;
    }

    return total;
  }

  /**
   * Check if any timers are pending for a batch
   * @param {string} batchId - Batch identifier
   * @returns {boolean} True if timers are pending for this batch
   */
  hasPendingTimers(batchId) {
    const handles = this.timers.get(batchId);
    return handles && handles.size > 0;
  }

  /**
   * Get all batches with pending timers
   * @returns {Array<string>} Array of batch IDs with pending timers
   */
  getBatchesWithPendingTimers() {
    return Array.from(this.timers.keys());
  }

  /**
   * Remove a specific timer handle from tracking
   * Called after timer executes or is manually cleared
   * @param {string} batchId - Batch identifier
   * @param {number} timeoutHandle - Timer handle to remove
   */
  removeTimer(batchId, timeoutHandle) {
    const handles = this.timers.get(batchId);
    if (handles) {
      handles.delete(timeoutHandle);
      if (handles.size === 0) {
        this.timers.delete(batchId);
      }
    }
  }

  /**
   * Get full registry state (for debugging/serialization)
   * @returns {Object} Complete registry state
   */
  getSnapshot() {
    const snapshot = {
      totalBatches: this.timers.size,
      totalTimers: this.getTotalPendingTimers(),
      perBatch: this.getStats(),
    };

    return snapshot;
  }

  /**
   * Clear all timers and reset registry
   */
  reset() {
    this.cancelAllTimers();
    this.logger('debug', '[RetryTimerRegistry] Registry reset');
  }
}

module.exports = RetryTimerRegistry;
