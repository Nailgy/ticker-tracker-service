/**
 * RedisService - Unit Tests
 *
 * Tests deduplication, batching, pipeline execution, and connection logic
 * using mocked ioredis to avoid external dependencies.
 */

const RedisService = require('../../src/services/redis.service');

// Mock ioredis
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
    hset: jest.fn().mockResolvedValue(1),
    hget: jest.fn().mockResolvedValue(null),
    hdel: jest.fn().mockResolvedValue(1),
    hgetall: jest.fn().mockResolvedValue({}),
    publish: jest.fn().mockResolvedValue(0),
    subscribe: jest.fn().mockResolvedValue(1),
    pipeline: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
  }));
});

const Redis = require('ioredis');

describe('RedisService', () => {
  let redisService;
  let mockRedis;

  beforeEach(() => {
    // Clear mocks
    jest.clearAllMocks();

    // Setup mock pipeline
    const mockPipeline = {
      hset: jest.fn().mockReturnThis(),
      publish: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[1, 1], [1, 1]]),
    };

    // Setup default mock Redis instance
    mockRedis = {
      ping: jest.fn().mockResolvedValue('PONG'),
      on: jest.fn(),
      hset: jest.fn().mockResolvedValue(1),
      hget: jest.fn().mockResolvedValue(null),
      hdel: jest.fn().mockResolvedValue(1),
      hgetall: jest.fn().mockResolvedValue({}),
      publish: jest.fn().mockResolvedValue(0),
      subscribe: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn().mockReturnValue(mockPipeline),
      quit: jest.fn().mockResolvedValue('OK'),
    };

    Redis.mockImplementation(() => mockRedis);
  });

  describe('Constructor & Initialization', () => {
    it('should initialize with default config', () => {
      redisService = new RedisService();

      expect(redisService.config.redisUrl).toBe('localhost:6379');
      expect(redisService.config.redisBatching).toBe(true);
      expect(redisService.config.redisFlushMs).toBe(1000);
      expect(redisService.config.redisMaxBatch).toBe(1000);
      expect(redisService.isConnected).toBe(false);
    });

    it('should initialize with custom config', () => {
      redisService = new RedisService({
        redisUrl: 'redis://custom:6379',
        redisFlushMs: 500,
        redisMaxBatch: 100,
        redisBatching: false,
      });

      expect(redisService.config.redisUrl).toBe('redis://custom:6379');
      expect(redisService.config.redisFlushMs).toBe(500);
      expect(redisService.config.redisMaxBatch).toBe(100);
      expect(redisService.config.redisBatching).toBe(false);
    });

    it('should have empty dedup cache on init', () => {
      redisService = new RedisService();
      expect(redisService.dedupCache.size).toBe(0);
    });

    it('should have zero stats on init', () => {
      redisService = new RedisService();
      expect(redisService.stats.totalUpdates).toBe(0);
      expect(redisService.stats.dedupedUpdates).toBe(0);
      expect(redisService.stats.batchedUpdates).toBe(0);
    });
  });

  describe('Connection Management', () => {
    it('should connect successfully', async () => {
      redisService = new RedisService();

      await redisService.connect();

      expect(Redis).toHaveBeenCalledWith('localhost:6379', expect.any(Object));
      expect(mockRedis.ping).toHaveBeenCalled();
      expect(redisService.isConnected).toBe(true);
    });

    it('should not reconnect if already connected', async () => {
      redisService = new RedisService();

      await redisService.connect();
      const callCount = Redis.mock.calls.length;

      await redisService.connect();

      expect(Redis.mock.calls.length).toBe(callCount);
    });

    it('should setup event handlers on connect', async () => {
      redisService = new RedisService();

      await redisService.connect();

      expect(mockRedis.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockRedis.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should disconnect gracefully', async () => {
      redisService = new RedisService();

      await redisService.connect();
      await redisService.disconnect();

      expect(mockRedis.quit).toHaveBeenCalled();
      expect(redisService.isConnected).toBe(false);
    });

    it('should throw error if connection fails', async () => {
      mockRedis.ping.mockRejectedValueOnce(new Error('Connection refused'));
      redisService = new RedisService();

      await expect(redisService.connect()).rejects.toThrow('Connection refused');
      expect(redisService.isConnected).toBe(false);
    });
  });

  describe('Deduplication Cache', () => {
    beforeEach(async () => {
      redisService = new RedisService({
        redisBatching: false, // Disable batching for simpler tests
      });
      await redisService.connect();
    });

    it('should skip duplicate updates (no change)', async () => {
      const tickerData = { symbol: 'BTC/USDT', last: 68000 };

      // First update
      const result1 = await redisService.updateTicker('binance', 'spot', 'BTC/USDT', tickerData);
      expect(result1).toBe(true);
      expect(redisService.stats.totalUpdates).toBe(1);
      expect(redisService.stats.dedupedUpdates).toBe(0);

      // Second identical update
      const result2 = await redisService.updateTicker('binance', 'spot', 'BTC/USDT', tickerData);
      expect(result2).toBe(false);
      expect(redisService.stats.totalUpdates).toBe(2);
      expect(redisService.stats.dedupedUpdates).toBe(1);
    });

    it('should write on change', async () => {
      const ticker1 = { symbol: 'BTC/USDT', last: 68000 };
      const ticker2 = { symbol: 'BTC/USDT', last: 68100 };

      const result1 = await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker1);
      expect(result1).toBe(true);

      const result2 = await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker2);
      expect(result2).toBe(true);
      expect(redisService.stats.dedupedUpdates).toBe(0);
    });

    it('should respect min interval config', async () => {
      redisService.config.redisMinIntervalMs = 1000;

      const ticker1 = { last: 68000 };
      const ticker2 = { last: 68100 };

      const result1 = await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker1);
      expect(result1).toBe(true);

      const result2 = await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker2);
      expect(result2).toBe(false); // Rate-limited
      expect(redisService.stats.dedupedUpdates).toBe(1);
    });

    it('should track hash correctly', async () => {
      const ticker = { symbol: 'BTC/USDT', last: 68000 };
      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker);

      const cached = redisService.dedupCache.get('BTC/USDT');
      expect(cached).toBeDefined();
      expect(cached.hash).toBeDefined();
      expect(typeof cached.hash).toBe('string');
      expect(cached.lastWriteTime).toBeDefined();
    });

    it('should delete from dedup cache on ticker delete', async () => {
      const ticker = { symbol: 'BTC/USDT', last: 68000 };
      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker);
      expect(redisService.dedupCache.size).toBe(1);

      await redisService.deleteTicker('binance', 'spot', 'BTC/USDT');
      expect(redisService.dedupCache.size).toBe(0);
    });
  });

  describe('Batching & Pipeline', () => {
    beforeEach(async () => {
      redisService = new RedisService({
        redisBatching: true,
        redisFlushMs: 500,
        redisMaxBatch: 10,
      });
      await redisService.connect();
    });

    it('should accumulate updates in batch', async () => {
      const ticker = { symbol: 'BTC/USDT', last: 68000 };
      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker);

      expect(redisService.batch.length).toBe(1);
      expect(redisService.stats.batchedUpdates).toBe(1);
    });

    it('should add multiple updates to same batch', async () => {
      const ticker1 = { symbol: 'BTC/USDT', last: 68000 };
      const ticker2 = { symbol: 'ETH/USDT', last: 3800 };

      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker1);
      await redisService.updateTicker('binance', 'spot', 'ETH/USDT', ticker2);

      expect(redisService.batch.length).toBe(2);
    });

    it('should flush batch when size limit reached', async () => {
      mockRedis.pipeline.mockReturnValue({
        hset: jest.fn().mockReturnThis(),
        publish: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(Array(20).fill([1, 1])), // 20 operations
      });

      redisService.config.redisMaxBatch = 2;

      const ticker1 = { last: 68000 };
      const ticker2 = { last: 3800 };
      const ticker3 = { last: 100000 };

      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker1);
      expect(redisService.batch.length).toBe(1);

      // Second update reaches max batch size (2), triggers flush
      await redisService.updateTicker('binance', 'spot', 'ETH/USDT', ticker2);
      expect(redisService.batch.length).toBe(0); // Flushed
      expect(redisService.stats.flushedBatches).toBe(1);

      // Third update adds to (now empty) batch
      await redisService.updateTicker('binance', 'spot', 'SOL/USDT', ticker3);
      expect(redisService.batch.length).toBe(1);
    });

    it('should execute pipeline with hset and publish commands', async () => {
      const mockPipeline = {
        hset: jest.fn().mockReturnThis(),
        publish: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(Array(4).fill([1, 1])), // 2 operations * 2
      };

      mockRedis.pipeline.mockReturnValue(mockPipeline);

      const ticker = { last: 68000 };
      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker);
      await redisService.flush();

      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(mockPipeline.hset).toHaveBeenCalledWith(
        'ticker:binance:spot',
        'BTC/USDT',
        expect.any(String)
      );
      expect(mockPipeline.publish).toHaveBeenCalledWith(
        'ticker:binance:spot:BTC/USDT',
        expect.any(String)
      );
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it('should clear batch after flush', async () => {
      mockRedis.pipeline.mockReturnValue({
        hset: jest.fn().mockReturnThis(),
        publish: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([[1, 1], [1, 1]]),
      });

      const ticker = { last: 68000 };
      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker);

      expect(redisService.batch.length).toBe(1);
      await redisService.flush();
      expect(redisService.batch.length).toBe(0);
    });

    it('should not flush if batch is empty', async () => {
      mockRedis.pipeline.mockReturnValue({
        exec: jest.fn().mockResolvedValue([]),
      });

      const result = await redisService.flush();

      expect(result).toBe(true);
      expect(mockRedis.pipeline).not.toHaveBeenCalled();
    });

    it('should not flush if already flushing', async () => {
      mockRedis.pipeline.mockReturnValue({
        hset: jest.fn().mockReturnThis(),
        publish: jest.fn().mockReturnThis(),
        exec: jest.fn().mockImplementationOnce(async () => {
          // Simulate ongoing flush
          await new Promise(resolve => setTimeout(resolve, 100));
          return [[1, 1], [1, 1]];
        }),
      });

      const ticker = { last: 68000 };
      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker);

      const flush1Promise = redisService.flush();
      const flush2Result = await redisService.flush(); // Should not flush while flush1 is pending

      expect(flush2Result).toBe(true);
      await flush1Promise;
    });
  });

  describe('Direct Writes (No Batching)', () => {
    beforeEach(async () => {
      redisService = new RedisService({
        redisBatching: false,
      });
      await redisService.connect();
    });

    it('should write immediately when batching disabled', async () => {
      mockRedis.pipeline.mockReturnValue({
        hset: jest.fn().mockReturnThis(),
        publish: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([[1, 1], [1, 1]]),
      });

      const ticker = { last: 68000 };
      const result = await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker);

      expect(result).toBe(true);
      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(redisService.batch.length).toBe(0);
    });
  });

  describe('Read Operations', () => {
    beforeEach(async () => {
      redisService = new RedisService();
      await redisService.connect();
    });

    it('should get single ticker', async () => {
      const tickerData = { symbol: 'BTC/USDT', last: 68000 };
      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(tickerData));

      const result = await redisService.getTicker('binance', 'spot', 'BTC/USDT');

      expect(mockRedis.hget).toHaveBeenCalledWith('ticker:binance:spot', 'BTC/USDT');
      expect(result).toEqual(tickerData);
    });

    it('should return null if ticker not found', async () => {
      mockRedis.hget.mockResolvedValueOnce(null);

      const result = await redisService.getTicker('binance', 'spot', 'UNKNOWN');

      expect(result).toBeNull();
    });

    it('should get all tickers for exchange', async () => {
      const allTickers = {
        'BTC/USDT': JSON.stringify({ symbol: 'BTC/USDT', last: 68000 }),
        'ETH/USDT': JSON.stringify({ symbol: 'ETH/USDT', last: 3800 }),
      };
      mockRedis.hgetall.mockResolvedValueOnce(allTickers);

      const result = await redisService.getAllTickers('binance', 'spot');

      expect(mockRedis.hgetall).toHaveBeenCalledWith('ticker:binance:spot');
      expect(Object.keys(result)).toHaveLength(2);
      expect(result['BTC/USDT'].last).toBe(68000);
    });

    it('should handle malformed JSON in getAllTickers', async () => {
      const data = {
        'BTC/USDT': JSON.stringify({ last: 68000 }),
        'INVALID': 'not-json',
        'ETH/USDT': JSON.stringify({ last: 3800 }),
      };
      mockRedis.hgetall.mockResolvedValueOnce(data);

      const result = await redisService.getAllTickers('binance', 'spot');

      expect(Object.keys(result)).toHaveLength(2); // INVALID skipped
      expect(result['BTC/USDT']).toBeDefined();
      expect(result['INVALID']).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      redisService = new RedisService();
      await redisService.connect();
    });

    it('should return false if not connected', async () => {
      redisService.isConnected = false;

      const result = await redisService.updateTicker('binance', 'spot', 'BTC/USDT', {});

      expect(result).toBe(false);
    });

    it('should handle flush errors', async () => {
      mockRedis.pipeline.mockReturnValue({
        hset: jest.fn().mockReturnThis(),
        publish: jest.fn().mockReturnThis(),
        exec: jest.fn().mockRejectedValueOnce(new Error('Pipeline failed')),
      });

      redisService.batch.push({
        key: 'ticker:binance:spot',
        field: 'BTC/USDT',
        value: '{}',
        pubsubChannel: 'ticker:binance:spot:BTC/USDT',
      });

      await expect(redisService.flush()).rejects.toThrow('Pipeline failed');
      expect(redisService.stats.failedWrites).toBe(1);
    });

    it('should handle getTicker errors', async () => {
      mockRedis.hget.mockRejectedValueOnce(new Error('Read failed'));

      const result = await redisService.getTicker('binance', 'spot', 'BTC/USDT');

      expect(result).toBeNull();
    });
  });

  describe('Metrics & Status', () => {
    beforeEach(async () => {
      redisService = new RedisService();
      await redisService.connect();
    });

    it('should track stats correctly', async () => {
      const ticker = { last: 68000 };

      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker);
      expect(redisService.stats.totalUpdates).toBe(1);

      await redisService.updateTicker('binance', 'spot', 'BTC/USDT', ticker);
      expect(redisService.stats.dedupedUpdates).toBe(1);

      expect(redisService.stats.totalUpdates).toBe(2);
    });

    it('should return status snapshot', () => {
      const status = redisService.getStatus();

      expect(status.isConnected).toBe(true);
      expect(status.isConnecting).toBe(false);
      expect(status.batchSize).toBe(0);
      expect(status.dedupCacheSize).toBe(0);
      expect(status.stats).toBeDefined();
      expect(status.stats.totalUpdates).toBe(0);
    });
  });

  describe('Key Generation', () => {
    beforeEach(() => {
      redisService = new RedisService();
    });

    it('should generate correct hash key', () => {
      const key = redisService._makeHashKey('binance', 'spot');
      expect(key).toBe('ticker:binance:spot');
    });

    it('should handle different exchanges and types', () => {
      const key1 = redisService._makeHashKey('bybit', 'swap');
      const key2 = redisService._makeHashKey('kraken', 'spot');

      expect(key1).toBe('ticker:bybit:swap');
      expect(key2).toBe('ticker:kraken:spot');
    });
  });

  describe('Batch Timer', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should start batch timer on connect when batching enabled', async () => {
      redisService = new RedisService({ redisBatching: true });

      await redisService.connect();

      expect(redisService.batchTimer).toBeDefined();
    });

    it('should not start batch timer when batching disabled', async () => {
      redisService = new RedisService({ redisBatching: false });

      await redisService.connect();

      expect(redisService.batchTimer).toBeNull();
    });

    it('should clear batch timer on disconnect', async () => {
      redisService = new RedisService({ redisBatching: true });

      await redisService.connect();
      const timerId = redisService.batchTimer;

      await redisService.disconnect();

      expect(redisService.batchTimer).toBeNull();
    });
  });
});
