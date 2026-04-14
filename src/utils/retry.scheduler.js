/**
 * RetryScheduler - Exponential Backoff Calculator
 *
 * Calculates exponential backoff delays for retry logic.
 * Formula: baseDelay * (2 ^ (attempt - 1)), capped at maxDelay
 *
 * Example:
 *   const scheduler = new RetryScheduler({baseDelayMs: 1000, maxDelayMs: 60000});
 *   const delay1 = scheduler.calculateBackoff(1);  // 1000ms
 *   const delay2 = scheduler.calculateBackoff(2);  // 2000ms
 *   const delay3 = scheduler.calculateBackoff(3);  // 4000ms
 *   const delay4 = scheduler.calculateBackoff(4);  // 8000ms
 *   const delay5 = scheduler.calculateBackoff(5);  // 16000ms (capped at next iteration)
 */

class RetryScheduler {
  constructor(config = {}) {
    this.config = {
      baseDelayMs: config.baseDelayMs || 1000,
      maxDelayMs: config.maxDelayMs || 60000,
    };
  }

  /**
   * Calculate backoff delay for given attempt number
   * @param {number} attempt - Attempt number (1-based)
   * @returns {number} Delay in milliseconds
   */
  calculateBackoff(attempt) {
    if (attempt < 1) {
      return this.config.baseDelayMs;
    }

    // Formula: baseDelay * (2 ^ (attempt - 1))
    const exponentialDelay = this.config.baseDelayMs * Math.pow(2, attempt - 1);

    // Cap at max delay
    return Math.min(exponentialDelay, this.config.maxDelayMs);
  }
}

module.exports = RetryScheduler;
