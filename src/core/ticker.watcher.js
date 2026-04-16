/**
 * TickerWatcher - Top-Level Orchestrator (Refactored)
 *
 * REFACTORED to:
 * - Use ONLY public APIs of ConnectionManager
 * - NO calls to private methods (_createBatches, _subscriptionLoop)
 * - Delegate all subscription logic to ConnectionManager
 * - Manage lifecycle and market discovery only
 *
 * Responsibilities:
 * - Initialize all services
 * - Start subscriptions
 * - Coordinate market discovery loop
 * - Implement graceful shutdown
 * - Install signal handlers
 *
 * Usage:
 *   const watcher = new TickerWatcher(config);
 *   await watcher.start();    // Blocks until SIGINT/SIGTERM
 */

const ConnectionManager = require('./connection.manager');
const RedisService = require('../services/redis.service');

class TickerWatcher {
  constructor(config) {
    this.config = config;
    this.logger = config.logger || this._defaultLogger;

    // Services
    this.redisService = null;
    this.connectionManager = null;

    // Market tracking
    this.currentSymbols = new Set();
    this.marketRefreshTimer = null;

    // Lifecycle
    this.isRunning = false;
    this.isStopping = false;
  }

  /**
   * Default logger
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[TickerWatcher:${level.toUpperCase()}] ${message}`, data || '');
  }

  /**
   * Start the orchestrator
   */
  async start() {
    try {
      this.logger('info', 'TickerWatcher: Starting orchestrator');

      // Validate config
      if (!this.config.exchange) {
        throw new Error('exchange is required in config');
      }
      if (!this.config.type) {
        throw new Error('type (spot/swap) is required in config');
      }

      // Step 1: Connect to Redis
      this.logger('info', 'TickerWatcher: Connecting to Redis', {
        url: this.config.redisUrl,
      });
      this.redisService = new RedisService(this.config);
      await this.redisService.connect();
      this.logger('info', 'TickerWatcher: Redis connected');

      // Step 2: Create ConnectionManager
      this.logger('info', 'TickerWatcher: Creating connection manager');
      this.connectionManager = new ConnectionManager({
        exchange: this.config.exchange,
        marketType: this.config.type,
        batchSize: this.config.batchSize || 100,
        subscriptionDelay: this.config.subscriptionDelay || 100,
        strategyMode: this.config.strategyMode, // Optional explicit strategy override
        redisBatching: this.config.redisBatching,
        redisFlushMs: this.config.redisFlushMs,
        redisMaxBatch: this.config.redisMaxBatch,
        redisOnlyOnChange: this.config.redisOnlyOnChange,
        redisMinIntervalMs: this.config.redisMinIntervalMs,
        localIps: this.config.localIps,
        noProxy: this.config.noProxy,
        redisService: this.redisService,
        logger: this.logger,
      });

      // Step 3: Initialize (loads markets, creates exchange)
      this.logger('info', 'TickerWatcher: Initializing connection manager');
      await this.connectionManager.initialize();

      // Store initial symbol set
      this.currentSymbols = this.connectionManager.getActiveSymbols();

      this.logger('info', 'TickerWatcher: Markets loaded', {
        symbolCount: this.currentSymbols.size,
        batchCount: this.connectionManager.getBatchCount(),
      });

      // Step 4: Start subscriptions
      this.logger('info', 'TickerWatcher: Starting subscriptions');
      await this.connectionManager.startSubscriptions();
      this.logger('info', 'TickerWatcher: Subscriptions started');

      // Step 5: Start market discovery loop
      const refreshInterval = this.config.marketRefreshInterval || 300000;
      if (refreshInterval > 0) {
        this.logger('info', 'TickerWatcher: Starting market discovery loop', {
          intervalMs: refreshInterval,
        });
        this.marketRefreshTimer = setInterval(
          () => this._refreshMarkets(),
          refreshInterval
        );
      }

      // Step 6: Install signal handlers
      this.logger('info', 'TickerWatcher: Installing signal handlers');
      process.on('SIGINT', () => this._onSignal('SIGINT'));
      process.on('SIGTERM', () => this._onSignal('SIGTERM'));

      this.isRunning = true;
      this.logger('info', 'TickerWatcher: ✅ Service started successfully', {
        exchange: this.config.exchange,
        marketType: this.config.type,
        symbols: this.currentSymbols.size,
        batches: this.connectionManager.getBatchCount(),
      });
    } catch (error) {
      this.logger('error', `TickerWatcher: Startup failed: ${error.message}`, {
        error: error.stack,
      });
      await this._cleanup();
      throw error;
    }
  }

