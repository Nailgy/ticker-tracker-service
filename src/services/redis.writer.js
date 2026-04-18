/**
 * RedisWriter - Centralized Redis Write Path
 *
 * Encapsulates all Redis operations:
 * - Ticker persistence (hash storage)
 * - Pub/sub publishing
 * - Deduplication (skip writes for unchanged data)
 * - Rate limiting per symbol
 * - Pipeline batching with single-flight concurrency guard (Phase 5C)
 * - Typed error propagation (Phase 5A+5B)
 * - Symbol cache cleanup (Phase 5D)
 *
 * This is the ONLY place where tickers are written to Redis.
 * Single authority for all write semantics.
 *
 * Usage:
 *   const writer = new RedisWriter(redisService, config);
 *   try {
 *     await writer.writeTicker('binance', 'spot', 'BTC/USDT', tickerData);
 *   } catch (error) {
 *     if (error instanceof RedisWriteError) { ... }
 *   }
 *   await writer.flush();
 *   await writer.disconnect();
 */

const crypto = require('crypto');

/**
 * Typed error for write failures (Phase 5A)
 * @example
 * throw new RedisWriteError('Redis not connected', 'redis-not-connected')
 */
class RedisWriteError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'RedisWriteError';
    this.reason = reason;
  }
}

/**
 * Typed error for flush failures (Phase 5B)
 * @example
 * throw new RedisFlushError('Pipeline partial failure: 2/10', 2)
 */
class RedisFlushError extends Error {
  constructor(message, failedCount) {
    super(message);
    this.name = 'RedisFlushError';
    this.failedCount = failedCount;
  }
}

class RedisWriter {
  constructor(redisService, config = {}) {
    this.redisService = redisService;
    this.config = {
      redisBatching: config.redisBatching !== false,
      redisFlushMs: config.redisFlushMs || 1000,
      redisMaxBatch: config.redisMaxBatch || 1000,
      redisOnlyOnChange: config.redisOnlyOnChange !== false,
      redisMinIntervalMs: config.redisMinIntervalMs || 0,
      logger: config.logger || this._defaultLogger,
    };

    // Dedup cache
    this.dedupCache = new Map(); // Map<symbol, {hash, lastWriteTime}>

    // Batching state (State-Collapsing Queue: only latest value per symbol!)
    this.batch = new Map(); // Map<symbol, update>
    this.batchTimer = null;

    // Phase 5C: Single-flight flush guard
    this.flushPromise = null;

    // Metrics
    this.metrics = {
      totalWrites: 0,
      dedupedWrites: 0,
      flushedBatches: 0,
      failedWrites: 0,
      queuedUpdates: 0,
      lastFlushAt: null,
    };
  }

  /**
   * Default logger
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[RedisWriter:${level.toUpperCase()}] ${message}`, data || '');
  }

  /**
   * Write a ticker update
   * Phase 5A: Now throws typed errors instead of returning status dict
   */
  async writeTicker(exchange, marketType, symbol, tickerData) {
    // Phase 5A: Throw instead of return false
    if (!this.redisService.isReady()) {
      this.metrics.failedWrites++;
      this.config.logger('error', `RedisWriter: Redis not connected`, { symbol });
      throw new RedisWriteError('Redis not connected', 'redis-not-connected');
    }

    this.metrics.totalWrites++;

    const key = `ticker:${exchange}:${marketType}`;
    const tickerHash = this._hashData(tickerData);

    // Check deduplication
    const cached = this.dedupCache.get(symbol);
    const hasChanged = !cached || cached.hash !== tickerHash;

    if (!hasChanged) {
      this.metrics.dedupedWrites++;
      this.config.logger('debug', `RedisWriter: Update deduped (no change)`, { symbol });
      return { written: false, reason: 'deduped' };
    }

    // Check rate limit
    if (this.config.redisMinIntervalMs > 0 && cached) {
      const timeSinceLastWrite = Date.now() - cached.lastWriteTime;
      if (timeSinceLastWrite < this.config.redisMinIntervalMs) {
        this.metrics.dedupedWrites++;
        this.config.logger('debug', `RedisWriter: Update rate-limited`, { symbol });
        return { written: false, reason: 'rate-limited' };
      }
    }

    // Update dedup cache
    this.dedupCache.set(symbol, {
      hash: tickerHash,
      lastWriteTime: Date.now(),
    });

    // Format update
    const update = {
      key,
      field: symbol,
      value: JSON.stringify(tickerData),
      pubsubChannel: `${key}:${symbol}`,
    };

    // Queue or write immediately
    if (this.config.redisBatching) {
      this.batch.set(symbol, update);
      this.metrics.queuedUpdates = this.batch.size;

      // Force flush if batch is full
      if (this.batch.size >= this.config.redisMaxBatch) {
        return await this.flush();
      }

      // Start batch timer if not already running
      if (!this.batchTimer && this.config.redisFlushMs > 0) {
        this.batchTimer = setTimeout(async () => {
          try {
            await this.flush();
          } catch (error) {
            // Error already logged in flush(), don't double-log
          }
        }, this.config.redisFlushMs);
      }

      return { written: true, batched: true };
    } else {
      // Write immediately (no batching)
      return await this._writeUpdate(update);
    }
  }

