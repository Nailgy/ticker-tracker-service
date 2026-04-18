/**
 * Stage 5: Redis Write-Path Failures - Integration Tests
 *
 * Comprehensive tests for Phase 5 Redis failure handling:
 * 5A - Silent Redis failure path → throws typed errors
 * 5B - Pipeline partial errors → requeues updates atomically
 * 5C - No flush concurrency guard → single-flight coalesces concurrent calls
 * 5D - Dedup cache cleanup missing → removeSymbols() prunes cache
 * 5F - Missing acceptance evidence → proves all failure modes handled
 *
 * These tests validate that Redis failures are handled correctly
 * and don't cause persistent state inconsistency.
 */

const RedisWriter = require('../../src/services/redis.writer');
const { RedisWriteError, RedisFlushError } = require('../../src/services/redis.writer');

describe('Stage 5: Redis Write-Path Failures', () => {
  let redisWriter;
  let mockRedisService;
  let mockPipeline;
  let mockLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = jest.fn();

    // Setup mock pipeline with proper [err, res] tuple format
    mockPipeline = {
      hset: jest.fn().mockReturnThis(),
      publish: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 1], [null, 1]]),
    };

    mockRedisService = {
      isConnected: true,
      isReady: jest.fn(function() { return this.isConnected; }),
      createPipeline: jest.fn().mockReturnValue(mockPipeline),
      execPipeline: jest.fn().mockImplementation((pipeline) => pipeline.exec()),
    };

    redisWriter = new RedisWriter(mockRedisService, { logger: mockLogger });
  });

  // ============================================================================
  // 5A: Silent Redis Failure Path - writeTicker throws typed errors
  // ============================================================================
  describe('5A: Redis Connection Failure → Typed Error Thrown', () => {
    it('should throw RedisWriteError when Redis not connected', async () => {
      mockRedisService.isConnected = false;

      await expect(
        redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 })
      ).rejects.toThrow(RedisWriteError);

      const error = new RedisWriteError('', '');
      await expect(
        redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 })
      ).rejects.toThrow(expect.objectContaining({
        name: 'RedisWriteError',
        reason: 'redis-not-connected',
      }));
    });

    it('should increment failedWrites metric on connection failure', async () => {
      mockRedisService.isConnected = false;

      try {
        await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      } catch (error) {
        // Expected
      }

      expect(redisWriter.getMetrics().failedWrites).toBe(1);
    });

    it('should propagate write errors to caller', async () => {
      mockPipeline.exec.mockRejectedValueOnce(new Error('Connection refused'));

      const writer = new RedisWriter(mockRedisService, { redisBatching: false });

      await expect(
        writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 })
      ).rejects.toThrow(RedisWriteError);
    });
  });

  // ============================================================================
  // 5B: Pipeline Partial Errors - Validates tuples and requeues atomically
  // ============================================================================
  describe('5B: Pipeline Partial Failure → Requeue & Throw Error', () => {
    it('should throw RedisFlushError on partial pipeline failure', async () => {
      // Mock pipeline with one error, one success: [[error, null], [null, success]]
      mockPipeline.exec.mockResolvedValueOnce([
        [new Error('Write failed'), null],  // Error in first command
        [null, 1],                           // Success in second
      ]);

      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      await expect(redisWriter.flush()).rejects.toThrow(RedisFlushError);
    });

    it('should requeue failed updates back to batch', async () => {
      mockPipeline.exec.mockResolvedValueOnce([
        [new Error('Write failed'), null],
        [null, 1],
      ]);

      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      try {
        await redisWriter.flush();
      } catch (error) {
        // Expected
      }

      // Verify update was put back in batch
      expect(redisWriter.batch.size).toBeGreaterThan(0);
    });

    it('should preserve failedCount in error for debugging', async () => {
      mockPipeline.exec.mockResolvedValueOnce([
        [new Error('Write failed'), null],
        [new Error('Publish failed'), null],
        [null, 1],
      ]);

      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      await redisWriter.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });

      try {
        await redisWriter.flush();
      } catch (error) {
        expect(error).toBeInstanceOf(RedisFlushError);
        expect(error.failedCount).toBe(2);
      }
    });
  });

  // ============================================================================
  // 5C: Flush Concurrency Guard - Single-flight pattern coalesces calls
  // ============================================================================
  describe('5C: Concurrent Flush Calls → Single-Flight Coalesced', () => {
    it('should coalesce concurrent flush calls into one execution', async () => {
      // Mock slow pipeline (100ms)
      mockPipeline.exec.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve([[null, 1], [null, 1]]), 100))
      );

      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      // Call flush 5 times concurrently
      const promises = Array(5).fill().map(() => redisWriter.flush());
      await Promise.all(promises);

      // Pipeline.exec should be called exactly ONCE, not 5 times
      expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
    });

    it('should handle concurrent flush calls with single execution', async () => {
      mockPipeline.exec.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve([[null, 1]]), 50))
      );

      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      // Call flush 3 times rapidly
      const promises = [
        redisWriter.flush(),
        redisWriter.flush(),
        redisWriter.flush(),
      ];

      // All should resolve successfully
      const results = await Promise.all(promises);

      // All should show flushed successfully
      results.forEach(result => {
        expect(result.flushed).toBe(true);
      });

      // But exec should only be called once
      expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
    });

    it('should prevent duplicate writes under concurrent flush', async () => {
      const hsetCalls = [];

      mockPipeline.hset.mockImplementation(function(key, field, value) {
        hsetCalls.push({ key, field });
        return this;
      });

      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      // Concurrent flushes
      const promises = Array(3).fill().map(() => redisWriter.flush());
      await Promise.all(promises);

      // Should be called only once per symbol
      const btcCalls = hsetCalls.filter(c => c.field === 'BTC/USDT');
      expect(btcCalls.length).toBe(1);
    });
  });

  // ============================================================================
  // 5D: Dedup Cache Cleanup - removeSymbols prunes cache and batch
  // ============================================================================
  describe('5D: Symbol Removal → Cache Cleaned Up', () => {
    it('should remove symbols from dedup cache', async () => {
      // Populate cache
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      await redisWriter.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });
      await redisWriter.writeTicker('binance', 'spot', 'LTC/USDT', { last: 200 });

      expect(redisWriter.dedupCache.size).toBe(3);

      // Remove two symbols
      const result = redisWriter.removeSymbols(['BTC/USDT', 'ETH/USDT']);

      expect(result.removed.length).toBeGreaterThan(0);
      expect(redisWriter.dedupCache.size).toBe(1);  // Only LTC remains
      expect(redisWriter.dedupCache.has('BTC/USDT')).toBe(false);
      expect(redisWriter.dedupCache.has('ETH/USDT')).toBe(false);
      expect(redisWriter.dedupCache.has('LTC/USDT')).toBe(true);
    });

    it('should remove symbols from pending batch', async () => {
      // Queue writes (but don't flush)
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      await redisWriter.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });

      expect(redisWriter.batch.size).toBe(2);

      // Remove symbols
      redisWriter.removeSymbols(['BTC/USDT']);

      expect(redisWriter.batch.size).toBe(1);
      expect(redisWriter.batch.has('BTC/USDT')).toBe(false);
      expect(redisWriter.batch.has('ETH/USDT')).toBe(true);
    });

    it('should report accurate cache/batch sizes after cleanup', async () => {
      // Populate
      await redisWriter.writeTicker('binance', 'spot', 'COIN1/USDT', { last: 1 });
      await redisWriter.writeTicker('binance', 'spot', 'COIN2/USDT', { last: 2 });
      await redisWriter.writeTicker('binance', 'spot', 'COIN3/USDT', { last: 3 });

      const before = {
        cacheSize: redisWriter.dedupCache.size,
        batchSize: redisWriter.batch.size,
      };

      // Remove
      const result = redisWriter.removeSymbols(['COIN1/USDT', 'COIN2/USDT']);

      expect(result.cacheSize).toBeLessThan(before.cacheSize);
      expect(result.batchSize).toBeLessThan(before.batchSize);
    });

    it('should prevent unbounded memory growth under symbol churn', async () => {
      // Simulate symbol churn: add 100 symbols, remove 50, add 50, etc.
      const initialMemory = redisWriter.dedupCache.size;

      for (let cycle = 0; cycle < 5; cycle++) {
        // Add new symbols
        for (let i = 0; i < 10; i++) {
          await redisWriter.writeTicker('binance', 'spot', `SYM${cycle}_${i}/USDT`, {
            last: Math.random() * 1000,
          });
        }

        const afterAdd = redisWriter.dedupCache.size;

        // Remove half of them
        const toRemove = [];
        for (let i = 0; i < 5; i++) {
          toRemove.push(`SYM${cycle}_${i}/USDT`);
        }
        redisWriter.removeSymbols(toRemove);

        const afterRemove = redisWriter.dedupCache.size;

        // Verify cache didn't grow unbounded
        expect(afterRemove).toBeLessThanOrEqual(afterAdd);
      }

      // Final cache should be bounded
      expect(redisWriter.dedupCache.size).toBeLessThan(100);
    });
  });

  // ============================================================================
  // BLOCKING FIX TEST: Full pipeline throw in flush() requeues all updates
  // ============================================================================
  describe('BLOCKING FIX: Full pipeline exception → requeue all updates', () => {
    it('should requeue all updates on full execPipeline() throw', async () => {
      // Queue 3 updates
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      await redisWriter.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });
      await redisWriter.writeTicker('binance', 'spot', 'LTC/USDT', { last: 200 });

      expect(redisWriter.batch.size).toBe(3);

      // Mock execPipeline to throw (network down, timeout, etc)
      mockPipeline.exec.mockRejectedValueOnce(new Error('Network timeout'));

      // Flush should throw
      await expect(redisWriter.flush()).rejects.toThrow();

      // CRITICAL: All 3 updates should be requeued (NOT lost)
      expect(redisWriter.batch.size).toBe(3);
      expect(redisWriter.batch.has('BTC/USDT')).toBe(true);
      expect(redisWriter.batch.has('ETH/USDT')).toBe(true);
      expect(redisWriter.batch.has('LTC/USDT')).toBe(true);
    });

    it('should prevent data loss even with slow network', async () => {
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      // Mock execPipeline to timeout
      mockPipeline.exec.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('ECONNRESET')), 50))
      );

      // Attempt flush
      try {
        await redisWriter.flush();
      } catch (error) {
        // Expected
      }

      // Verify update is still in batch (requeued)
      expect(redisWriter.batch.size).toBe(1);
      expect(redisWriter.batch.has('BTC/USDT')).toBe(true);
    });

    it('should track failed flushes in metrics', async () => {
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      mockPipeline.exec.mockRejectedValueOnce(new Error('Redis down'));

      try {
        await redisWriter.flush();
      } catch (error) {
        // Expected
      }

      expect(redisWriter.getMetrics().failedWrites).toBe(1);
      expect(redisWriter.getMetrics().flushedBatches).toBe(0);  // No successful flush
    });
  });

  // ============================================================================
  // BLOCKING FIX TEST: _writeUpdate() validates tuple errors (non-batched)
  // ============================================================================
  describe('BLOCKING FIX: Non-batched write validates tuple errors', () => {
    it('should throw error on tuple error in _writeUpdate', async () => {
      const writer = new RedisWriter(mockRedisService, { redisBatching: false });

      // Mock tuple error: hset returns error, publish succeeds
      mockPipeline.exec.mockResolvedValueOnce([
        [new Error('READONLY'), null],  // hset failed
        [null, 1],                       // publish succeeded
      ]);

      // Should throw because tuple error detected
      await expect(
        writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 })
      ).rejects.toThrow(RedisWriteError);
    });

    it('should throw with reason tuple-error when tuple fails in non-batched', async () => {
      const writer = new RedisWriter(mockRedisService, { redisBatching: false });

      mockPipeline.exec.mockResolvedValueOnce([
        [new Error('WRONDTYPE'), null],  // Wrong type error
        [null, 1],
      ]);

      try {
        await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      } catch (error) {
        expect(error).toBeInstanceOf(RedisWriteError);
        expect(error.reason).toBe('tuple-error');
      }
    });

    it('should increment failedWrites on tuple error', async () => {
      const writer = new RedisWriter(mockRedisService, { redisBatching: false });

      mockPipeline.exec.mockResolvedValueOnce([
        [new Error('Tuple error'), null],
        [null, 1],
      ]);

      try {
        await writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      } catch (error) {
        // Expected
      }

      expect(writer.getMetrics().failedWrites).toBe(1);
    });

    it('should not treat publish-only error as success', async () => {
      const writer = new RedisWriter(mockRedisService, { redisBatching: false });

      // hset succeeds but publish fails
      mockPipeline.exec.mockResolvedValueOnce([
        [null, 1],                    // hset succeeded
        [new Error('Channel error'), null],  // publish failed
      ]);

      // Should throw because second command failed
      await expect(
        writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 })
      ).rejects.toThrow(RedisWriteError);
    });
  });

  // ============================================================================
  // Recovery & Consistency Tests
  // ============================================================================
  describe('Recovery & Consistency', () => {
    it('should recover from transient Redis connection loss', async () => {
      // First write fails (disconnected)
      mockRedisService.isConnected = false;

      await expect(
        redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 })
      ).rejects.toThrow(RedisWriteError);

      // Redis reconnects
      mockRedisService.isConnected = true;
      mockPipeline.exec.mockResolvedValueOnce([[null, 1], [null, 1]]);

      // Retry succeeds
      const result = await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      expect(result.written).toBe(true);
    });

    it('should handle mixed success/failure in batch', async () => {
      // Queue 3 writes
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      await redisWriter.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });
      await redisWriter.writeTicker('binance', 'spot', 'LTC/USDT', { last: 200 });

      // Pipeline fails on first two, succeeds on last
      mockPipeline.exec.mockResolvedValueOnce([
        [new Error('Fail1'), null],
        [new Error('Fail2'), null],
        [new Error('Fail3'), null],
        [new Error('Fail4'), null],  // publish also fails
        [null, 1],                    // Only last publish succeeds
        [null, 1],
      ]);

      // Flush should fail
      await expect(redisWriter.flush()).rejects.toThrow(RedisFlushError);

      // But all 3 updates should be requeued
      expect(redisWriter.batch.size).toBe(3);
    });

    it('should maintain cache consistency across error scenarios', async () => {
      // Setup initial state
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      // Error during first flush
      mockPipeline.exec.mockRejectedValueOnce(new Error('Redis down'));

      try {
        await redisWriter.flush();
      } catch (error) {
        // Expected
      }

      // Cache should still have the update
      expect(redisWriter.dedupCache.has('BTC/USDT')).toBe(true);

      // Simulate removal (e.g., symbol delisted)
      redisWriter.removeSymbols(['BTC/USDT']);

      // Cache should be cleaned
      expect(redisWriter.dedupCache.has('BTC/USDT')).toBe(false);

      // Retry with same symbol (now it won't be cached)
      mockPipeline.exec.mockResolvedValueOnce([[null, 1], [null, 1]]);
      const result = await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 200 });

      // Should write because it's not in cache anymore
      expect(result.written).toBe(true);
    });
  });

  // ============================================================================
  // CRITICAL FIX: Write During In-Flight Flush (Race Condition Tests)
  // ============================================================================
  describe('CRITICAL: Write During In-Flight Flush (Race Conditions)', () => {
    it('should NOT lose new writes that arrive during successful flush', async () => {
      // Queue initial write
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      expect(redisWriter.batch.size).toBe(1);

      // Mock slow pipeline (100ms) to allow new writes during flush
      let pipelineExecuting = false;
      mockPipeline.exec.mockImplementation(async () => {
        pipelineExecuting = true;
        await new Promise(resolve => setTimeout(resolve, 50));
        pipelineExecuting = false;
        return [[null, 1], [null, 1]];
      });

      // Start flush but don't await yet
      const flushPromise = redisWriter.flush();

      // Wait a tiny bit for flush to start
      await new Promise(resolve => setTimeout(resolve, 10));

      // While flush is in-flight, new write arrives (simulate new ticker)
      expect(pipelineExecuting).toBe(true);
      await redisWriter.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });

      // Wait for flush to complete
      await flushPromise;

      // CRITICAL: ETH update should NOT be lost - it should still be in batch
      expect(redisWriter.batch.size).toBe(1);
      expect(redisWriter.batch.has('ETH/USDT')).toBe(true);
    });

    it('should NOT overwrite fresh writes with stale data on flush failure', async () => {
      // Queue initial write for BTC
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });
      expect(redisWriter.batch.size).toBe(1);

      // Mock slow pipeline that will fail
      let pipelineExecuting = false;
      mockPipeline.exec.mockImplementation(async () => {
        pipelineExecuting = true;
        await new Promise(resolve => setTimeout(resolve, 50));
        pipelineExecuting = false;
        throw new Error('Network timeout');
      });

      // Start flush but don't await
      const flushPromise = redisWriter.flush();

      // Wait for flush to start
      await new Promise(resolve => setTimeout(resolve, 10));

      // While flush is in-flight with BTC=100, new FRESHER update arrives
      expect(pipelineExecuting).toBe(true);
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 105 });

      // Wait for flush to fail
      try {
        await flushPromise;
      } catch (error) {
        // Expected
      }

      // CRITICAL: BTC update should have the NEWER value (105), not the stale (100)
      expect(redisWriter.batch.has('BTC/USDT')).toBe(true);
      const requeuedUpdate = Array.from(redisWriter.batch.values()).find(
        u => u.field === 'BTC/USDT'
      );
      const requeuedData = JSON.parse(requeuedUpdate.value);
      expect(requeuedData.last).toBe(105);  // Newer value, not 100
    });

    it('should NOT overwrite fresh writes with stale data on partial failure', async () => {
      // Queue initial write for BTC
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      // Mock partial failure (tuple error on first command)
      let pipelineExecuting = false;
      mockPipeline.exec.mockImplementation(async () => {
        pipelineExecuting = true;
        await new Promise(resolve => setTimeout(resolve, 50));
        pipelineExecuting = false;
        return [
          [new Error('READONLY'), null],  // hset failed
          [null, 1],                       // publish succeeded
        ];
      });

      // Start flush
      const flushPromise = redisWriter.flush();

      // Wait for flush to start
      await new Promise(resolve => setTimeout(resolve, 10));

      // While flush is in-flight with BTC=100, fresher update arrives
      expect(pipelineExecuting).toBe(true);
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 105 });

      // Wait for flush to fail with partial error
      try {
        await flushPromise;
      } catch (error) {
        expect(error).toBeInstanceOf(RedisFlushError);
      }

      // CRITICAL: Should have the NEWER value in requeue, not the stale one
      const requeuedUpdate = Array.from(redisWriter.batch.values()).find(
        u => u.field === 'BTC/USDT'
      );
      const requeuedData = JSON.parse(requeuedUpdate.value);
      expect(requeuedData.last).toBe(105);
    });

    it('should correctly count failedWrites without double-counting on partial failure', async () => {
      // Queue write
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      // Mock partial failure
      mockPipeline.exec.mockResolvedValueOnce([
        [new Error('Fail1'), null],
        [new Error('Fail2'), null],
      ]);

      try {
        await redisWriter.flush();
      } catch (error) {
        // Expected
      }

      // CRITICAL: failedWrites should be incremented ONCE, not twice
      expect(redisWriter.getMetrics().failedWrites).toBe(1);
    });

    it('should correctly count failedWrites when execPipeline throws', async () => {
      // Queue write
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      // Mock thrown error
      mockPipeline.exec.mockRejectedValueOnce(new Error('Connection refused'));

      try {
        await redisWriter.flush();
      } catch (error) {
        // Expected
      }

      // CRITICAL: failedWrites should be incremented ONCE
      expect(redisWriter.getMetrics().failedWrites).toBe(1);
    });

    it('should accurately report queuedUpdates after flush with in-flight writes', async () => {
      // Queue initial write
      await redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 });

      // Mock slow pipeline
      let pipelineExecuting = false;
      mockPipeline.exec.mockImplementation(async () => {
        pipelineExecuting = true;
        await new Promise(resolve => setTimeout(resolve, 50));
        pipelineExecuting = false;
        return [[null, 1], [null, 1]];
      });

      // Start flush
      const flushPromise = redisWriter.flush();

      // Wait for flush to start
      await new Promise(resolve => setTimeout(resolve, 10));

      // While flush in-flight, 2 new writes arrive
      expect(pipelineExecuting).toBe(true);
      await redisWriter.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 });
      await redisWriter.writeTicker('binance', 'spot', 'LTC/USDT', { last: 200 });

      // Wait for flush to complete
      await flushPromise;

      // queuedUpdates should reflect the 2 new writes that arrived during flush
      const metrics = redisWriter.getMetrics();
      expect(metrics.queuedUpdates).toBe(2);
    });
  });
});