  /**
   * Stop the orchestrator
   */
  async stop() {
    if (this.isStopping) return;

    this.isStopping = true;
    this.isRunning = false;

    this.logger('info', 'TickerWatcher: ⏹️  Shutting down gracefully...');

    try {
      // Stop market discovery
      if (this.marketRefreshTimer) {
        clearInterval(this.marketRefreshTimer);
        this.marketRefreshTimer = null;
        this.logger('debug', 'TickerWatcher: Market discovery loop stopped');
      }

      // Stop connection manager
      if (this.connectionManager) {
        this.logger('debug', 'TickerWatcher: Stopping connection manager');
        await this.connectionManager.stop();
        this.logger('debug', 'TickerWatcher: Connection manager stopped');
      }

      // Disconnect Redis
      if (this.redisService) {
        this.logger('debug', 'TickerWatcher: Disconnecting from Redis');
        await this.redisService.disconnect();
        this.logger('debug', 'TickerWatcher: Redis disconnected');
      }

      this.logger('info', 'TickerWatcher: ✅ Shutdown complete');
    } catch (error) {
      this.logger('error', `TickerWatcher: Error during shutdown: ${error.message}`, {
        error: error.stack,
      });
      throw error;
    }
  }

  /**
   * Signal handler
   *
   * @private
   */
  async _onSignal(signal) {
    this.logger('info', `TickerWatcher: Received ${signal}. Graceful shutdown starting...`);

    // Safety timeout: Force exit if graceful shutdown takes too long
    // This prevents the process from becoming a zombie if Redis or network hangs
    const forceExitTimer = setTimeout(() => {
      this.logger('error', 'TickerWatcher: Graceful shutdown timeout (5s exceeded). Force exit.');
      process.exit(1);
    }, 5000);

    try {
      await this.stop();
      clearTimeout(forceExitTimer);
      this.logger('info', 'TickerWatcher: Graceful shutdown completed successfully');
      process.exit(0);
    } catch (error) {
      this.logger('error', 'TickerWatcher: Error during signal shutdown', {
        error: error.message,
      });
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  }

  /**
   * Market discovery loop - refresh, diff, reallocate
   *
   * @private
   */
  async _refreshMarkets() {
    try {
      if (this.isStopping) return;

      this.logger('debug', 'TickerWatcher: Refreshing markets...');

      // Call public API to refresh markets
      const { added, removed } = await this.connectionManager.refreshMarkets();

      // Update tracking
      for (const symbol of added) {
        this.currentSymbols.add(symbol);
      }
      for (const symbol of removed) {
        this.currentSymbols.delete(symbol);
      }

      if (added.length === 0 && removed.length === 0) {
        this.logger('debug', 'TickerWatcher: No market changes detected', {
          totalSymbols: this.currentSymbols.size,
        });
        return;
      }

      this.logger('info', 'TickerWatcher: Market refresh complete', {
        newCount: added.length,
        removedCount: removed.length,
        totalSymbols: this.currentSymbols.size,
        batchCount: this.connectionManager.getBatchCount(),
      });
    } catch (error) {
      this.logger('warn', `TickerWatcher: Market refresh error: ${error.message}`, {
        error: error.stack,
      });
    }
  }

  /**
   * Cleanup helper
   *
   * @private
   */
  async _cleanup() {
    try {
      if (this.connectionManager) {
        await this.connectionManager.stop().catch(() => {});
      }
      if (this.redisService) {
        await this.redisService.disconnect().catch(() => {});
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  /**
   * Get status
   */
  getStatus() {
    return this.connectionManager?.getStatus() || {};
  }
}

module.exports = TickerWatcher;