  /**
   * Write a single update immediately
   * Phase 5A: Now throws typed errors instead of returning status
   * BLOCKING FIX: Validate tuple errors in pipeline result (not just thrown exceptions)
   */
  async _writeUpdate(update) {
    try {
      const pipeline = this.redisService.createPipeline();
      pipeline.hset(update.key, update.field, update.value);
      pipeline.publish(update.pubsubChannel, update.value);
      const result = await this.redisService.execPipeline(pipeline);

      // BLOCKING FIX: Validate tuple errors - don't assume success on non-thrown result
      const failed = result.filter(([err]) => err != null);
      if (failed.length > 0) {
        this.metrics.failedWrites++;
        const errorMsg = failed[0][0].message || 'Unknown error';
        throw new RedisWriteError(
          `Redis tuple error: ${errorMsg}`,
          'tuple-error'
        );
      }

      this.config.logger('debug', `RedisWriter: Update written`, {
        symbol: update.field,
        key: update.key,
      });

      return { written: true, batched: false };
    } catch (error) {
      // Phase 5A: Throw instead of return
      if (error instanceof RedisWriteError) {
        // Already counted in tuple error detection, don't double-count
        throw error;
      }
      this.metrics.failedWrites++;
      this.config.logger('error', `RedisWriter: Write failed`, {
        error: error.message,
      });
      throw new RedisWriteError(error.message, 'write-error');
    }
  }

  /**
   * Flush batched updates
   * Phase 5B: Validates each pipeline result tuple and requeues on failure
   * Phase 5C: Single-flight pattern with copy-swap semantics
   * BLOCKING FIX: Requeue on thrown execPipeline(), not just validation failure
   */
  async flush() {
    // Clear batch timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Phase 5C: Early return if already flushing (coalesce)
    if (this.flushPromise) {
      return this.flushPromise;
    }

    if (this.batch.size === 0) {
      return { flushed: true, count: 0 };
    }

    // Phase 5C: Set promise BEFORE executing (single-flight)
    this.flushPromise = (async () => {
      // CRITICAL FIX: Copy updates AND clear batch immediately
      // This prevents new writes (arriving during execPipeline) from being lost
      const updates = Array.from(this.batch.values());
      this.batch.clear();

      try {
        this.config.logger('debug', `RedisWriter: Flushing batch`, {
          count: updates.length,
        });

        const pipeline = this.redisService.createPipeline();

        // Add all writes to pipeline
        for (const update of updates) {
          pipeline.hset(update.key, update.field, update.value);
          pipeline.publish(update.pubsubChannel, update.value);
        }

        // Execute atomically
        const result = await this.redisService.execPipeline(pipeline);

        // Phase 5B: Validate each result tuple - ioredis returns [[err, res], [err, res], ...]
        const failed = result.filter(([err]) => err != null);
        if (failed.length > 0) {
          // Validation failure: requeue updates, but ONLY if not already superseded
          // by newer writes that arrived during the flush
          for (const u of updates) {
            if (!this.batch.has(u.field)) {
              this.batch.set(u.field, u);
            }
          }
          this.metrics.failedWrites++;
          this.config.logger('error', `RedisWriter: Flush partial failure`, {
            failed: failed.length,
            total: result.length,
          });
          throw new RedisFlushError(
            `Redis pipeline partial failure: ${failed.length}/${result.length} commands failed`,
            failed.length
          );
        }

        // Batch already cleared at top of try block on success
        // All succeeded
        this.metrics.flushedBatches++;
        this.metrics.queuedUpdates = this.batch.size;  // Account for writes that arrived during flush
        this.metrics.lastFlushAt = Date.now();

        this.config.logger('info', `RedisWriter: Batch flushed`, {
          updates: updates.length,
          pipelineCommands: result.length,
        });

        return { flushed: true, count: updates.length };
      } catch (error) {
        // CRITICAL FIX: On ANY error, requeue updates but ONLY if not already updated
        // This prevents stale data from overwriting fresh writes that arrived during flush
        for (const u of updates) {
          if (!this.batch.has(u.field)) {
            this.batch.set(u.field, u);
          }
        }
        // CRITICAL FIX: Don't double-count metrics if this is already a typed error
        if (!(error instanceof RedisFlushError)) {
          this.metrics.failedWrites++;
        }
        this.config.logger('error', `RedisWriter: Flush failed - requeued updates`, {
          error: error.message,
          requeuedCount: updates.length,
        });
        throw error;
      }
    })().finally(() => {
      // Phase 5C: Release lock after success or failure
      this.flushPromise = null;
    });

    return this.flushPromise;
  }

  /**
   * Remove symbols from dedup cache and pending batch
   * Phase 5D: Called when symbols are delisted/removed from tracking
   */
  removeSymbols(symbols) {
    const removed = [];
    for (const symbol of symbols) {
      if (this.dedupCache.delete(symbol)) {
        removed.push(symbol);
      }
      // Also remove from pending batch (state-collapsing queue)
      if (this.batch.delete(symbol)) {
        removed.push(symbol);
      }
    }

    if (removed.length > 0) {
      this.metrics.queuedUpdates = this.batch.size;
      this.config.logger('info', `RedisWriter: Cleaned symbols from cache/batch`, {
        removed: removed.length,
        cacheSize: this.dedupCache.size,
        batchSize: this.batch.size,
      });
    }

    return {
      removed,
      cacheSize: this.dedupCache.size,
      batchSize: this.batch.size,
    };
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    try {
      // Flush any pending updates
      if (this.batch.size > 0) {
        await this.flush();
      }

      // Close batch timer
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
        this.batchTimer = null;
      }

      this.config.logger('info', `RedisWriter: Disconnected`);
      return { disconnected: true };
    } catch (error) {
      this.config.logger('error', `RedisWriter: Disconnect failed`, {
        error: error.message,
      });
      return { disconnected: false, error: error.message };
    }
  }

  /**
   * Hash ticker data for deduplication
   */
  _hashData(data) {
    const str = JSON.stringify(data);
    return crypto.createHash('md5').update(str).digest('hex');
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return { ...this.metrics };
  }
}

module.exports = RedisWriter;
module.exports.RedisWriteError = RedisWriteError;
module.exports.RedisFlushError = RedisFlushError;
