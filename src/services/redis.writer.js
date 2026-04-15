/**
 * RedisWriter - Centralized Redis Write Path
 *
 * Encapsulates all Redis operations:
 * - Ticker persistence (hash storage)
 * - Pub/sub publishing
 * - Deduplication (skip writes for unchanged data)
 * - Rate limiting per symbol
 * - Pipeline batching
 *
 * This is the ONLY place where tickers are written to Redis.
 *
 * Usage:
 *   const writer = new RedisWriter(redisService, config);
 *   const {written} = await writer.writeTicker('binance', 'spot', 'BTC/USDT', tickerData);
 *   await writer.flush();
 *   await writer.disconnect();
 */

const crypto = require('crypto');

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
   */
  async writeTicker(exchange, marketType, symbol, tickerData) {
    if (!this.redisService.isReady()) {
      this.config.logger('warn', `RedisWriter: Redis not connected, skipping write`, {
        symbol,
      });
      return { written: false, reason: 'redis-not-connected' };
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
        this.batchTimer = setTimeout(() => this.flush(), this.config.redisFlushMs);
      }

      return { written: true, batched: true };
    } else {
      // Write immediately (no batching)
      return await this._writeUpdate(update);
    }
  }

  /**
   * Write a single update immediately
   */
  async _writeUpdate(update) {
    try {
      const pipeline = this.redisService.createPipeline();
      pipeline.hset(update.key, update.field, update.value);
      pipeline.publish(update.pubsubChannel, update.value);
      await this.redisService.execPipeline(pipeline);

      this.config.logger('debug', `RedisWriter: Update written`, {
        symbol: update.field,
        key: update.key,
      });

      return { written: true, batched: false };
    } catch (error) {
      this.metrics.failedWrites++;
      this.config.logger('error', `RedisWriter: Write failed`, {
        error: error.message,
      });
      return { written: false, reason: 'write-error', error: error.message };
    }
  }

  /**
   * Flush batched updates
   */
  async flush() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.batch.size === 0) {
      return { flushed: true, count: 0 };
    }

    try {
      this.config.logger('debug', `RedisWriter: Flushing batch`, {
        count: this.batch.size,
      });

      const pipeline = this.redisService.createPipeline();

      const updates = Array.from(this.batch.values());
      // Add all writes to pipeline
      for (const update of updates) {
        pipeline.hset(update.key, update.field, update.value);
        pipeline.publish(update.pubsubChannel, update.value);
      }

      // Execute atomically
      const result = await this.redisService.execPipeline(pipeline);

      if (result && result.length > 0) {
        this.metrics.flushedBatches++;
        this.metrics.queuedUpdates = 0;
        this.metrics.lastFlushAt = Date.now();

        const flushCount = this.batch.size;
        this.batch.clear();

        this.config.logger('info', `RedisWriter: Batch flushed`, {
          updates: flushCount,
          pipelineCommands: result.length,
        });

        return { flushed: true, count: flushCount };
      }

      return { flushed: false, reason: 'empty-result' };
    } catch (error) {
      this.metrics.failedWrites++;
      this.config.logger('error', `RedisWriter: Flush failed`, {
        error: error.message,
        batchSize: this.batch.size,
      });
      return { flushed: false, reason: 'flush-error', error: error.message };
    }
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
