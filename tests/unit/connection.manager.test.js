/**
 * ConnectionManager Unit Tests
 *
 * Tests market loading, batching, normalization, and lifecycle.
 * IMPORTANT: Does NOT execute actual subscription loops to prevent memory issues.
 */

const ConnectionManager = require('../../src/core/connection.manager');

// Mock ExchangeFactory
class MockExchangeFactory {
  constructor(config = {}) {
    this.config = {
      exchange: config.exchange || 'binance',
      marketType: config.marketType || 'spot',
      logger: config.logger || (() => {}),
    };
  }

  createExchange() {
    return {
      close: jest.fn().mockResolvedValue(undefined),
      watchTickers: jest.fn(),
    };
  }

  async loadMarkets() {
    // Simulate loading markets
    return [
      { symbol: 'BTC/USDT', active: true, spot: true },
      { symbol: 'ETH/USDT', active: true, spot: true },
      { symbol: 'BNB/USDT', active: true, spot: true },
      { symbol: 'ADA/USDT', active: true, spot: true },
      { symbol: 'XRP/USDT', active: true, spot: true },
    ];
  }

  normalizeTicker(symbol, rawTicker) {
    return {
      symbol,
      exchange: this.config.exchange,
      marketType: this.config.marketType,
      last: rawTicker.last || 0,
      bid: rawTicker.bid || 0,
      ask: rawTicker.ask || 0,
      timestamp: rawTicker.timestamp || Date.now(),
    };
  }
}

// Mock RedisService
class MockRedisService {
  constructor() {
    this.updates = [];
    this.flushCount = 0;
  }

  async updateTicker(exchange, marketType, symbol, tickerData) {
    this.updates.push({ exchange, marketType, symbol, tickerData });
    return true;
  }

  async flush() {
    this.flushCount++;
    return true;
  }

  getStatus() {
    return { batchSize: this.updates.length };
  }
}

