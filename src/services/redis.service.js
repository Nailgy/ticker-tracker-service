/**
 * RedisService - Redis Persistence Layer
 *
 * Manages all Redis interactions:
 * - Connection pooling with ioredis
 * - In-memory deduplication cache (prevents redundant writes)
 * - Pipeline batching (accumulates updates, flushes periodically)
 * - Pub/sub for real-time ticker updates
 * - Connection health monitoring
 *
 * Usage:
 *   const redis = new RedisService(config);
 *   await redis.connect();
 *   await redis.updateTicker('binance', 'spot', 'BTC/USDT', tickerData);
 *   await redis.disconnect();
 */

const Redis = require('ioredis');
const crypto = require('crypto');

class RedisService {
  /**
   * Initialize RedisService
   * @param {Object} config - Configuration object
   * @param {string} config.redisUrl - Redis connection URL
   * @param {boolean} config.redisBatching - Enable batched writes
   * @param {number} config.redisFlushMs - Flush interval in ms
   * @param {number} config.redisMaxBatch - Max updates before forced flush
   * @param {boolean} config.redisOnlyOnChange - Only write if changed
   * @param {number} config.redisMinIntervalMs - Min interval between writes per symbol
   * @param {Function} config.logger - Logger function
   */
  constructor(config = {}) {
    this.config = {
      redisUrl: config.redisUrl || 'localhost:6379',
      redisBatching: config.redisBatching !== false,
      redisFlushMs: config.redisFlushMs || 1000,
      redisMaxBatch: config.redisMaxBatch || 1000,
      redisOnlyOnChange: config.redisOnlyOnChange !== false,
      redisMinIntervalMs: config.redisMinIntervalMs || 0,
      logger: config.logger || this._defaultLogger,
    };

    // Connection state
    this.redis = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;

    // Batching state
    this.batch = [];
    this.batchTimer = null;
    this.isFlushing = false;

    // Deduplication cache: Map<symbol, {hash, lastWriteTime}>
    this.dedupCache = new Map();

    // Metrics
    this.stats = {
      totalUpdates: 0,
      dedupedUpdates: 0,
      batchedUpdates: 0,
      flushedBatches: 0,
      failedWrites: 0,
    };
  }

