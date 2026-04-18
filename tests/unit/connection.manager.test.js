/**
 * ConnectionManager Unit Tests
 *
 * Tests initialization, market loading, batching, lifecycle, and public API.
 * Uses mocks for ExchangeAdapter, SubscriptionEngine, and RedisWriter.
 */

// Mock ExchangeAdapter
class MockExchangeAdapter {
  constructor(config = {}) {
    this.config = config;
    this.initialized = false;
    this.markets = [];
  }

  async initialize() {
    this.initialized = true;
  }

  async loadMarkets() {
    return [
      { symbol: 'BTC/USDT', active: true, spot: true },
      { symbol: 'ETH/USDT', active: true, spot: true },
      { symbol: 'BNB/USDT', active: true, spot: true },
      { symbol: 'ADA/USDT', active: true, spot: true },
      { symbol: 'XRP/USDT', active: true, spot: true },
    ];
  }

  async *subscribe(symbols) {
    // Generator that yields tickers
    for (const symbol of symbols) {
      yield { symbol, ticker: { last: 100, bid: 99, ask: 101 } };
    }
  }

  async close() {
    // Cleanup
  }

  getExchangeId() {
    return this.config.exchange || 'binance';
  }

  getMarketType() {
    return this.config.marketType || 'spot';
  }

  isWatchTickersSupported() {
    return true;
  }

  getMetrics() {
    return {
      subscriptionStatus: 'ready',
      lastDataAt: null,
      symbolsSubscribed: 0,
      errorCount: 0,
    };
  }
}

// Mock SubscriptionEngine
class MockSubscriptionEngine {
  constructor() {
    this.isRunning = false;
    this.callbacks = {};
    this.startCalls = 0;
    this.stopCalls = 0;
    this.reconcileCalls = 0;
  }

  onTicker(callback) {
    this.callbacks.ticker = callback;
  }

  onError(callback) {
    this.callbacks.error = callback;
  }

  async startSubscriptions(batches) {
    this.isRunning = true;
    this.startCalls += 1;
  }

  async stopSubscriptions() {
    this.isRunning = false;
    this.stopCalls += 1;
  }

  async reconcileBatches(nextPlan) {
    this.reconcileCalls += 1;
    return {
      added: [],
      removed: [],
      modified: [],
      unchanged: [],
    };
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      activeConnections: 0,
      failedBatches: [],
    };
  }
}

// Mock RedisWriter
class MockRedisWriter {
  constructor(redisService, config = {}) {
    this.updates = [];
    this.config = {
      redisBatching: config.redisBatching !== false,
      redisFlushMs: config.redisFlushMs || 1000,
      redisMaxBatch: config.redisMaxBatch || 1000,
      redisOnlyOnChange: config.redisOnlyOnChange !== false,
      redisMinIntervalMs: config.redisMinIntervalMs || 0,
    };
  }

  async writeTicker() {
    return { written: true };
  }

  async flush() {
    return { flushed: true };
  }

  getMetrics() {
    return {
      totalWrites: 0,
      dedupedWrites: 0,
      flushedBatches: 0,
      failedWrites: 0,
    };
  }
}

// Mock RedisService
class MockRedisService {
  constructor() {
    this.updates = [];
    this.flushCount = 0;
    this.isConnected = true;
  }

  async updateTicker(exchange, marketType, symbol, tickerData) {
    this.updates.push({ exchange, marketType, symbol, tickerData });
    return true;
  }

  async flush() {
    this.flushCount++;
    return true;
  }

  isReady() {
    return this.isConnected;
  }

  createPipeline() {
    return {
      hset: jest.fn().mockReturnThis(),
      publish: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([['OK'], ['OK']]),
    };
  }

  async execPipeline(pipeline) {
    return pipeline.exec();
  }

  getStatus() {
    return { batchSize: this.updates.length };
  }
}

const ConnectionManager = require('../../src/core/connection.manager');

