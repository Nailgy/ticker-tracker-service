/**
 * ExchangeAdapter - Abstract Interface for Exchange/CCXT Behavior
 *
 * Encapsulates all exchange-specific WebSocket behavior, market loading, and error handling.
 * Implementations wrap CCXT Pro and apply strategy patterns for different watch modes.
 *
 * This is the ONLY interface through which SubscriptionEngine interacts with exchanges.
 * All CCXT internals are hidden here.
 *
 * Usage:
 *   const adapter = new CCXTAdapter({exchange, marketType, strategy, logger});
 *   await adapter.initialize();
 *   const subscription = await adapter.subscribe(['BTC/USDT', 'ETH/USDT']);
 *   for await (const {symbol, ticker} of subscription) {
 *     // Process ticker...
 *   }
 */

/**
 * Abstract adapter interface - all exchange interactions go through here
 */
class ExchangeAdapter {
  /**
   * Initialize adapter (connect, setup)
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Load available markets for the configured exchange and market type
   * @returns {Promise<Array>} Array of {symbol, active, spot, swap, future}
   */
  async loadMarkets() {
    throw new Error('loadMarkets() must be implemented by subclass');
  }

  /**
   * Subscribe to tickers for symbols and yield updates
   *
   * Applies the configured watch strategy (allTickers, batchTickers, perSymbol).
   * Yields tickers as AsyncIterator - caller pulls data as ready.
   * Handles reconnection and error recovery internally.
   *
   * @param {string[]} symbols - Array of symbols to subscribe
   * @returns {AsyncIterator<{symbol, ticker}>} Yields ticker updates
   *
   * @throws {Error} If subscription setup fails (bad symbols, exchange down, etc)
   */
  async *subscribe(symbols) {
    throw new Error('subscribe() must be implemented by subclass');
  }

  /**
   * Close adapter gracefully (disconnect WebSocket, cleanup)
   * @returns {Promise<void>}
   */
  async close() {
    throw new Error('close() must be implemented by subclass');
  }

  /**
   * Check if this adapter supports watchTickers (batch subscribe)
   * @returns {boolean}
   */
  isWatchTickersSupported() {
    throw new Error('isWatchTickersSupported() must be implemented by subclass');
  }

  /**
   * Get exchange identifier
   * @returns {string} Exchange ID (e.g., 'binance', 'bybit')
   */
  getExchangeId() {
    throw new Error('getExchangeId() must be implemented by subclass');
  }

  /**
   * Get market type
   * @returns {string} Market type ('spot' or 'swap')
   */
  getMarketType() {
    throw new Error('getMarketType() must be implemented by subclass');
  }

  /**
   * Get current metrics/status
   * @returns {Object}
   */
  getMetrics() {
    throw new Error('getMetrics() must be implemented by subclass');
  }
}

module.exports = ExchangeAdapter;