describe('ConnectionManager', () => {
  let manager;
  let mockFactory;
  let mockRedis;

  beforeEach(() => {
    mockFactory = new MockExchangeFactory();
    mockRedis = new MockRedisService();
  });

  afterEach(async () => {
    if (manager && manager.isRunning) {
      await manager.stop();
    }
  });

  describe('constructor', () => {
    it('should throw if exchangeFactory not provided', () => {
      expect(() => {
        new ConnectionManager({ redisService: mockRedis });
      }).toThrow('exchangeFactory is required');
    });

    it('should throw if redisService not provided', () => {
      expect(() => {
        new ConnectionManager({ exchangeFactory: mockFactory });
      }).toThrow('redisService is required');
    });

    it('should initialize with valid config', () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        batchSize: 50,
      });

      expect(manager.config.batchSize).toBe(50);
      expect(manager.isRunning).toBe(false);
      expect(manager.symbols).toEqual([]);
    });

    it('should use default batchSize if not provided', () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });

      expect(manager.config.batchSize).toBe(100);
    });
  });

  describe('initialize()', () => {
    it('should load markets and create exchange instance', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });

      await manager.initialize();

      expect(manager.exchange).toBeDefined();
      expect(manager.symbols.length).toBe(5);
      expect(manager.symbols[0]).toBe('ADA/USDT'); // Sorted
    });

    it('should create batches from loaded symbols', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        batchSize: 2,
      });

      await manager.initialize();

      expect(manager.batches.length).toBe(3); // 5 symbols / 2 per batch = 3 batches
      expect(manager.batches[0]).toEqual(['ADA/USDT', 'BNB/USDT']);
      expect(manager.batches[1]).toEqual(['BTC/USDT', 'ETH/USDT']);
      expect(manager.batches[2]).toEqual(['XRP/USDT']);
    });

    it('should handle single batch when symbols < batchSize', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        batchSize: 100,
      });

      await manager.initialize();

      expect(manager.batches.length).toBe(1);
      expect(manager.batches[0].length).toBe(5);
    });

    it('should throw if exchange factory fails', async () => {
      const badFactory = {
        createExchange: jest.fn(() => {
          throw new Error('Exchange creation failed');
        }),
      };

      manager = new ConnectionManager({
        exchangeFactory: badFactory,
        redisService: mockRedis,
      });

      await expect(manager.initialize()).rejects.toThrow('Exchange creation failed');
    });
  });

  describe('batching logic', () => {
    it('should split 10 symbols into 4 batches with batchSize=3', async () => {
      mockFactory.loadMarkets = jest.fn(async () => {
        return Array.from({ length: 10 }, (_, i) => ({
          symbol: `SYM${i}/USDT`,
          active: true,
          spot: true,
        }));
      });

      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        batchSize: 3,
      });

      await manager.initialize();

      expect(manager.batches.length).toBe(4);
      expect(manager.batches[0].length).toBe(3);
      expect(manager.batches[1].length).toBe(3);
      expect(manager.batches[2].length).toBe(3);
      expect(manager.batches[3].length).toBe(1); // Remainder
    });

    it('should create empty batches array if no symbols', async () => {
      mockFactory.loadMarkets = jest.fn(async () => []);

      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        batchSize: 100,
      });

      await manager.initialize();

      expect(manager.batches.length).toBe(0);
      expect(manager.symbols.length).toBe(0);
    });
  });

  describe('startSubscriptions()', () => {
    beforeEach(async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        batchSize: 2,
      });
      await manager.initialize();
    });

    it('should set isRunning to true', async () => {
      await manager.startSubscriptions();
      expect(manager.isRunning).toBe(true);
    });

    it('should schedule subscription timers for each batch', async () => {
      await manager.startSubscriptions();

      // Should have one timer per batch
      expect(manager.subscriptionTimers.length).toBe(manager.batches.length);
    });

    it('should not start if already running', async () => {
      await manager.startSubscriptions();
      const timerCountBefore = manager.subscriptionTimers.length;

      await manager.startSubscriptions(); // Second call

      expect(manager.subscriptionTimers.length).toBe(timerCountBefore);
    });

    it('should throw if not initialized', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });

      await expect(manager.startSubscriptions()).rejects.toThrow('Not initialized');
    });
  });

  describe('stop()', () => {
    it('should set isRunning to false', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();
      await manager.startSubscriptions();

      expect(manager.isRunning).toBe(true);

      await manager.stop();

      expect(manager.isRunning).toBe(false);
    });

    it('should clear subscription timers', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();
      await manager.startSubscriptions();

      const timerCountBefore = manager.subscriptionTimers.length;
      expect(timerCountBefore).toBeGreaterThan(0);

      await manager.stop();

      expect(manager.subscriptionTimers.length).toBe(0);
    });

    it('should flush Redis batch', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();

      const flushCountBefore = mockRedis.flushCount;
      await manager.stop();

      expect(mockRedis.flushCount).toBeGreaterThan(flushCountBefore);
    });

    it('should close exchange instance', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();

      const closeSpy = jest.spyOn(manager.exchange, 'close');
      await manager.stop();

      expect(closeSpy).toHaveBeenCalled();
    });

    it('should handle Redis flush failure gracefully', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: {
          flush: jest.fn().mockRejectedValue(new Error('Redis error')),
        },
      });
      await manager.initialize();

      // Should not throw
      await expect(manager.stop()).resolves.not.toThrow();
    });

    it('should handle exchange close failure gracefully', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();

      jest.spyOn(manager.exchange, 'close').mockRejectedValue(new Error('Close failed'));

      // Should not throw
      await expect(manager.stop()).resolves.not.toThrow();
    });
  });

  describe('getStatus()', () => {
    it('should return current status snapshot', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        batchSize: 2,
      });
      await manager.initialize();

      const status = manager.getStatus();

      expect(status.isRunning).toBe(false);
      expect(status.symbols).toBe(5);
      expect(status.batches).toBe(3);
      expect(status.stats.totalUpdates).toBe(0);
    });

    it('should include stats in status', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();

      const status = manager.getStatus();

      expect(status.stats).toHaveProperty('totalUpdates');
      expect(status.stats).toHaveProperty('failedUpdates');
      expect(status.stats).toHaveProperty('normalizationErrors');
      expect(status.stats).toHaveProperty('batchesStarted');
    });
  });

  describe('ticker normalization integration', () => {
    it('should normalize ticker using exchangeFactory', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();

      const rawTicker = {
        last: 45000,
        bid: 44999,
        ask: 45001,
        timestamp: 1000000,
      };

      const normalized = manager.config.exchangeFactory.normalizeTicker('BTC/USDT', rawTicker);

      expect(normalized.symbol).toBe('BTC/USDT');
      expect(normalized.last).toBe(45000);
      expect(normalized.exchange).toBe('binance');
    });
  });

  describe('error handling', () => {
    it('should handle initialization errors', async () => {
      const errorFactory = {
        createExchange: jest.fn(() => ({ close: jest.fn() })),
        loadMarkets: jest.fn().mockRejectedValue(new Error('Market load failed')),
      };

      manager = new ConnectionManager({
        exchangeFactory: errorFactory,
        redisService: mockRedis,
      });

      await expect(manager.initialize()).rejects.toThrow('Market load failed');
    });

    it('should have stats tracking for failures', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();

      expect(manager.stats).toHaveProperty('totalUpdates');
      expect(manager.stats).toHaveProperty('failedUpdates');
      expect(manager.stats).toHaveProperty('normalizationErrors');
    });
  });

  describe('lifecycle management', () => {
    it('should handle full lifecycle: construct -> initialize -> start -> stop', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        batchSize: 2,
      });

      expect(manager.symbols).toEqual([]);

      await manager.initialize();
      expect(manager.symbols.length).toBe(5);
      expect(manager.batches.length).toBe(3);

      await manager.startSubscriptions();
      expect(manager.isRunning).toBe(true);

      await manager.stop();
      expect(manager.isRunning).toBe(false);
    });

    it('should allow multiple stops without error', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();
      await manager.startSubscriptions();

      await manager.stop();
      await expect(manager.stop()).resolves.not.toThrow();
    });
  });
});
