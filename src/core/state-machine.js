/**
 * ConnectionStateMachine - Explicit state machine for per-batch connections
 * Provides guarded transitions, audit trail, and reason tracking for all state changes.
 * Stage 3: Resilience & State Machine Implementation
 */

class ConnectionStateMachine {
  /**
   * Create a new state machine for a batch connection
   * @param {string} batchId - Unique batch identifier
   * @param {Object} config - Configuration options
   * @param {Function} config.logger - Logger function (optional)
   */
  constructor(batchId, config = {}) {
    this.batchId = batchId;
    this.currentState = 'idle';
    this.transitionHistory = [];
    this.logger = config.logger || (() => {});

    // Define legal state transitions as adjacency map
    // Valid transitions: from state -> [list of allowed next states]
    this.legalTransitions = {
      'idle': ['connecting', 'failed'],
      'connecting': ['subscribed', 'stale', 'failed'],
      'subscribed': ['stale', 'connecting', 'failed'],
      'stale': ['recovering', 'failed'],
      'recovering': ['subscribed', 'failed'],
      'failed': ['connecting'], // Only retry from failed
    };

    // Allowed states for quick validation
    this.allowedStates = Object.keys(this.legalTransitions);
  }

  /**
   * Perform a guarded state transition with reason tracking
   * @param {string} newState - Target state
   * @param {string} reason - Human-readable reason for transition
   * @param {Object} metadata - Additional context (optional)
   * @returns {Object} Transition record with timestamps
   * @throws {Error} If transition is not legal from current state
   */
  transition(newState, reason = '', metadata = {}) {
    // Validate new state exists
    if (!this.allowedStates.includes(newState)) {
      throw new Error(
        `Invalid state: ${newState} [batch: ${this.batchId}]. ` +
        `Allowed states: ${this.allowedStates.join(', ')}`
      );
    }

    // Validate transition is legal
    const legal = this.legalTransitions[this.currentState] || [];
    if (!legal.includes(newState)) {
      throw new Error(
        `Illegal transition: ${this.currentState} → ${newState} [batch: ${this.batchId}]. ` +
        `Legal transitions: ${legal.join(', ')}`
      );
    }

    // Create audit record
    const record = {
      from: this.currentState,
      to: newState,
      reason: reason,
      timestamp: Date.now(),
      metadata: metadata,
    };

    // Persist in history
    this.transitionHistory.push(record);
    this.currentState = newState;

    // Log for observability
    this.logger(
      'debug',
      `[${this.batchId}] State transition: ${record.from} → ${record.to} (${reason})`
    );

    return record;
  }

  /**
   * Get the current state
   * @returns {string} Current state
   */
  getState() {
    return this.currentState;
  }

  /**
   * Get full transition history (copy to prevent mutations)
   * @returns {Array} Array of transition records
   */
  getTransitionHistory() {
    return this.transitionHistory.map(rec => ({ ...rec }));
  }

  /**
   * Get transition history with optional filtering
   * @param {Object} filter - Filter options
   * @param {string} filter.fromState - Filter by source state
   * @param {string} filter.toState - Filter by destination state
   * @param {string} filter.reason - Filter by reason substring
   * @returns {Array} Filtered transition records
   */
  getTransitionHistoryFiltered(filter = {}) {
    let history = this.transitionHistory;

    if (filter.fromState) {
      history = history.filter(rec => rec.from === filter.fromState);
    }
    if (filter.toState) {
      history = history.filter(rec => rec.to === filter.toState);
    }
    if (filter.reason) {
      history = history.filter(rec =>
        rec.reason.toLowerCase().includes(filter.reason.toLowerCase())
      );
    }

    return history.map(rec => ({ ...rec }));
  }

  /**
   * Get count of transitions by type
   * @returns {Object} Map of transition types to counts
   */
  getTransitionStats() {
    const stats = {};

    for (const record of this.transitionHistory) {
      const key = `${record.from}→${record.to}`;
      stats[key] = (stats[key] || 0) + 1;
    }

    return stats;
  }

  /**
   * Reset state machine to initial state (for testing/cleanup)
   * @param {string} reason - Reason for reset
   */
  reset(reason = 'manual reset') {
    this.transitionHistory = [];
    this.currentState = 'idle';
    this.logger('debug', `[${this.batchId}] State machine reset (${reason})`);
  }

  /**
   * Get full state snapshot (for serialization/debugging)
   * @returns {Object} Complete state snapshot
   */
  getSnapshot() {
    return {
      batchId: this.batchId,
      currentState: this.currentState,
      historyLength: this.transitionHistory.length,
      history: this.getTransitionHistory(),
      stats: this.getTransitionStats(),
    };
  }
}

module.exports = ConnectionStateMachine;
