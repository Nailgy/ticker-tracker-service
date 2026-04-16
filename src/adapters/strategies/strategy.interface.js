/**
 * Strategy Interface - Formal contract for subscription strategies
 *
 * Defines three explicit subscription modes:
 * - ALL_TICKERS: Single watchTickers() call, all symbols at once
 * - BATCH_WATCH_TICKERS: Multiple watchTickers() calls, batched
 * - PER_SYMBOL: Individual watchTicker() calls per symbol
 *
 * All strategies implement the same interface, making selection deterministic.
 */

const STRATEGY_MODES = {
  ALL_TICKERS: 'allTickers',
  BATCH_WATCH_TICKERS: 'batchWatchTickers',
  PER_SYMBOL: 'perSymbol',
};

/**
 * Base Strategy class defining required interface
 *
 * All subscription strategies must:
 * 1. Implement getMode() - return STRATEGY_MODES identifier
 * 2. Implement isSupported(exchange) - check exchange capabilities
 * 3. Implement execute(exchange, symbols) - async generator yielding {symbol, ticker}
 * 4. Optionally implement close() - cleanup on shutdown
 */
class Strategy {
  /**
   * Get strategy mode identifier
   * @abstract
   * @returns {string} - One of STRATEGY_MODES values
   */
  getMode() {
    throw new Error('Must implement getMode()');
  }

  /**
   * Check if this strategy is supported by the exchange
   * @abstract
   * @param {object} exchange - CCXT exchange instance
   * @returns {boolean} - true if exchange supports this strategy, false otherwise
   */
  isSupported(exchange) {
    throw new Error('Must implement isSupported()');
  }

  /**
   * Execute the subscription strategy
   * @abstract
   * @param {object} exchange - CCXT exchange instance
   * @param {string[]} symbols - Array of symbols to subscribe
   * @yields {object} - {symbol, ticker} objects with real-time data
   */
  async *execute(exchange, symbols) {
    throw new Error('Must implement execute()');
  }

  /**
   * Close strategy gracefully
   * Called during shutdown to clean up resources
   * @async
   */
  async close() {
    // Default: no-op (strategies can override if needed)
  }
}

module.exports = {
  STRATEGY_MODES,
  Strategy,
};
