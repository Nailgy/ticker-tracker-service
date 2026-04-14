/**
 * Shared mock utilities for integration tests
 * Extracted from Phase 1C unit tests for reuse across integration test suites
 */

// ============================================================================
// MockExchangeAdapter - Simulates CCXT Pro exchange behavior
// ============================================================================

class MockExchangeAdapter {
  constructor(options = {}) {
    this.symbols = options.symbols || ['BTC/USDT', 'ETH/USDT', 'ADA/USDT'];
    this.shouldError = options.shouldError || false;
    this.errorType = options.errorType || 'ECONNREFUSED';
    this.errorMessage = options.errorMessage || `${this.errorType}: Connection refused`;
    this.yieldCount = 0;
    this.maxYields = options.maxYields || Infinity;
    this.isClosed = false;
    this.metrics = {
      subscriptionStatus: 'initialized',
      lastSubscribedSymbols: [],
      errorCount: 0,
      totalYields: 0,
    };
  }

  async initialize() {
    this.metrics.subscriptionStatus = 'initialized';
  }

  async loadMarkets() {
    return this.symbols.map(symbol => ({
      symbol,
      active: true,
      spot: true,
      swap: false,
    }));
  }

  async *subscribe(symbols) {
    if (this.shouldError && this.yieldCount === 0) {
      this.metrics.errorCount++;
      throw new Error(this.errorMessage);
    }

    this.metrics.lastSubscribedSymbols = symbols;

    for (const symbol of symbols) {
      if (this.yieldCount >= this.maxYields) break;

      yield {
        symbol,
        ticker: {
          symbol,
          last: 100 + Math.random(),
          bid: 99,
          ask: 101,
          high: 105,
          low: 95,
          volume: 1000,
          timestamp: Date.now(),
        },
      };

      this.yieldCount++;
      this.metrics.totalYields++;
    }
  }

  async close() {
    this.isClosed = true;
    this.metrics.subscriptionStatus = 'closed';
  }

  isWatchTickersSupported() {
    return true;
  }

  getExchangeId() {
    return 'binance';
  }

  getMarketType() {
    return 'spot';
  }

  getMetrics() {
    return { ...this.metrics };
  }
}

// ============================================================================
// Helper Functions - Create configured mock instances
// ============================================================================

/**
 * Create configured mock adapter for test scenarios
 * @param {Object} options - Configuration options
 * @param {string[]} options.symbols - Symbols to return from loadMarkets()
 * @param {boolean} options.shouldError - Whether to throw error on first subscribe()
 * @param {string} options.errorType - Type of error to throw
 * @param {string} options.errorMessage - Full error message
 * @param {number} options.maxYields - Max iterations before stopping
 * @returns {MockExchangeAdapter}
 */
function createMockAdapter(options = {}) {
  return new MockExchangeAdapter({
    symbols: options.symbols || ['BTC/USDT', 'ETH/USDT', 'ADA/USDT'],
    shouldError: options.shouldError || false,
    errorType: options.errorType || 'ECONNREFUSED',
    errorMessage: options.errorMessage || 'Connection refused',
    maxYields: options.maxYields !== undefined ? options.maxYields : Infinity,
  });
}

/**
 * Create test configuration with sensible defaults
 * @param {Object} overrides - Config values to override
 * @returns {Object} Configuration object
 */
