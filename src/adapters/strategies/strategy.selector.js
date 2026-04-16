/**
 * StrategySelector - Deterministic strategy selection with precedence rules
 *
 * Selection precedence (highest to lowest):
 * 1. Explicit override in config (strategyMode)
 * 2. Exchange default from constants/exchanges.js
 * 3. Capability-based fallback (try preferred strategies in order)
 * 4. Throw if no suitable strategy found
 *
 * This ensures predictable, deterministic behavior and respects operator preferences.
 *
 * Usage:
 *   const strategy = StrategySelector.selectStrategy('binance', exchangeInstance, config);
 *   // Returns: AllTickersStrategy (binance default) or override if config.strategyMode set
 */

const { STRATEGY_MODES } = require('./strategy.interface');
const AllTickersStrategy = require('./all-tickers.strategy');
const BatchWatchTickersStrategy = require('./batch-watch-tickers.strategy');
const PerSymbolStrategy = require('./per-symbol.strategy');
const { getWatchMode } = require('../../constants/exchanges');

class StrategySelector {
  /**
   * Select strategy based on deterministic precedence rules
   *
   * @param {string} exchangeName - Exchange name (binance, bybit, kraken, etc.)
   * @param {object} exchange - CCXT exchange instance
   * @param {object} config - Configuration object with optional strategyMode override
   * @returns {object} Selected strategy instance (extends Strategy)
   * @throws {Error} If no suitable strategy found
   */
  static selectStrategy(exchangeName, exchange, config) {
    const logger = config.logger || this._defaultLogger;

    // STEP 1: Check explicit override in config
    if (config.strategyMode) {
      logger('info', `StrategySelector: Using explicit override strategyMode=${config.strategyMode}`, {
        exchange: exchangeName,
        precedence: 'Level 1 (explicit override)',
      });

      try {
        return this._createStrategyByMode(config.strategyMode, exchange, config, logger);
      } catch (error) {
        logger('error', `StrategySelector: Explicit override failed, not falling back`, {
          strategyMode: config.strategyMode,
          error: error.message,
        });
        throw error; // Explicit override must work or fail fast
      }
    }

    // STEP 2: Check exchange default from constants/exchanges.js
    try {
      const exchangeDefault = getWatchMode(exchangeName);

      if (exchangeDefault) {
        logger('debug', `StrategySelector: Checking exchange default watchMode=${exchangeDefault}`, {
          exchange: exchangeName,
          precedence: 'Level 2 (exchange default)',
        });

        try {
          const strategy = this._createStrategyByMode(exchangeDefault, exchange, config, logger);
          logger('info', `StrategySelector: Using exchange default strategy`, {
            exchange: exchangeName,
            mode: strategy.getMode(),
          });
          return strategy;
        } catch (error) {
          logger('debug', `StrategySelector: Exchange default ${exchangeDefault} not supported, trying fallback`, {
            error: error.message,
          });
          // Fall through to capability detection
        }
      }
    } catch (error) {
      logger('debug', `StrategySelector: Error getting exchange default, trying fallback`, {
        error: error.message,
      });
      // Fall through to capability detection
    }

    // STEP 3: Capability-based fallback (try in preference order)
    logger('debug', `StrategySelector: Using capability-based fallback`, {
      exchange: exchangeName,
      precedence: 'Level 3 (capability detection)',
    });

    const preferredSpecs = [
      { mode: STRATEGY_MODES.ALL_TICKERS, Strategy: AllTickersStrategy },
      { mode: STRATEGY_MODES.BATCH_WATCH_TICKERS, Strategy: BatchWatchTickersStrategy },
      { mode: STRATEGY_MODES.PER_SYMBOL, Strategy: PerSymbolStrategy },
    ];

    for (const { mode, Strategy: StrategyClass } of preferredSpecs) {
      try {
        const strategy = new StrategyClass(config);
        if (strategy.isSupported(exchange)) {
          logger('info', `StrategySelector: Selected ${mode} via capability detection`, {
            exchange: exchangeName,
            mode: strategy.getMode(),
          });
          return strategy;
        }
      } catch (error) {
        // This strategy doesn't support this exchange, try next
        logger('debug', `StrategySelector: ${mode} not supported`, {
          error: error.message,
        });
      }
    }

    // No suitable strategy found
    throw new Error(
      `StrategySelector: No suitable strategy found for ${exchangeName}. ` +
      `Exchange doesn't support watchTickers, watchTicker, or batchWatchTickers.`
    );
  }

  /**
   * Create strategy instance by mode string
   * @private
   * @throws {Error} If mode not recognized or strategy not supported
   */
  static _createStrategyByMode(modeString, exchange, config, logger) {
    const strategies = {
      [STRATEGY_MODES.ALL_TICKERS]: AllTickersStrategy,
      [STRATEGY_MODES.BATCH_WATCH_TICKERS]: BatchWatchTickersStrategy,
      [STRATEGY_MODES.PER_SYMBOL]: PerSymbolStrategy,
    };

    const StrategyClass = strategies[modeString];
    if (!StrategyClass) {
      throw new Error(`StrategySelector: Unknown strategy mode: ${modeString}`);
    }

    const strategy = new StrategyClass(config);
    if (!strategy.isSupported(exchange)) {
      throw new Error(
        `StrategySelector: Strategy ${modeString} not supported by exchange. ` +
        `Exchange doesn't have required watchTickers/watchTicker methods.`
      );
    }

    return strategy;
  }

  /**
   * Default logger (silent for debug level)
   * @private
   */
  static _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[StrategySelector:${level.toUpperCase()}] ${message}`, data || '');
  }
}

module.exports = StrategySelector;
