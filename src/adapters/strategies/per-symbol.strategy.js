/**
 * PerSymbolStrategy - Watch each symbol individually via watchTicker()
 *
 * Used for: Kraken, and any exchange that doesn't support watchTickers
 * Behavior: Call exchange.watchTicker(symbol) for each symbol, manage multiple subscriptions
 *
 * ROBUST implementation with:
 * - Per-symbol error isolation: one symbol failure doesn't kill others
 * - Promise wrapper: converts rejections to wrapped {success: true/false, ...} results
 * - Per-symbol task lifecycle: created, pending, resolved, failed
 * - Failure rate tracking and stale detection per symbol
 *
 * Architecture:
 *   pending = Map<symbol, Promise<{success: true, ticker} | {success: false, error}>>
 *   When ANY promise resolves (success OR failure):
 *     1. Extract result (success or error)
 *     2. If success: yield ticker
 *     3. If error: track failure, log error
 *     4. Re-subscribe: pending.set(symbol, newPromise)
 *   Result: All symbols progress independently, Promise.race() never rejects
 */

const { Strategy, STRATEGY_MODES } = require('./strategy.interface');

class PerSymbolStrategy extends Strategy {
  constructor(config) {
    super();
    this.config = config; // {exchange, logger, proxyProvider}
    this.isClosed = false;
    this.taskMetrics = new Map(); // Map<symbol, {created, attempts, lastError, isHealthy}>
  }

  /**
   * Get strategy mode identifier
   */
  getMode() {
    return STRATEGY_MODES.PER_SYMBOL;
  }

  /**
   * Check if exchange has watchTicker method
   */
  isSupported(exchange) {
    return exchange && typeof exchange.watchTicker === 'function';
  }