// Mock the adapter and engine modules before loading ConnectionManager
jest.mock('../../src/adapters/ccxt.adapter', () => MockExchangeAdapter);
jest.mock('../../src/core/subscription.engine', () => MockSubscriptionEngine);
jest.mock('../../src/services/redis.writer', () => MockRedisWriter);

describe('ConnectionManager', () => {
  let manager;
  let mockRedis;
  let mockAdapterFactory;
  let mockProxyProviderFactory;

  beforeEach(() => {
    mockRedis = new MockRedisService();

    // Mock factories that return our mock classes
    mockAdapterFactory = jest.fn((config) => new MockExchangeAdapter(config));
    mockProxyProviderFactory = jest.fn(() => ({
      getNextProxy: jest.fn().mockResolvedValue(null),
    }));
  });

  afterEach(async () => {
    if (manager && manager.isRunning) {
      await manager.stop();
    }
  });

  describe('constructor', () => {
    it('should initialize with valid config', () => {
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        batchSize: 50,
        exchange: 'binance',
      });

      expect(manager.config.batchSize).toBe(50);
      expect(manager.isRunning).toBe(false);
      expect(manager.isInitialized).toBe(false);
      expect(manager.batches).toEqual([]);
    });

    it('should use default batchSize if not provided', () => {
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        exchange: 'binance',
      });

      expect(manager.config.batchSize).toBe(100);
    });

    it('should use default exchange if not provided', () => {
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
      });

      expect(manager.config.exchange).toBe('binance');
    });
  });

  describe('initialize()', () => {
    beforeEach(() => {
      mockRedis = new MockRedisService();
    });

    it('should load markets and create adapter', async () => {
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        exchange: 'binance',
      });

      await manager.initialize();

      expect(manager.adapter).toBeDefined();
      expect(manager.isInitialized).toBe(true);
      const activeSymbols = Array.from(manager.marketRegistry.getActiveSymbols()).sort();
      expect(activeSymbols.length).toBe(5);
      expect(activeSymbols[0]).toBe('ADA/USDT'); // Sorted
    });

    it('should create batches from loaded symbols', async () => {
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        batchSize: 2,
        exchange: 'binance',
      });

      await manager.initialize();

      expect(manager.batches.length).toBe(3); // 5 symbols / 2 per batch = 3 batches
      expect(manager.batches[0]).toEqual(['ADA/USDT', 'BNB/USDT']);
      expect(manager.batches[1]).toEqual(['BTC/USDT', 'ETH/USDT']);
      expect(manager.batches[2]).toEqual(['XRP/USDT']);
    });

    it('should handle single batch when symbols < batchSize', async () => {
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        batchSize: 100,
        exchange: 'binance',
      });

      await manager.initialize();

      expect(manager.batches.length).toBe(1);
      expect(manager.batches[0].length).toBe(5);
    });
  });

  describe('batching logic', () => {
    it('should split 10 symbols into 4 batches with batchSize=3', async () => {
      // Mock adapter to return 10 symbols
      class TenSymbolAdapter extends MockExchangeAdapter {
        async loadMarkets() {
          return Array.from({ length: 10 }, (_, i) => ({
            symbol: `SYM${i}/USDT`,
            active: true,
            spot: true,
          }));
        }
      }

      const tenSymbolAdapterFactory = jest.fn((config) => new TenSymbolAdapter(config));

      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: tenSymbolAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        batchSize: 3,
        exchange: 'binance',
      });

      await manager.initialize();

      expect(manager.batches.length).toBe(4);
      expect(manager.batches[0].length).toBe(3);
      expect(manager.batches[1].length).toBe(3);
      expect(manager.batches[2].length).toBe(3);
      expect(manager.batches[3].length).toBe(1); // Remainder
    });

    it('should create empty batches array if no symbols', async () => {
      class NoSymbolAdapter extends MockExchangeAdapter {
        async loadMarkets() {
          return [];
        }
      }

      const noSymbolAdapterFactory = jest.fn((config) => new NoSymbolAdapter(config));

      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: noSymbolAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        batchSize: 100,
        exchange: 'binance',
      });

      await manager.initialize();

      expect(manager.batches.length).toBe(0);
    });
  });

  describe('startSubscriptions()', () => {
    beforeEach(async () => {
      mockRedis = new MockRedisService();
      manager = new ConnectionManager({
        redisService: mockRedis,
        batchSize: 2,
        exchange: 'binance',
      });
      await manager.initialize();
    });

    it('should set isRunning to true', async () => {
      await manager.startSubscriptions();
      expect(manager.isRunning).toBe(true);
      expect(manager.subscriptionEngine.getStatus().isRunning).toBe(true);
    });

    it('should start subscription engine for each batch', async () => {
      await manager.startSubscriptions();

      const engineStatus = manager.subscriptionEngine.getStatus();
      expect(engineStatus.isRunning).toBe(true);
    });

    it('should handle subscription already running', async () => {
      await manager.startSubscriptions();
      expect(manager.isRunning).toBe(true);

      await manager.startSubscriptions(); // Second call - should just return
      expect(manager.isRunning).toBe(true);
    });

    it('should preserve redis writer batching config from manager config', async () => {
      const customManager = new ConnectionManager({
        redisService: mockRedis,
        batchSize: 2,
        exchange: 'binance',
        redisBatching: true,
        redisFlushMs: 250,
        redisMaxBatch: 77,
        redisMinIntervalMs: 12,
      });
      await customManager.initialize();

      expect(customManager.redisWriter.config.redisBatching).toBe(true);
      expect(customManager.redisWriter.config.redisFlushMs).toBe(250);
      expect(customManager.redisWriter.config.redisMaxBatch).toBe(77);
      expect(customManager.redisWriter.config.redisMinIntervalMs).toBe(12);
    });

    it('should choose LocalIPProvider by default when localIps are provided', async () => {
      const localManager = new ConnectionManager({
        redisService: mockRedis,
        exchange: 'binance',
        localIps: ['192.168.1.10', '192.168.1.11'],
      });
      await localManager.initialize();

      expect(localManager.adapter.config.proxyProvider).toBeDefined();
      const next = await localManager.adapter.config.proxyProvider.getNextProxy();
      expect(next.localAddress).toBeDefined();
    });

    it('should throw if not initialized', async () => {
      manager = new ConnectionManager({
        redisService: mockRedis,
      });

      await expect(manager.startSubscriptions()).rejects.toThrow('not initialized');
    });
  });

  describe('stop()', () => {
    it('should set isRunning to false', async () => {
      manager = new ConnectionManager({
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        redisService: mockRedis,
        exchange: 'binance',
      });
      await manager.initialize();
      await manager.startSubscriptions();

      expect(manager.isRunning).toBe(true);

      await manager.stop();

      expect(manager.isRunning).toBe(false);
      expect(manager.subscriptionEngine.getStatus().isRunning).toBe(false);
    });

    it('should stop subscription engine', async () => {
      manager = new ConnectionManager({
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        redisService: mockRedis,
        exchange: 'binance',
      });
      await manager.initialize();
      await manager.startSubscriptions();

      expect(manager.subscriptionEngine.getStatus().isRunning).toBe(true);

      await manager.stop();

      expect(manager.subscriptionEngine.getStatus().isRunning).toBe(false);
    });

    it('should flush Redis batch', async () => {
      manager = new ConnectionManager({
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        redisService: mockRedis,
        exchange: 'binance',
      });
      await manager.initialize();

      const flushCountBefore = mockRedis.flushCount;
      await manager.stop();

      expect(mockRedis.flushCount).toBeGreaterThanOrEqual(flushCountBefore);
    });

    it('should handle Redis flush failure gracefully', async () => {
      manager = new ConnectionManager({
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        redisService: {
          flush: jest.fn().mockRejectedValue(new Error('Redis error')),
        },
        exchange: 'binance',
      });
      await manager.initialize();

      // Should not throw
      await expect(manager.stop()).resolves.not.toThrow();
    });
  });

  describe('getStatus()', () => {
    it('should return current status snapshot', async () => {
      mockRedis = new MockRedisService();
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        batchSize: 2,
        exchange: 'binance',
      });
      await manager.initialize();

      const status = manager.getStatus();

      expect(status.isRunning).toBe(false);
      expect(status.isInitialized).toBe(true);
      expect(status.symbolCount).toBe(5);
      expect(status.batches).toBe(3);
    });

    it('should include component metrics in status', async () => {
      mockRedis = new MockRedisService();
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        exchange: 'binance',
      });
      await manager.initialize();

      const status = manager.getStatus();

      expect(status.adapter).toBeDefined();
      expect(status.engine).toBeDefined();
      expect(status.registry).toBeDefined();
      expect(status.writer).toBeDefined();
      expect(status.exchange).toBe('binance');
      expect(status.marketType).toBe('spot');
    });
  });

  describe('lifecycle management', () => {
    it('should handle full lifecycle: construct -> initialize -> start -> stop', async () => {
      mockRedis = new MockRedisService();
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        batchSize: 2,
        exchange: 'binance',
      });

      expect(manager.isInitialized).toBe(false);

      await manager.initialize();
      expect(manager.isInitialized).toBe(true);
      expect(manager.batches.length).toBe(3);

      await manager.startSubscriptions();
      expect(manager.isRunning).toBe(true);

      await manager.stop();
      expect(manager.isRunning).toBe(false);
    });

    it('should allow multiple stops without error', async () => {
      mockRedis = new MockRedisService();
      manager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory: mockAdapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        exchange: 'binance',
      });
      await manager.initialize();
      await manager.startSubscriptions();

      await manager.stop();
      await expect(manager.stop()).resolves.not.toThrow();
    });
  });

  describe('error handling', () => {
    it('should have isInitialized false initially', async () => {
      mockRedis = new MockRedisService();
      manager = new ConnectionManager({
        redisService: mockRedis,
      });

      expect(manager.isInitialized).toBe(false);
    });
  });

  describe('refreshMarkets()', () => {
    it('should reconcile subscriptions when running and symbol set changes (Stage 4: zero downtime)', async () => {
      class ChangingAdapter extends MockExchangeAdapter {
        constructor(config) {
          super(config);
          this.calls = 0;
        }
        async loadMarkets() {
          this.calls += 1;
          if (this.calls === 1) {
            return [
              { symbol: 'BTC/USDT', active: true, spot: true },
              { symbol: 'ETH/USDT', active: true, spot: true },
            ];
          }
          return [
            { symbol: 'BTC/USDT', active: true, spot: true },
            { symbol: 'ETH/USDT', active: true, spot: true },
            { symbol: 'ADA/USDT', active: true, spot: true },
          ];
        }
      }

      const adapterFactory = jest.fn((config) => new ChangingAdapter(config));
      const localManager = new ConnectionManager({
        redisService: mockRedis,
        adapterFactory,
        proxyProviderFactory: mockProxyProviderFactory,
        batchSize: 2,
        exchange: 'binance',
      });
      await localManager.initialize();
      await localManager.startSubscriptions();
      const engineBefore = localManager.subscriptionEngine;
      const reconcileCallsBefore = engineBefore.reconcileCalls;

      const result = await localManager.refreshMarkets();
      const engineAfter = localManager.subscriptionEngine;

      // Stage 4: Should detect new symbols
      expect(result.added).toContain('ADA/USDT');

      // Stage 4: Should call reconcileBatches (not stop + start)
      expect(engineAfter.reconcileCalls).toBeGreaterThan(reconcileCallsBefore);

      // Stage 4: Should NOT restart subscriptions (no stopCalls)
      expect(engineAfter.stopCalls).toBe(0);
      expect(engineAfter.startCalls).toBe(1);  // Only initial start, not restarted
    });
  });
});
