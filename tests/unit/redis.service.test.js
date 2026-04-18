/**
 * RedisService - Unit Tests (TRANSPORT-ONLY)
 *
 * Phase 5E: Tests for connection lifecycle and read operations only
 * Tests for write/dedup/batching moved to RedisWriter
 *
 * Mocked ioredis to avoid external dependencies.
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

describe('RedisService (Transport-Only)', () => {
  let redisService;
  let mockRedis;

  beforeEach(() => {
    // Clear mocks
    jest.clearAllMocks();

    // Setup mock pipeline
    const mockPipeline = {
      hset: jest.fn().mockReturnThis(),
      publish: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 1], [null, 1]]),
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
      expect(redisService.isConnected).toBe(false);
    });

    it('should initialize with custom config', () => {
      redisService = new RedisService({
        redisUrl: 'redis://custom:6379',
      });

      expect(redisService.config.redisUrl).toBe('redis://custom:6379');
    });

    it('should have empty stats on init', () => {
      redisService = new RedisService();
      expect(redisService.stats.failedWrites).toBe(0);
    });
  });

  describe('Connection Management', () => {
    it('should connect successfully', async () => {
      redisService = new RedisService();
      await redisService.connect();

      expect(redisService.isConnected).toBe(true);
      expect(redisService.isConnecting).toBe(false);
      expect(mockRedis.ping).toHaveBeenCalled();
    });

    it('should not attempt reconnect if already connected', async () => {
      redisService = new RedisService();
      await redisService.connect();
      jest.clearAllMocks();

      await redisService.connect();
      expect(mockRedis.ping).not.toHaveBeenCalled();
    });

    it('should handle connection errors', async () => {
      redisService = new RedisService();
      mockRedis.ping.mockRejectedValue(new Error('Connection refused'));

      await expect(redisService.connect()).rejects.toThrow('Connection refused');
      expect(redisService.isConnected).toBe(false);
    });

    it('should disconnect successfully', async () => {
      redisService = new RedisService();
      await redisService.connect();
      await redisService.disconnect();

      expect(mockRedis.quit).toHaveBeenCalled();
      expect(redisService.isConnected).toBe(false);
    });

    it('should report isReady() status correctly', async () => {
      redisService = new RedisService();

      expect(redisService.isReady()).toBe(false);

      await redisService.connect();
      expect(redisService.isReady()).toBe(true);

      await redisService.disconnect();
      expect(redisService.isReady()).toBe(false);
    });
  });

  describe('Read Operations', () => {
    beforeEach(async () => {
      redisService = new RedisService();
      await redisService.connect();
    });

    it('should get a ticker from Redis', async () => {
      const tickerData = { last: 100, bid: 99, ask: 101 };
      mockRedis.hget.mockResolvedValue(JSON.stringify(tickerData));

      const result = await redisService.getTicker('binance', 'spot', 'BTC/USDT');

      expect(mockRedis.hget).toHaveBeenCalledWith('ticker:binance:spot', 'BTC/USDT');
      expect(result).toEqual(tickerData);
    });

    it('should return null if ticker not found', async () => {
      mockRedis.hget.mockResolvedValue(null);

      const result = await redisService.getTicker('binance', 'spot', 'BTC/USDT');

      expect(result).toBeNull();
    });

    it('should get all tickers for exchange/market', async () => {
      const tickers = {
        'BTC/USDT': '{"last":100}',
        'ETH/USDT': '{"last":2000}',
      };
      mockRedis.hgetall.mockResolvedValue(tickers);

      const result = await redisService.getAllTickers('binance', 'spot');

      expect(mockRedis.hgetall).toHaveBeenCalledWith('ticker:binance:spot');
      expect(result).toEqual({
        'BTC/USDT': { last: 100 },
        'ETH/USDT': { last: 2000 },
      });
    });

    it('should return empty object if no tickers found', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const result = await redisService.getAllTickers('binance', 'spot');

      expect(result).toEqual({});
    });

    it('should delete a ticker from Redis', async () => {
      const result = await redisService.deleteTicker('binance', 'spot', 'BTC/USDT');

      expect(mockRedis.hdel).toHaveBeenCalledWith('ticker:binance:spot', 'BTC/USDT');
      expect(result).toBe(true);
    });

    it('should handle delete errors gracefully', async () => {
      mockRedis.hdel.mockRejectedValue(new Error('Delete failed'));

      const result = await redisService.deleteTicker('binance', 'spot', 'BTC/USDT');

      expect(result).toBe(false);
    });
  });

  describe('Pipeline Operations', () => {
    beforeEach(async () => {
      redisService = new RedisService();
      await redisService.connect();
    });

    it('should create a pipeline', () => {
      const pipeline = redisService.createPipeline();

      expect(pipeline).toBeDefined();
      expect(mockRedis.pipeline).toHaveBeenCalled();
    });

    it('should throw error if creating pipeline when not connected', () => {
      redisService.redis = null;
      redisService.isConnected = false;

      expect(() => redisService.createPipeline()).toThrow('Redis not connected');
    });

    it('should execute a pipeline', async () => {
      const pipeline = redisService.createPipeline();
      const result = await redisService.execPipeline(pipeline);

      expect(result).toEqual([[null, 1], [null, 1]]);
      expect(pipeline.exec).toHaveBeenCalled();
    });

    it('should throw error if executing null pipeline', async () => {
      await expect(redisService.execPipeline(null)).rejects.toThrow('Pipeline is required');
    });

    it('should handle pipeline execution errors', async () => {
      const pipeline = redisService.createPipeline();
      pipeline.exec.mockRejectedValue(new Error('Pipeline failed'));

      await expect(redisService.execPipeline(pipeline)).rejects.toThrow('Pipeline failed');
    });
  });

  describe('Status & Metrics', () => {
    it('should return status', async () => {
      redisService = new RedisService();
      const status = redisService.getStatus();

      expect(status.isConnected).toBe(false);
      expect(status.isConnecting).toBe(false);
    });

    it('should reflect connected status', async () => {
      redisService = new RedisService();
      await redisService.connect();

      const status = redisService.getStatus();
      expect(status.isConnected).toBe(true);
    });
  });

  describe('Pub/Sub Operations', () => {
    beforeEach(async () => {
      redisService = new RedisService();
      await redisService.connect();
    });

    it('should subscribe to a channel', async () => {
      const callback = jest.fn();
      const result = await redisService.subscribe('binance', 'spot', 'BTC/USDT', callback);

      expect(result).toBe(true);
    });

    it('should handle subscribe errors gracefully', async () => {
      const callback = jest.fn();
      Redis.mockImplementation(() => {
        throw new Error('Redis subscribe failed');
      });

      redisService = new RedisService();
      const result = await redisService.subscribe('binance', 'spot', 'BTC/USDT', callback);

      expect(result).toBe(false);
    });
  });
});