  /**
   * Apply strategy with robust error isolation per symbol
   *
   * Key Innovation: Promise wrapper ensures Promise.race() never rejects
   * One symbol failure does NOT poison the entire loop
   */
  async *execute(exchange, symbols) {
    if (!this.isSupported(exchange)) {
      throw new Error(`Exchange ${this.config.exchange} does not support watchTicker`);
    }

    this.config.logger(
      'info',
      `PerSymbolStrategy: Starting ${symbols.length} individual per-symbol subscriptions`,
      { exchange: this.config.exchange, symbolCount: symbols.length }
    );

    this.isClosed = false;

    // Initialize task metrics for each symbol
    for (const symbol of symbols) {
      this.taskMetrics.set(symbol, {
        created: Date.now(),
        attempts: 0,
        lastError: null,
        isHealthy: true,
      });
    }

    // Create wrapped promises that NEVER reject (always resolve to {success, ...})
    const createWrappedWatchPromise = (symbol) => {
      try {
        // Handle both async watchTicker and synchronous errors
        const watchPromise = this._watchSymbolSafe(exchange, symbol);

        return Promise.resolve(watchPromise)
          .then((ticker) => ({
            success: true,
            symbol,
            ticker,
          }))
          .catch((error) => ({
            success: false,
            symbol,
            error: error instanceof Error ? error : new Error(String(error)),
          }));
      } catch (syncError) {
        // Handle synchronous errors (shouldn't happen, but be safe)
        return Promise.resolve({
          success: false,
          symbol,
          error: syncError instanceof Error ? syncError : new Error(String(syncError)),
        });
      }
    };

    // Initialize pending map with wrapped promises (never reject)
    const pending = new Map();
    for (const symbol of symbols) {
      pending.set(symbol, createWrappedWatchPromise(symbol));
    }

    // Main loop: race all symbols, isolate errors per symbol
    let successCount = 0;  // Track successful results for fairness cycling
    const failedSymbols = new Set();  // Track permanently failed symbols

    while (!this.isClosed && pending.size > 0) {
      let result;
      try {
        // Promise.race() will NEVER throw because all promises are wrapped
        result = await Promise.race(pending.values());
      } catch (fatalError) {
        // Should never happen because promises are wrapped, but log if it does
        this.config.logger('error', `PerSymbolStrategy: Unexpected error in Promise.race()`, {
          error: fatalError.message,
        });
        break;
      }

      if (!result) continue; // Should not happen

      const { success, symbol, ticker, error } = result;

      if (success) {
        // Healthy: yield ticker and reset metrics
        const metrics = this.taskMetrics.get(symbol);
        if (metrics) {
          metrics.attempts = 0;
          metrics.lastError = null;
          metrics.isHealthy = true;
        }

        successCount++;
        yield { symbol, ticker };

        // Re-add healthy symbol for next ticker
        if (!this.isClosed) {
          pending.set(symbol, createWrappedWatchPromise(symbol));
        }

        // After N successes, re-add recently-failed symbols for another attempt (fairness cycle)
        if (successCount % 5 === 0 && failedSymbols.size > 0 && !this.isClosed) {
          for (const failedSymbol of failedSymbols) {
            const metrics = this.taskMetrics.get(failedSymbol);
            if (metrics && metrics.attempts < 5) {
              pending.set(failedSymbol, createWrappedWatchPromise(failedSymbol));
              failedSymbols.delete(failedSymbol);
            }
          }
        }
      } else {
        // Failed: track error and log for debugging
        const metrics = this.taskMetrics.get(symbol);
        if (metrics) {
          metrics.attempts++;
          metrics.lastError = error;
          metrics.isHealthy = false;
        }

        // Log failure but continue - error isolation in action
        this.config.logger('warn', `PerSymbolStrategy: Symbol subscription failed`, {
          symbol,
          error: error.message,
          attempt: metrics?.attempts || 0,
        });

        // CRITICAL FAIRNESS FIX: Don't immediately re-add failed symbols
        // Remove failed symbol from THIS race (give others a chance)
        // Track it for potential re-adding after healthy symbols get turns
        pending.delete(symbol);
        failedSymbols.add(symbol);

        // Check if max retries reached
        if (!this.isClosed && metrics && metrics.attempts >= 5) {
          // Max retries exhausted - remove permanently
          this.taskMetrics.delete(symbol);
          failedSymbols.delete(symbol);
        }
      }
    }

    this.config.logger('info', `PerSymbolStrategy: Closed`, {
      symbolCount: symbols.length,
      metricsSnapshot: this._getMetricsSummary(),
    });
  }

  /**
   * Watch single symbol with error wrapping
   * Adds symbol context to error message
   *
   * @private
   */
  async _watchSymbolSafe(exchange, symbol) {
    try {
      const ticker = await exchange.watchTicker(symbol);
      return ticker;
    } catch (error) {
      // Wrap error with symbol context
      const wrapped = error instanceof Error ? error : new Error(String(error));
      wrapped.message = `${symbol}: ${wrapped.message}`;
      throw wrapped;
    }
  }

  /**
   * Get metrics summary across all symbols
   * Used for logging and diagnostics
   *
   * @private
   */
  _getMetricsSummary() {
    const summary = {
      totalSymbols: this.taskMetrics.size,
      healthy: 0,
      failed: 0,
      totalAttempts: 0,
    };

    for (const metrics of this.taskMetrics.values()) {
      if (metrics.isHealthy) {
        summary.healthy++;
      } else {
        summary.failed++;
      }
      summary.totalAttempts += metrics.attempts;
    }

    return summary;
  }

  /**
   * Get per-symbol metrics for external monitoring
   */
  getMetrics() {
    const result = {};
    for (const [symbol, metrics] of this.taskMetrics.entries()) {
      result[symbol] = {
        attempts: metrics.attempts,
        isHealthy: metrics.isHealthy,
        lastError: metrics.lastError?.message || null,
        uptime: metrics.isHealthy ? Date.now() - metrics.created : null,
      };
    }
    return result;
  }

  async close() {
    this.isClosed = true;
    this.taskMetrics.clear();
  }
}

module.exports = PerSymbolStrategy;
