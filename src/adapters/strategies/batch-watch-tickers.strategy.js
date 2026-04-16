/**
 * BatchWatchTickersStrategy - Call watchTickers() for each batch
 *
 * Used for: Exchanges that support watchTickers but prefer smaller batches
 * Behavior: If batch size < total symbols, split into sub-batches and call watchTickers per batch
 *
 * Pros: Smaller connections, better memory management for huge symbol counts
 * Cons: Multiple connections, slightly higher overhead than AllTickersStrategy
 *
 * Implementation: Splits symbols into fixed-size batches, runs all batches concurrently,
 * yields tickers from whichever batch resolves first.
 */

const { Strategy, STRATEGY_MODES } = require('./strategy.interface');

class BatchWatchTickersStrategy extends Strategy {
  constructor(config) {
    super();
    this.config = config; // {exchange, logger, proxyProvider, batchSize}
    this.batchSize = config.batchSize || 100;
  }

  /**
   * Get strategy mode identifier
   */
  getMode() {
    return STRATEGY_MODES.BATCH_WATCH_TICKERS;
  }

  /**
   * Check if exchange supports watchTickers
   */
  isSupported(exchange) {
    return exchange && typeof exchange.watchTickers === 'function';
  }

  /**
   * Apply strategy: split symbols into batches, run watchTickers concurrently
   * Fixed: Emit ALL tickers from each batch response
   */
  async *execute(exchange, symbols) {
    if (!this.isSupported(exchange)) {
      throw new Error(`Exchange ${this.config.exchange} does not support watchTickers`);
    }

    // Split symbols into batches
    const batches = [];
    for (let i = 0; i < symbols.length; i += this.batchSize) {
      batches.push(symbols.slice(i, i + this.batchSize));
    }

    this.config.logger('info', `BatchWatchTickersStrategy: Split ${symbols.length} symbols into ${batches.length} batches`, {
      exchange: this.config.exchange,
      batchSize: this.batchSize,
      batchCount: batches.length,
      mode: this.getMode(),
    });

    // Run all batches concurrently using Promise.race pattern
    // Each batch has its own watchTickers subscription
    const pending = new Map();
    const tickerQueues = new Map(); // Cache for unprocessed tickers per batch

    // Initialize pending map with watch promises for each batch (using numeric batch index)
    for (let i = 0; i < batches.length; i++) {
      pending.set(i, this._watchBatch(exchange, batches[i], i));
      tickerQueues.set(i, []);
    }

    // Main loop: race all batches, yield from whichever resolves first
    while (pending.size > 0) {
      try {
        const result = await Promise.race(pending.values());
        const { tickers, batchIndex } = result;

        // Collect all tickers from this batch response
        if (tickers && Array.isArray(tickers) && tickers.length > 0) {
          // Yield all tickers from this batch response
          for (const { symbol, ticker } of tickers) {
            if (ticker) {
              yield { symbol, ticker };
            }
          }
        }

        // Re-watch the same batch (next iteration will get next set of tickers)
        // Use numeric batchIndex to ensure consistent Map key
        pending.set(batchIndex, this._watchBatch(exchange, batches[batchIndex], batchIndex));
      } catch (error) {
        // ONE BATCH ERROR: Remove ONLY the failed batch from race, let others continue.
        // Never delete arbitrary pending entries (can drop healthy batches).
        const failedBatchIndex = Number.isInteger(error?.batchIndex) ? error.batchIndex : null;
        if (failedBatchIndex === null || !pending.has(failedBatchIndex)) {
          throw error;
        }
        pending.delete(failedBatchIndex);
        this.config.logger('warn', `BatchWatchTickersStrategy: Batch ${failedBatchIndex} failed, continuing others`, {
          batchIndex: failedBatchIndex,
          error: error.message,
          activeBatches: pending.size,
        });
      }
    }
  }

  /**
   * Watch a single batch of symbols
   * Returns ALL tickers from the batch response (not just first)
   * Uses loop-based retry instead of recursion for safety
   * @private
   */
  async _watchBatch(exchange, batchSymbols, batchIndex) {
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      try {
        const tickers = await exchange.watchTickers(batchSymbols);

        if (tickers && typeof tickers === 'object') {
          // Collect ALL tickers from this batch response (Fix 2: no data loss)
          const tickerArray = Object.entries(tickers).map(([symbol, ticker]) => ({
            symbol,
            ticker,
          }));

          if (tickerArray.length > 0) {
            // Return all tickers from this response
            return { tickers: tickerArray, batchIndex };
          }
        }

        // If no tickers returned, retry with backoff
        attempts++;
        if (attempts < maxAttempts) {
          // Small delay before retry
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (error) {
        // RETRY logic: increment attempts and retry if under maxAttempts
        attempts++;

        if (attempts < maxAttempts) {
          // Small delay before retry
          await new Promise(r => setTimeout(r, 100));
          continue; // Retry the loop
        }

        // Max attempts exhausted, now throw with batch context
        const wrapped = error instanceof Error ? error : new Error(String(error));
        wrapped.message = `${batchSymbols.length} symbols (batch ${batchIndex}): ${wrapped.message}`;
        wrapped.symbols = batchSymbols;
        wrapped.batchIndex = batchIndex;
        throw wrapped;
      }
    }

    // All retry attempts exhausted
    const error = new Error(`Batch ${batchIndex}: Max retries (${maxAttempts}) exceeded for ${batchSymbols.length} symbols`);
    error.symbols = batchSymbols;
    error.batchIndex = batchIndex;
    throw error;
  }
}

module.exports = BatchWatchTickersStrategy;
