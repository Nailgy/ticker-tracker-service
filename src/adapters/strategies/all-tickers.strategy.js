/**
 * AllTickersStrategy - Watch all symbols at once via watchTickers()
 *
 * Used for: Binance, Bybit
 * Behavior: Call exchange.watchTickers(allSymbols) once, get all tickers atomically
 *
 * Pros: Single connection, batch efficiency
 * Cons: All symbols must be valid, limits on total symbols per request
 */

const { Strategy, STRATEGY_MODES } = require('./strategy.interface');

class AllTickersStrategy extends Strategy {
  constructor(config) {
    super();
    this.config = config; // {exchange, logger, proxyProvider}
  }

  /**
   * Get strategy mode identifier
   */
  getMode() {
    return STRATEGY_MODES.ALL_TICKERS;
  }

  /**
   * Check if exchange supports watchTickers
   */
  isSupported(exchange) {
    return exchange && typeof exchange.watchTickers === 'function';
  }

  /**
   * Apply strategy: call watchTickers with all symbols, yield results
   */
  async *execute(exchange, symbols) {
    if (!this.isSupported(exchange)) {
      throw new Error(`Exchange ${this.config.exchange} does not support watchTickers`);
    }

    this.config.logger('debug', `AllTickersStrategy: Subscribing to ${symbols.length} symbols via watchTickers`, {
      exchange: this.config.exchange,
      symbolCount: symbols.length,
      mode: this.getMode(),
    });

    while (true) {
      try {
        const tickers = await exchange.watchTickers(symbols);

        if (tickers && typeof tickers === 'object') {
          for (const [symbol, ticker] of Object.entries(tickers)) {
            yield { symbol, ticker };
          }
        }
      } catch (error) {
        this.config.logger('error', `AllTickersStrategy: Error during watch`, {
          error: error.message,
          errorName: error.name,
        });
        throw error; // Let caller handle reconnect
      }
    }
  }
}

module.exports = AllTickersStrategy;
