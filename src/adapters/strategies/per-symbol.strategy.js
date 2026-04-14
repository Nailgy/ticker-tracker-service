/**
 * PerSymbolStrategy - Watch each symbol individually via watchTicker()
 *
 * Used for: Kraken, and any exchange that doesn't support watchTickers
 * Behavior: Call exchange.watchTicker(symbol) for each symbol, manage multiple subscriptions
 *
 * Pros: Works with any per-symbol API
 * Cons: More connections, slower startup for many symbols, higher latency
 *
 * Implementation: Maintains a Map of active subscriptions, yields from any that have data
 */

class PerSymbolStrategy {
  constructor(config) {
    this.config = config; // {exchange, logger, proxyProvider}
    this.subscriptions = new Map();
    this.isClosed = false;
  }

  /**
   * Check if exchange has watchTicker method
   */
  isSupported(exchange) {
    return exchange && typeof exchange.watchTicker === 'function';
  }

  /**
   * Apply strategy: create per-symbol subscriptions, yield from any that have data
   */
  async *execute(exchange, symbols) {
    if (!this.isSupported(exchange)) {
      throw new Error(`Exchange ${this.config.exchange} does not support watchTicker`);
    }

    this.config.logger(
      'debug',
      `PerSymbolStrategy: Creating ${symbols.length} individual watchTicker subscriptions`,
      { exchange: this.config.exchange, symbolCount: symbols.length }
    );

    this.isClosed = false;

    const createNextWatchPromise = (symbol) =>
      exchange
        .watchTicker(symbol)
        .then((ticker) => ({ symbol, ticker }))
        .catch((error) => {
          const wrapped = error instanceof Error ? error : new Error(String(error));
          wrapped.message = `${symbol}: ${wrapped.message}`;
          throw wrapped;
        });

    // Run all symbol watchers concurrently and yield from whichever resolves first.
    const pending = new Map();
    for (const symbol of symbols) {
      pending.set(symbol, createNextWatchPromise(symbol));
    }

    while (!this.isClosed && pending.size > 0) {
      const { symbol, ticker } = await Promise.race(pending.values());

      if (ticker) {
        yield { symbol, ticker };
      }

      if (!this.isClosed) {
        pending.set(symbol, createNextWatchPromise(symbol));
      }
    }
  }

  async close() {
    // Clean up subscriptions
    this.isClosed = true;
    this.subscriptions.clear();
  }
}

module.exports = PerSymbolStrategy;