function createTestConfig(overrides = {}) {
  return {
    exchange: 'binance',
    marketType: 'spot',
    batchSize: 10,
    proxyProvider: 'none',
    subscriptionIntervalMs: 100,
    subscriptionStartDelayMs: 50,
    healthCheckIntervalMs: 100,
    healthCheckTimeoutMs: 500,
    maxRetries: 3,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 30000,
    marketRefreshIntervalMs: 300000,
    redisBatching: true,
    redisMaxBatch: 5,
    redisFlushIntervalMs: 100,
    redisMinIntervalMs: 1000,
    logger: { debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    ...overrides,
  };
}

/**
 * Create mock market registry for testing
 * Supports simulating symbol additions/removals
 * @param {Object} options - Configuration
 * @param {string[]} options.initialSymbols - Starting symbol set
 * @returns {Object} Mock with registry interface
 */
function createMockRegistry(options = {}) {
  const initialSymbols = options.initialSymbols || ['BTC/USDT', 'ETH/USDT'];
  const activeSymbols = new Set(initialSymbols);
  const nonRetryable = new Set();

  return {
    getDesiredSymbols: jest.fn(() => new Set(initialSymbols)),
    getActiveSymbols: jest.fn(() => new Set(activeSymbols)),
    getNonRetryableSymbols: jest.fn(() => new Set(nonRetryable)),
    addSymbols: jest.fn((symbols) => {
      symbols.forEach(s => {
        activeSymbols.add(s);
        nonRetryable.delete(s);
      });
      return { added: symbols.length, count: activeSymbols.size };
    }),
    removeSymbols: jest.fn((symbols) => {
      symbols.forEach(s => activeSymbols.delete(s));
      return { removed: symbols.length, remainingCount: activeSymbols.size };
    }),
    markNonRetryable: jest.fn((symbols) => {
      symbols.forEach(s => {
        nonRetryable.add(s);
        activeSymbols.delete(s);
      });
    }),
    allocateToBatches: jest.fn(),
    loadDesiredMarkets: jest.fn().mockResolvedValue([]),
    getDiffSince: jest.fn(() => ({ added: [], removed: [] })),
    getMetrics: jest.fn(() => ({
      desiredCount: initialSymbols.length,
      activeCount: activeSymbols.size,
      nonRetryableCount: nonRetryable.size,
    })),
  };
}

/**
 * Create mock redis writer for tracking writes
 * @returns {Object} Mock with RedisWriter interface
 */
function createMockRedisWriter() {
  return {
    writeTicker: jest.fn().mockResolvedValue({ written: true }),
    flush: jest.fn().mockResolvedValue({}),
    disconnect: jest.fn().mockResolvedValue({}),
    getMetrics: jest.fn(() => ({
      totalWrites: 0,
      dedupedWrites: 0,
      flushedBatches: 0,
      failedWrites: 0,
      queuedUpdates: 0,
    })),
  };
}

/**
 * Create mock subscription engine with callback tracking
 * @returns {Object} Mock with SubscriptionEngine interface
 */
function createMockSubscriptionEngine() {
  const callbacks = {
    ticker: jest.fn(),
    error: jest.fn(),
    healthCheck: jest.fn(),
  };

  return {
    onTicker: jest.fn((cb) => { callbacks.ticker = cb; }),
    onError: jest.fn((cb) => { callbacks.error = cb; }),
    onHealthCheck: jest.fn((cb) => { callbacks.healthCheck = cb; }),
    startSubscriptions: jest.fn().mockResolvedValue({}),
    stopSubscriptions: jest.fn().mockResolvedValue({}),
    getStatus: jest.fn(() => ({
      isRunning: false,
      activeConnections: 0,
      failedBatches: 0,
      totalTickers: 0,
      totalErrors: 0,
    })),
    _triggerTickerCallback: (batchId, symbol, ticker) => {
      callbacks.ticker({ batchId, symbol, ticker });
    },
    _triggerErrorCallback: (batchId, error) => {
      callbacks.error({ batchId, error });
    },
    _triggerHealthCheckCallback: (batchId, status) => {
      callbacks.healthCheck({ batchId, status });
    },
    getCallbacks: () => callbacks,
  };
}

/**
 * Create mock connection manager for testing
 * @param {Object} options - Configuration
 * @returns {Object} Mock with ConnectionManager interface
 */
function createMockConnectionManager(options = {}) {
  return {
    initialize: jest.fn().mockResolvedValue({}),
    startSubscriptions: jest.fn().mockResolvedValue({}),
    refreshMarkets: jest.fn().mockResolvedValue({}),
    stop: jest.fn().mockResolvedValue({}),
    getStatus: jest.fn(() => ({
      isInitialized: true,
      isRunning: false,
      symbolCount: 3,
      batches: [['BTC/USDT', 'ETH/USDT']],
      adapter: {},
      engine: {},
      registry: {},
      writer: {},
    })),
    batches: [['BTC/USDT', 'ETH/USDT', 'ADA/USDT']],
    marketRegistry: createMockRegistry(),
  };
}

/**
 * Create mock redis client for testing
 * Follows ioredis interface with pipeline support
 * @returns {Object} Mock redis client
 */
function createMockRedisClient() {
  const mockPipeline = {
    hset: jest.fn().mockReturnThis(),
    publish: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
    reset: jest.fn().mockReturnThis(),
  };

  return {
    ping: jest.fn().mockResolvedValue('PONG'),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    hset: jest.fn().mockResolvedValue(1),
    hget: jest.fn().mockResolvedValue(null),
    hgetall: jest.fn().mockResolvedValue({}),
    publish: jest.fn().mockResolvedValue(0),
    pipeline: jest.fn(() => mockPipeline),
    disconnect: jest.fn().mockResolvedValue({}),
    quit: jest.fn().mockResolvedValue('OK'),
  };
}

/**
 * Create complete mock environment with all components
 * Useful for full architecture integration tests
 * @param {Object} options - Test options
 * @returns {Object} Complete mock environment
 */
function createMockEnvironment(options = {}) {
  const mockAdapter = createMockAdapter(options.adapterOptions);
  const mockRegistry = createMockRegistry(options.registryOptions);
  const mockWriter = createMockRedisWriter();
  const mockEngine = createMockSubscriptionEngine();
  const mockManager = createMockConnectionManager();
  const mockRedis = createMockRedisClient();

  return {
    adapter: mockAdapter,
    registry: mockRegistry,
    writer: mockWriter,
    engine: mockEngine,
    manager: mockManager,
    redis: mockRedis,
    config: createTestConfig(options.config),
  };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Classes
  MockExchangeAdapter,
  // Factory functions
  createMockAdapter,
  createTestConfig,
  createMockRegistry,
  createMockRedisWriter,
  createMockSubscriptionEngine,
  createMockConnectionManager,
  createMockRedisClient,
  createMockEnvironment,
};
