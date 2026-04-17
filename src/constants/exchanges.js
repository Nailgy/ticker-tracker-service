/**
 * Exchange Configuration Constants
 *
 * Defines exchange-specific configurations including:
 * - Watch mode strategy (allTickers, batchWatchTickers, perSymbol)
 * - Resilience/health check parameters tuned per exchange stability
 * - Market type support
 *
 * Rationale:
 * - Stable exchanges (Binance, Bybit): Higher timeouts, less frequent checks
 * - Unstable/variable exchanges: Lower timeouts, more aggressive health checks
 * - Proxy scenarios: Moderate timeouts to allow IP rotation
 */

const { STRATEGY_MODES } = require('../adapters/strategies/strategy.interface');

const EXCHANGE_CONFIGS = {
  binance: {
    /**
     * Binance: Extremely stable, high-reliability infrastructure
     * - watchTickers strategy: Batch updates all requested symbols simultaneously
     * - Rarely needs reconnection
     * - Can tolerate longer backoff intervals
     */
    watchMode: STRATEGY_MODES.ALL_TICKERS,
    supportedMarketTypes: ['spot', 'swap'],
    resilience: {
      retryBaseDelayMs: 1000,       // Initial: 1 second
      retryMaxDelayMs: 60000,       // Max: 60 seconds (stable, can wait)
      healthCheckIntervalMs: 15000, // Check every 15 seconds (less overhead)
      healthCheckTimeoutMs: 60000,  // Stale after 60 seconds (generous, stable)
    },
    // Stage 3: Health ratio policy for controlled restart on degradation
    healthRatioPolicy: {
      minHealthyRatio: 0.5,        // Restart if < 50% batches healthy (stable exchange, high threshold)
      ratioBreachCycles: 3,        // After 3 bad cycles (45 seconds) [3 * 15s]
      restartCooldownMs: 30000,    // Cooldown between restarts (30 seconds)
    },
    // Stage 3: Stale watchdog escalation thresholds
    staleWatchdog: {
      staleTimeoutMs: 60000,       // 60 second stale threshold (generous for stable exchange)
    },
  },

  bybit: {
    /**
     * Bybit: Stable, similar to Binance
     * - watchTickers strategy: Batch updates
     * - Similar stability to Binance
     */
    watchMode: STRATEGY_MODES.ALL_TICKERS,
    supportedMarketTypes: ['spot', 'swap'],
    resilience: {
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 60000,
      healthCheckIntervalMs: 15000,
      healthCheckTimeoutMs: 60000,
    },
    // Stage 3: Health ratio policy
    healthRatioPolicy: {
      minHealthyRatio: 0.5,
      ratioBreachCycles: 3,
      restartCooldownMs: 30000,
    },
    // Stage 3: Stale watchdog
    staleWatchdog: {
      staleTimeoutMs: 60000,
    },
  },

  kraken: {
    /**
     * Kraken: Stable but per-symbol only API
     * - watchTicker strategy: Single symbol per call (no batch)
     * - Requires single connections per symbol = more overhead
     * - Slightly shorter timeouts for better responsiveness
     */
    watchMode: STRATEGY_MODES.PER_SYMBOL,
    supportedMarketTypes: ['spot', 'swap'],
    resilience: {
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,       // Max: 30 seconds (single-symbol penalty)
      healthCheckIntervalMs: 10000, // Check every 10 seconds
      healthCheckTimeoutMs: 45000,  // Stale after 45 seconds
    },
    // Stage 3: Health ratio policy - more aggressive for per-symbol (more batches)
    healthRatioPolicy: {
      minHealthyRatio: 0.6,        // Restart if < 60% batches healthy (more batches = need more headroom)
      ratioBreachCycles: 2,        // After 2 bad cycles (20 seconds) [2 * 10s]
      restartCooldownMs: 20000,    // Shorter cooldown (30 seconds)
    },
    // Stage 3: Stale watchdog - more aggressive
    staleWatchdog: {
      staleTimeoutMs: 45000,       // 45 second threshold (less generous than Binance)
    },
  },

  /**
   * Default config for unmapped exchanges
   * Conservative settings for unknown behavior
   */
  default: {
    watchMode: STRATEGY_MODES.ALL_TICKERS,
    supportedMarketTypes: ['spot'],
    resilience: {
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,       // Conservative: 30 seconds max
      healthCheckIntervalMs: 10000,
      healthCheckTimeoutMs: 45000,
    },
    // Stage 3: Health ratio policy - conservative defaults
    healthRatioPolicy: {
      minHealthyRatio: 0.5,
      ratioBreachCycles: 3,
      restartCooldownMs: 30000,
    },
    // Stage 3: Stale watchdog - conservative
    staleWatchdog: {
      staleTimeoutMs: 45000,
    },
  },
};

/**
 * Get resilience configuration for an exchange
 * @param {string} exchangeName - Exchange name (binance, bybit, kraken, etc.)
 * @returns {Object} Resilience config with retry/health check parameters
 */
function getResilienceConfig(exchangeName) {
  const name = exchangeName.toLowerCase();
  const config = EXCHANGE_CONFIGS[name] || EXCHANGE_CONFIGS.default;
  return config.resilience;
}

/**
 * Get watch mode for an exchange
 * @param {string} exchangeName - Exchange name
 * @returns {string} Watch mode ('watchTickers' or 'watchTicker')
 */
function getWatchMode(exchangeName) {
  const name = exchangeName.toLowerCase();
  const config = EXCHANGE_CONFIGS[name] || EXCHANGE_CONFIGS.default;
  return config.watchMode;
}

/**
 * Check if exchange supports a market type
 * @param {string} exchangeName - Exchange name
 * @param {string} marketType - Market type ('spot' or 'swap')
 * @returns {boolean}
 */
function supportsMarketType(exchangeName, marketType) {
  const name = exchangeName.toLowerCase();
  const config = EXCHANGE_CONFIGS[name] || EXCHANGE_CONFIGS.default;
  return config.supportedMarketTypes.includes(marketType.toLowerCase());
}

/**
 * Get per-exchange health ratio policy config (Stage 3)
 */
function getHealthRatioPolicy(exchangeName) {
  const config = EXCHANGE_CONFIGS[exchangeName] || EXCHANGE_CONFIGS.default;
  return config.healthRatioPolicy || {
    minHealthyRatio: 0.5,
    ratioBreachCycles: 3,
    restartCooldownMs: 30000,
  };
}

/**
 * Get per-exchange stale watchdog config (Stage 3)
 */
function getStaleWatchdogConfig(exchangeName) {
  const config = EXCHANGE_CONFIGS[exchangeName] || EXCHANGE_CONFIGS.default;
  return config.staleWatchdog || {
    staleTimeoutMs: 60000,
  };
}

module.exports = {
  EXCHANGE_CONFIGS,
  STRATEGY_MODES,
  getResilienceConfig,
  getWatchMode,
  supportsMarketType,
  getHealthRatioPolicy,
  getStaleWatchdogConfig,
};
