/**
 * HealthRatioPolicy - Global health-connection ratio monitoring
 * Monitors healthy/total batch ratio and triggers controlled restart when degraded
 * Stage 3: Resilience & State Machine Implementation
 */

class HealthRatioPolicy {
  /**
   * Create a new health ratio policy
   * @param {Object} config - Configuration options
   * @param {number} config.minHealthyRatio - Minimum ratio to maintain (0-1, default 0.5)
   * @param {number} config.ratioBreachCycles - Cycles to wait before restart (default 3)
   * @param {number} config.restartCooldownMs - Minimum ms between restarts (default 30000)
   * @param {Function} config.logger - Logger function (optional)
   */
  constructor(config = {}) {
    this.minHealthyRatio = config.minHealthyRatio || 0.5; // 50% healthy minimum
    this.ratioBreachCycles = config.ratioBreachCycles || 3; // 3 cycles before restart
    this.restartCooldownMs = config.restartCooldownMs || 30000; // 30s cooldown

    this.breachCounter = 0; // Track consecutive breach cycles
    this.lastRestartAt = 0; // Timestamp of last restart
    this.breachHistory = []; // Audit trail of all breaches
    this.logger = config.logger || (() => {});
  }

  /**
   * Evaluate health ratio and determine if restart is needed
   * Call once per health-check cycle (e.g., every 15s)
   * @param {Array} batchHealthList - Array of batch health objects
   * @returns {Object} Decision object with shouldRestart flag and reason
   */
  evaluate(batchHealthList) {
    if (!batchHealthList || batchHealthList.length === 0) {
      return {
        shouldRestart: false,
        reason: 'no batches to evaluate',
        healthy: 0,
        total: 0,
        ratio: 0,
      };
    }

    // Count healthy batches (subscribed state)
    const healthy = batchHealthList.filter(h => h.state === 'subscribed').length;
    const total = batchHealthList.length;
    const ratio = healthy / total;

    const meetsMinimum = ratio >= this.minHealthyRatio;

    if (!meetsMinimum) {
      // Health ratio is below threshold
      this.breachCounter++;

      const breachRecord = {
        cycle: this.breachCounter,
        healthy,
        total,
        ratio: ratio.toFixed(2),
        timestamp: Date.now(),
      };

      this.breachHistory.push(breachRecord);

      this.logger(
        'warn',
        `[HealthRatioPolicy] Breach cycle ${this.breachCounter}/${this.ratioBreachCycles}: ` +
        `${healthy}/${total} healthy (${ratio.toFixed(2)} < ${this.minHealthyRatio})`
      );

      // Check if we've breached long enough to trigger restart
      if (this.breachCounter >= this.ratioBreachCycles) {
        const timeSinceLastRestart = Date.now() - this.lastRestartAt;

        // Check cooldown to prevent restart loops
        if (timeSinceLastRestart >= this.restartCooldownMs) {
          this.lastRestartAt = Date.now();
          this.breachCounter = 0; // Reset counter after restart
          const reason =
            `health ratio ${ratio.toFixed(2)} < ${this.minHealthyRatio} ` +
            `for ${this.ratioBreachCycles} consecutive cycles`;

          this.logger(
            'warn',
            `[HealthRatioPolicy] Triggering controlled restart: ${reason}`
          );

          return {
            shouldRestart: true,
            reason: reason,
            healthy,
            total,
            ratio: ratio.toFixed(2),
            breachCycles: this.ratioBreachCycles,
          };
        } else {
          // Cooldown still active
          const remainingCooldown = Math.ceil(
            (this.restartCooldownMs - timeSinceLastRestart) / 1000
          );
          return {
            shouldRestart: false,
            reason: `restart triggered but cooldown active (${remainingCooldown}s remaining)`,
            healthy,
            total,
            ratio: ratio.toFixed(2),
          };
        }
      }
    } else {
      // Health ratio is healthy - reset breach counter
      if (this.breachCounter > 0) {
        this.logger(
          'info',
          `[HealthRatioPolicy] Health recovered: ${healthy}/${total} healthy (${ratio.toFixed(2)})`
        );
        this.breachCounter = 0;
      }
    }

    return {
      shouldRestart: false,
      reason: 'health ratio acceptable',
      healthy,
      total,
      ratio: ratio.toFixed(2),
    };
  }

  /**
   * Reset policy state (for testing or manual reset)
   */
  reset() {
    this.breachCounter = 0;
    this.lastRestartAt = 0;
    this.logger('debug', '[HealthRatioPolicy] Policy reset');
  }

  /**
   * Get breach history
   * @returns {Array} Array of breach records
   */
  getBreachHistory() {
    return this.breachHistory.map(rec => ({ ...rec }));
  }

  /**
   * Get policy state snapshot (for debugging)
   * @returns {Object} Complete policy state
   */
  getSnapshot() {
    return {
      config: {
        minHealthyRatio: this.minHealthyRatio,
        ratioBreachCycles: this.ratioBreachCycles,
        restartCooldownMs: this.restartCooldownMs,
      },
      currentState: {
        breachCounter: this.breachCounter,
        lastRestartAt: new Date(this.lastRestartAt).toISOString(),
        breachHistoryLength: this.breachHistory.length,
      },
    };
  }

  /**
   * Get time until restart is allowed (if cooldown is active)
   * @returns {number} Milliseconds remaining in cooldown, or 0 if cooldown inactive
   */
  getRestartCooldownRemaining() {
    const timeSinceLastRestart = Date.now() - this.lastRestartAt;

    if (timeSinceLastRestart < this.restartCooldownMs) {
      return this.restartCooldownMs - timeSinceLastRestart;
    }

    return 0;
  }
}

module.exports = HealthRatioPolicy;
