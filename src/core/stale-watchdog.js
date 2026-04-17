/**
 * StaleWatchdog - Per-batch stale connection escalation model
 * Escalates: HEALTHY → WARNED → RECOVERING → FAILED
 * Enables per-batch recovery before global restart via health ratio policy
 * Stage 3: Resilience & State Machine Implementation
 */

class StaleWatchdog {
  /**
   * Create a stale watchdog for a batch
   * @param {string} batchId - Batch identifier
   * @param {Object} config - Configuration options
   * @param {number} config.staleTimeoutMs - Stale threshold (default 60000ms)
   * @param {Function} config.logger - Logger function (optional)
   */
  constructor(batchId, config = {}) {
    this.batchId = batchId;
    this.staleTimeoutMs = config.staleTimeoutMs || 60000; // 60s stale threshold
    this.lastDataAt = Date.now();

    // Escalation levels
    this.escalationLevels = {
      HEALTHY: 0,
      WARNED: 1,
      RECOVERING: 2,
      FAILED: 3,
    };

    this.currentLevel = this.escalationLevels.HEALTHY;
    this.escalationHistory = [];
    this.logger = config.logger || (() => {});
  }

  /**
   * Record ticker data received - use to reset escalation on recovery
   * @param {number} timestamp - Timestamp of data reception (default now)
   */
  recordData(timestamp = Date.now()) {
    this.lastDataAt = timestamp;

    // If data received while degraded, mark recovery
    if (this.currentLevel > this.escalationLevels.HEALTHY) {
      this._recordEscalation('DATA_RECEIVED', this.escalationLevels.HEALTHY, 'connection recovered');
      this.currentLevel = this.escalationLevels.HEALTHY;
    }
  }

  /**
   * Check for staleness and escalate if needed
   * Call from health-check interval (e.g., every 15s)
   * @param {number} currentTime - Current timestamp (default now)
   * @returns {Object} { action, level, reason } - What action to take
   */
  checkStale(currentTime = Date.now()) {
    const timeSinceData = currentTime - this.lastDataAt;

    if (timeSinceData > this.staleTimeoutMs) {
      // Escalate based on current level
      switch (this.currentLevel) {
        case this.escalationLevels.HEALTHY:
          this._recordEscalation(
            'STALE_DETECTED',
            this.escalationLevels.WARNED,
            `no data for ${timeSinceData}ms`
          );
          this.currentLevel = this.escalationLevels.WARNED;
          return { action: 'warn', level: 'WARNED', ms: timeSinceData };

        case this.escalationLevels.WARNED:
          this._recordEscalation(
            'ESCALATE_RECOVER',
            this.escalationLevels.RECOVERING,
            'attempt per-batch recovery'
          );
          this.currentLevel = this.escalationLevels.RECOVERING;
          return { action: 'recover', level: 'RECOVERING', ms: timeSinceData };

        case this.escalationLevels.RECOVERING:
          this._recordEscalation(
            'ESCALATE_FAIL',
            this.escalationLevels.FAILED,
            'recovery failed, batch stale'
          );
          this.currentLevel = this.escalationLevels.FAILED;
          return { action: 'fail', level: 'FAILED', ms: timeSinceData };

        case this.escalationLevels.FAILED:
          return { action: 'none', level: 'FAILED', reason: 'already failed', ms: timeSinceData };
      }
    }

    return { action: 'none', level: this.getLevelName(), ms: timeSinceData };
  }

  /**
   * Get current escalation level name
   * @returns {string} Current level name (HEALTHY, WARNED, RECOVERING, FAILED)
   */
  getLevelName() {
    const names = ['HEALTHY', 'WARNED', 'RECOVERING', 'FAILED'];
    return names[this.currentLevel] || 'UNKNOWN';
  }

  /**
   * Get current escalation level (numeric)
   * @returns {number} Current level
   */
  getLevel() {
    return this.currentLevel;
  }

  /**
   * Reset watchdog to healthy state (for testing or manual reset)
   */
  reset() {
    this.lastDataAt = Date.now();
    this.currentLevel = this.escalationLevels.HEALTHY;
    this.logger('debug', `[${this.batchId}] StaleWatchdog reset to HEALTHY`);
  }

  /**
   * Get escalation audit trail
   * @returns {Array} Array of escalation records
   */
  getEscalationHistory() {
    return this.escalationHistory.map(rec => ({ ...rec }));
  }

  /**
   * Get watchdog snapshot for debugging
   * @returns {Object} Complete watchdog state
   */
  getSnapshot() {
    return {
      batchId: this.batchId,
      currentLevel: this.getLevelName(),
      lastDataAt: new Date(this.lastDataAt).toISOString(),
      staleTimeoutMs: this.staleTimeoutMs,
      historyLength: this.escalationHistory.length,
      history: this.getEscalationHistory(),
    };
  }

  /**
   * Record an escalation event in history
   * @private
   */
  _recordEscalation(event, newLevel, reason) {
    const previousLevel = this.currentLevel;
    const names = ['HEALTHY', 'WARNED', 'RECOVERING', 'FAILED'];

    const record = {
      event,
      from: names[previousLevel],
      to: names[newLevel],
      reason,
      timestamp: Date.now(),
    };

    this.escalationHistory.push(record);

    this.logger(
      'debug',
      `[${this.batchId}] StaleWatchdog escalation: ${record.from} → ${record.to} (${reason})`
    );
  }
}

module.exports = StaleWatchdog;
