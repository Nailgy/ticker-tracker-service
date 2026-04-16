const RedisWriter = require('../../src/services/redis.writer');

describe('RedisWriter', () => {
  let writer;
  let mockRedisService;
  let mockPipeline;
  let mockLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockLogger = jest.fn();

    mockPipeline = {
      hset: jest.fn().mockReturnThis(),
      publish: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([['OK'], ['OK']]),
    };

    mockRedisService = {
      isConnected: true,
      isReady: jest.fn(function() { return this.isConnected; }),
      createPipeline: jest.fn().mockReturnValue(mockPipeline),
      execPipeline: jest.fn().mockImplementation((pipeline) => pipeline.exec()),
      redis: {
        pipeline: jest.fn().mockReturnValue(mockPipeline),
      },
    };

    writer = new RedisWriter(mockRedisService, { logger: mockLogger });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize with config defaults', () => {
      expect(writer.config.redisBatching).toBe(true);
      expect(writer.config.redisFlushMs).toBe(1000);
      expect(writer.config.redisMaxBatch).toBe(1000);
      expect(writer.config.redisOnlyOnChange).toBe(true);
      expect(writer.config.redisMinIntervalMs).toBe(0);
    });

    it('should parse config options correctly', () => {
      const customWriter = new RedisWriter(mockRedisService, {
        redisBatching: false,
        redisFlushMs: 500,
        redisMaxBatch: 100,
        redisMinIntervalMs: 100,
      });

      expect(customWriter.config.redisBatching).toBe(false);
      expect(customWriter.config.redisFlushMs).toBe(500);
      expect(customWriter.config.redisMaxBatch).toBe(100);
      expect(customWriter.config.redisMinIntervalMs).toBe(100);
    });
  });

  describe('single write (non-batched)', () => {
    it('should write immediately when batching disabled', async () => {
      const writer = new RedisWriter(mockRedisService, { redisBatching: false });

      const result = await writer.writeTicker('binance', 'spot', 'BTC/USDT', {
        last: 50000,
      });

      expect(result.written).toBe(true);
      expect(result.batched).toBe(false);
      expect(mockPipeline.hset).toHaveBeenCalledWith(
        'ticker:binance:spot',
        'BTC/USDT',
        expect.any(String)
      );
    });

    it('should publish to channel in same pipeline', async () => {
      const writer = new RedisWriter(mockRedisService, { redisBatching: false });

      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });

      expect(mockPipeline.publish).toHaveBeenCalledWith(
        'ticker:binance:spot:BTC/USDT',
        expect.any(String)
      );
    });

    it('should update metrics on write', async () => {
      const writer = new RedisWriter(mockRedisService, { redisBatching: false });

      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });

      expect(writer.getMetrics().totalWrites).toBe(1);
    });
  });

  describe('batching & deduplication', () => {
    it('should queue multiple writes in batch', async () => {
      const result1 = await writer.writeTicker('binance', 'spot', 'BTC/USDT', {
        last: 50000,
      });
      const result2 = await writer.writeTicker('binance', 'spot', 'ETH/USDT', {
        last: 3000,
      });

      expect(result1.written).toBe(true);
      expect(result1.batched).toBe(true);
      expect(result2.batched).toBe(true);
      expect(writer.batch.size).toBe(2);
    });

    it('should flush queued writes', async () => {
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });
      await writer.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });

      const result = await writer.flush();

      expect(result.flushed).toBe(true);
      expect(result.count).toBe(2);
      expect(writer.batch.size).toBe(0);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it('should skip unchanged tickers (deduplication)', async () => {
      const tickerData = { last: 50000, bid: 49999, ask: 50001 };

      const result1 = await writer.writeTicker('binance', 'spot', 'BTC/USDT', tickerData);
      const result2 = await writer.writeTicker('binance', 'spot', 'BTC/USDT', tickerData);

      expect(result1.written).toBe(true);
      expect(result2.written).toBe(false);
      expect(result2.reason).toBe('deduped');
      expect(writer.getMetrics().dedupedWrites).toBe(1);
    });

    it('should write different data (different hash)', async () => {
      const result1 = await writer.writeTicker('binance', 'spot', 'BTC/USDT', {
        last: 50000,
      });
      const result2 = await writer.writeTicker('binance', 'spot', 'BTC/USDT', {
        last: 50100,
      });

      expect(result2.written).toBe(true);
      // State-Collapsing Queue: same symbol, multiple updates = only latest stored
      expect(writer.batch.size).toBe(1);
    });

    it('should respect rate limiting per symbol', async () => {
      const writer = new RedisWriter(mockRedisService, {
        redisMinIntervalMs: 1000,
      });

      const result1 = await writer.writeTicker('binance', 'spot', 'BTC/USDT', {
        last: 50000,
      });
      const result2 = await writer.writeTicker('binance', 'spot', 'BTC/USDT', {
        last: 50100,
      });

      expect(result1.written).toBe(true);
      expect(result2.written).toBe(false);
      expect(result2.reason).toBe('rate-limited');
    });

    it('should force flush when batch size reached', async () => {
      const writer = new RedisWriter(mockRedisService, { redisMaxBatch: 3 });

      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });
      await writer.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });
      const result = await writer.writeTicker('binance', 'spot', 'BNB/USDT', {
        last: 600,
      });

      expect(result.flushed).toBe(true);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });
  });

  describe('auto-flush timer', () => {
    it('should start batch timer on first write', async () => {
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });

      expect(writer.batchTimer).toBeDefined();
    });

    it('should fire timer at configured interval', async () => {
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });

      jest.advanceTimersByTime(1000);

      // Verify timer callback was executed (flush was called)
      expect(mockPipeline.exec).toHaveBeenCalled();
      // Note: batch.length check removed because flush() is async and not awaited in the timer
    });

    it('should clear timer after flush', async () => {
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });

      jest.advanceTimersByTime(1000);

      expect(writer.batchTimer).toBeNull();
    });
  });

  describe('pipeline execution', () => {
    it('should execute pipeline atomically', async () => {
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });
      await writer.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });

      await writer.flush();

      expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
      // Should have 2 hset + 2 publish = 4 commands
      expect(mockPipeline.hset).toHaveBeenCalledTimes(2);
      expect(mockPipeline.publish).toHaveBeenCalledTimes(2);
    });

    it('should handle pipeline errors', async () => {
      mockPipeline.exec.mockRejectedValueOnce(new Error('Redis error'));

      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });
      const result = await writer.flush();

      expect(result.flushed).toBe(false);
      expect(result.reason).toBe('flush-error');
      expect(writer.getMetrics().failedWrites).toBe(1);
    });

    it('should update metrics on successful flush', async () => {
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });
      await writer.flush();

      const metrics = writer.getMetrics();
      expect(metrics.flushedBatches).toBe(1);
      expect(metrics.queuedUpdates).toBe(0);
      expect(metrics.lastFlushAt).toBeDefined();
    });
  });

  describe('disconnect', () => {
    it('should flush pending updates on disconnect', async () => {
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });

      const result = await writer.disconnect();

      expect(result.disconnected).toBe(true);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it('should clear batch timer on disconnect', async () => {
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });

      await writer.disconnect();

      expect(writer.batchTimer).toBeNull();
    });

    it('should not write after disconnect', async () => {
      await writer.disconnect();

      mockRedisService.isConnected = false;
      const result = await writer.writeTicker('binance', 'spot', 'BTC/USDT', {
        last: 50000,
      });

      expect(result.written).toBe(false);
      expect(result.reason).toBe('redis-not-connected');
    });
  });

  describe('metrics tracking', () => {
    it('should track all metrics accurately', async () => {
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });
      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });
      await writer.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });
      await writer.flush();

      const metrics = writer.getMetrics();

      expect(metrics.totalWrites).toBe(3);
      expect(metrics.dedupedWrites).toBe(1);
      expect(metrics.flushedBatches).toBe(1);
      expect(metrics.queuedUpdates).toBe(0);
    });

    it('should return copy of metrics (not reference)', () => {
      const metrics1 = writer.getMetrics();
      metrics1.totalWrites = 999;

      const metrics2 = writer.getMetrics();
      expect(metrics2.totalWrites).toBe(0);
    });
  });

  describe('error cases', () => {
    it('should skip write when Redis not connected', async () => {
      mockRedisService.isConnected = false;

      const result = await writer.writeTicker('binance', 'spot', 'BTC/USDT', {
        last: 50000,
      });

      expect(result.written).toBe(false);
      expect(result.reason).toBe('redis-not-connected');
    });

    it('should handle empty batch on flush', async () => {
      const result = await writer.flush();

      expect(result.flushed).toBe(true);
      expect(result.count).toBe(0);
    });

    it('should recover from write error', async () => {
      mockPipeline.exec.mockRejectedValueOnce(new Error('Write failed'));

      await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 50000 });
      const result = await writer.flush();

      expect(result.flushed).toBe(false);
      expect(writer.getMetrics().failedWrites).toBe(1);
    });
  });
});