  /**
   * Default logger (no-op)
   * @private
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    const prefix = `[RedisService:${level.toUpperCase()}]`;
    console.log(prefix, message, data ? JSON.stringify(data, null, 2) : '');
  }

  /**
   * Connect to Redis
   * @returns {Promise<void>}
   * @throws {Error} If connection fails after max retries
   */
  async connect() {
    if (this.isConnected) return;
    if (this.isConnecting) return;

    this.isConnecting = true;

    try {
      this.redis = new Redis(this.config.redisUrl, {
        retryStrategy: (times) => {
          if (times > this.maxReconnectAttempts) {
            this.config.logger('error', `Redis: Max reconnection attempts (${this.maxReconnectAttempts}) exceeded`);
            return null; // Stop retrying
          }
          const delay = Math.min(times * 50, 2000); // Exponential backoff, max 2s
          this.config.logger('warn', `Redis: Reconnecting attempt ${times}, delay ${delay}ms`);
          return delay;
        },
      });

      // Setup event handlers
      this.redis.on('connect', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.config.logger('info', 'Redis: Connected successfully');
      });

      this.redis.on('error', (error) => {
        this.config.logger('error', 'Redis: Client error', { message: error.message });
      });

      this.redis.on('close', () => {
        this.isConnected = false;
        this.config.logger('warn', 'Redis: Connection closed');
      });

      // Test connection with a PING
      await this.redis.ping();
      this.isConnected = true;
      this.isConnecting = false;

      this.config.logger('info', 'Redis: Connection established and tested');

      // Start batch flush timer if batching enabled
      if (this.config.redisBatching) {
        this._startBatchTimer();
      }
    } catch (error) {
      this.isConnecting = false;
      this.config.logger('error', 'Redis: Connection failed', { message: error.message });
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   * @returns {Promise<void>}
   */
  async disconnect() {
    // Flush any pending updates
    if (this.batch.length > 0) {
      await this.flush();
    }

    // Stop batch timer
    this._stopBatchTimer();

    // Close Redis connection
    if (this.redis) {
      await this.redis.quit();
      this.isConnected = false;
      this.config.logger('info', 'Redis: Disconnected');
    }
  }

  /**
   * Update a ticker value (adds to batch or writes immediately)
   * @param {string} exchange - Exchange name
   * @param {string} marketType - Market type (spot/swap)
   * @param {string} symbol - Trading symbol
   * @param {Object} tickerData - Normalized ticker data
   * @returns {Promise<boolean>} True if update was queued/written
   */
  async updateTicker(exchange, marketType, symbol, tickerData) {
    if (!this.isConnected) {
      this.config.logger('warn', 'Redis: Not connected, skipping update', { symbol });
      return false;
    }

    this.stats.totalUpdates++;

    const key = this._makeHashKey(exchange, marketType);
    const symbolHash = this._hashTicker(tickerData);

    // Check deduplication cache
    const cached = this.dedupCache.get(symbol);
    const hasChanged = !cached || cached.hash !== symbolHash;

    if (!hasChanged) {
      this.stats.dedupedUpdates++;
      this.config.logger('debug', 'Redis: Update deduped (no change)', { symbol });
      return false;
    }

    // Check min interval
    if (this.config.redisMinIntervalMs > 0 && cached) {
      const timeSinceLastWrite = Date.now() - cached.lastWriteTime;
      if (timeSinceLastWrite < this.config.redisMinIntervalMs) {
        this.stats.dedupedUpdates++;
        this.config.logger('debug', 'Redis: Update rate-limited', { symbol });
        return false;
      }
    }

    // Update dedup cache
    this.dedupCache.set(symbol, {
      hash: symbolHash,
      lastWriteTime: Date.now(),
    });

    // Queue update
    const update = {
      key,
      field: symbol,
      value: JSON.stringify(tickerData),
      pubsubChannel: `${key}:${symbol}`,
    };

    if (this.config.redisBatching) {
      this.batch.push(update);
      this.stats.batchedUpdates++;

      // Force flush if batch is full
      if (this.batch.length >= this.config.redisMaxBatch) {
        return await this.flush();
      }

      return true;
    } else {
      // Write immediately (no batching)
      return await this._writeUpdate(update);
    }
  }

  /**
   * Manually flush all batched updates
   * @returns {Promise<boolean>} True if flush succeeded
   */
  async flush() {
    if (this.isFlushing || this.batch.length === 0) {
      return true;
    }

    this.isFlushing = true;

    try {
      // Build pipeline
      const pipeline = this.redis.pipeline();

      for (const update of this.batch) {
        // Add hash set: HSET key field value
        pipeline.hset(update.key, update.field, update.value);

        // Add pub/sub publish: PUBLISH channel message
        pipeline.publish(update.pubsubChannel, update.value);
      }

      // Execute pipeline atomically
      const result = await pipeline.exec();

      if (result && result.length > 0) {
        this.stats.flushedBatches++;
        this.config.logger('debug', 'Redis: Batch flushed', {
          updates: this.batch.length,
          batchSize: result.length,
        });
      }

      // Clear batch
      this.batch = [];
      this.isFlushing = false;

      return true;
    } catch (error) {
      this.stats.failedWrites++;
      this.config.logger('error', 'Redis: Flush failed', { message: error.message });
      this.isFlushing = false;
      throw error;
    }
  }

  /**
   * Write a single update immediately (no batching)
   * @private
   */
  async _writeUpdate(update) {
    try {
      const pipeline = this.redis.pipeline();
      pipeline.hset(update.key, update.field, update.value);
      pipeline.publish(update.pubsubChannel, update.value);
      await pipeline.exec();
      return true;
    } catch (error) {
      this.stats.failedWrites++;
      this.config.logger('error', 'Redis: Write failed', { message: error.message });
      return false;
    }
  }

  /**
   * Get a ticker from Redis
   * @param {string} exchange - Exchange name
   * @param {string} marketType - Market type
   * @param {string} symbol - Symbol
   * @returns {Promise<Object|null>} Parsed ticker or null
   */
  async getTicker(exchange, marketType, symbol) {
    if (!this.isConnected) return null;

    try {
      const key = this._makeHashKey(exchange, marketType);
      const data = await this.redis.hget(key, symbol);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.config.logger('error', 'Redis: getTicker failed', { symbol, message: error.message });
      return null;
    }
  }

  /**
   * Get all tickers for an exchange/market
   * @param {string} exchange - Exchange name
   * @param {string} marketType - Market type
   * @returns {Promise<Object>} Map of symbol => ticker
   */
  async getAllTickers(exchange, marketType) {
    if (!this.isConnected) return {};

    try {
      const key = this._makeHashKey(exchange, marketType);
      const data = await this.redis.hgetall(key);

      // Parse all JSON values
      const result = {};
      for (const [field, value] of Object.entries(data)) {
        try {
          result[field] = JSON.parse(value);
        } catch {
          // Skip malformed entries
        }
      }

      return result;
    } catch (error) {
      this.config.logger('error', 'Redis: getAllTickers failed', { message: error.message });
      return {};
    }
  }

  /**
   * Delete a ticker from Redis
   * @param {string} exchange - Exchange name
   * @param {string} marketType - Market type
   * @param {string} symbol - Symbol
   * @returns {Promise<boolean>}
   */
  async deleteTicker(exchange, marketType, symbol) {
    if (!this.isConnected) return false;

    try {
      const key = this._makeHashKey(exchange, marketType);
      await this.redis.hdel(key, symbol);

      // Remove from dedup cache
      this.dedupCache.delete(symbol);

      return true;
    } catch (error) {
      this.config.logger('error', 'Redis: deleteTicker failed', { symbol, message: error.message });
      return false;
    }
  }

  /**
   * Subscribe to ticker updates for a symbol
   * @param {string} exchange - Exchange name
   * @param {string} marketType - Market type
   * @param {string} symbol - Symbol
   * @param {Function} callback - Called when update arrives
   * @returns {Promise<boolean>}
   */
  async subscribe(exchange, marketType, symbol, callback) {
    if (!this.isConnected) return false;

    try {
      const channel = `${this._makeHashKey(exchange, marketType)}:${symbol}`;
      const subscriber = new Redis(this.config.redisUrl);

      subscriber.on('message', (chan, message) => {
        try {
          const data = JSON.parse(message);
          callback(null, data);
        } catch (error) {
          callback(error, null);
        }
      });

      await subscriber.subscribe(channel);
      return true;
    } catch (error) {
      this.config.logger('error', 'Redis: Subscribe failed', { symbol, message: error.message });
      return false;
    }
  }

  /**
   * Get service status/metrics
   * @returns {Object} Status snapshot
   */
  getStatus() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      batchSize: this.batch.length,
      dedupCacheSize: this.dedupCache.size,
      stats: { ...this.stats },
    };
  }

  /**
   * Start batch flush timer
   * @private
   */
  _startBatchTimer() {
    this.batchTimer = setInterval(async () => {
      if (this.batch.length > 0 && !this.isFlushing) {
        try {
          await this.flush();
        } catch (error) {
          this.config.logger('error', 'Redis: Batch timer flush failed', { message: error.message });
        }
      }
    }, this.config.redisFlushMs);
  }

  /**
   * Stop batch flush timer
   * @private
   */
  _stopBatchTimer() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Make Redis hash key
   * @private
   */
  _makeHashKey(exchange, marketType) {
    return `ticker:${exchange}:${marketType}`;
  }

  /**
   * Compute hash of ticker data for deduplication
   * @private
   */
  _hashTicker(tickerData) {
    const str = JSON.stringify(tickerData);
    return crypto.createHash('md5').update(str).digest('hex');
  }
}

module.exports = RedisService;
