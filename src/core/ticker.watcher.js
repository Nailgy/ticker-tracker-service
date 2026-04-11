/**
 * TickerWatcher - Top-Level Orchestrator
 *
 * Glues together all components and manages the full application lifecycle:
 * - Initializes RedisService, ExchangeFactory, ConnectionManager
 * - Implements market discovery loop (periodic refresh, symbol diffing)
 * - Implements graceful shutdown (SIGINT/SIGTERM handlers)
 * - Manages symbol allocation to batches dynamically
 *
 * Usage:
 *   const watcher = new TickerWatcher(config);
 *   await watcher.start();
 *   // Stops on SIGINT/SIGTERM
 */

const RedisService = require('../services/redis.service');
const ExchangeFactory = require('../services/exchange.factory');
const ConnectionManager = require('./connection.manager');

class TickerWatcher {
  /**
   * Initialize orchestrator
   * @param {Object} config - Configuration object from buildConfig()
   */
  constructor(config) {
    this.config = config;
    this.logger = config.logger || this._defaultLogger;

    // Services
    this.redisService = null;
    this.exchangeFactory = null;
    this.connectionManager = null;

    // Market tracking state
    this.currentSymbols = new Set();
    this.marketRefreshTimer = null;

    // Lifecycle state
    this.isRunning = false;
    this.isStopping = false;
  }

  /**
   * Default logger
   * @private
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    const prefix = `[TickerWatcher:${level.toUpperCase()}]`;
    console.log(prefix, message, data ? JSON.stringify(data, null, 2) : '');
  }

  /**
   * Start the orchestrator
   * @returns {Promise<void>}
   * @throws {Error} If initialization fails
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

      // Step 2: Create ExchangeFactory
      this.logger('info', 'TickerWatcher: Creating exchange factory', {
        exchange: this.config.exchange,
        marketType: this.config.type,
      });
      this.exchangeFactory = new ExchangeFactory({
        exchange: this.config.exchange,
        marketType: this.config.type,
        logger: this.logger,
      });

      // Step 3: Create ConnectionManager
      this.logger('info', 'TickerWatcher: Creating connection manager');
      this.connectionManager = new ConnectionManager({
        exchangeFactory: this.exchangeFactory,
        redisService: this.redisService,
        batchSize: this.config.batchSize || 100,
        logger: this.logger,
      });

      // Step 4: Initialize ConnectionManager (load markets, create batches)
      this.logger('info', 'TickerWatcher: Initializing connection manager');
      await this.connectionManager.initialize();
      this.logger('info', 'TickerWatcher: Markets loaded', {
        symbolCount: this.connectionManager.symbols.length,
        batchCount: this.connectionManager.batches.length,
      });

      // Store initial symbol set for market discovery
      this.currentSymbols = new Set(this.connectionManager.symbols);

      // Step 5: Start subscriptions
      this.logger('info', 'TickerWatcher: Starting subscriptions');
      await this.connectionManager.startSubscriptions();
      this.logger('info', 'TickerWatcher: Subscriptions started');

      // Step 6: Start market discovery loop
      const refreshInterval = this.config.marketRefreshInterval || 300000; // 5 min default
      if (refreshInterval > 0) {
        this.logger('info', 'TickerWatcher: Starting market discovery loop', {
          intervalMs: refreshInterval,
        });
        this.marketRefreshTimer = setInterval(
          () => this._refreshMarkets(),
          refreshInterval
        );
      }

      // Step 7: Install signal handlers for graceful shutdown
      this.logger('info', 'TickerWatcher: Installing signal handlers');
      process.on('SIGINT', () => this._onSignal('SIGINT'));
      process.on('SIGTERM', () => this._onSignal('SIGTERM'));

      this.isRunning = true;
      this.logger('info', 'TickerWatcher: ✅ Service started successfully', {
        exchange: this.config.exchange,
        marketType: this.config.type,
        symbols: this.currentSymbols.size,
        batches: this.connectionManager.batches.length,
      });
    } catch (error) {
      this.logger('error', `TickerWatcher: Startup failed: ${error.message}`, {
        error: error.stack,
      });
      // Clean up on startup failure
      if (this.connectionManager) {
        try {
          await this.connectionManager.stop();
        } catch (e) {
          // Ignore cleanup errors during failure
        }
      }
      if (this.redisService) {
        try {
          await this.redisService.disconnect();
        } catch (e) {
          // Ignore cleanup errors during failure
        }
      }
      throw error;
    }
  }

  /**
   * Stop the orchestrator (called on signal or explicit stop)
   * @returns {Promise<void>}
   */
  async stop() {
    if (this.isStopping) return; // Prevent double-stop

    this.isStopping = true;
    this.isRunning = false;

    this.logger('info', 'TickerWatcher: ⏹️  Shutting down gracefully...');

    try {
      // Step 1: Stop market discovery loop
      if (this.marketRefreshTimer) {
        clearInterval(this.marketRefreshTimer);
        this.marketRefreshTimer = null;
        this.logger('debug', 'TickerWatcher: Market discovery loop stopped');
      }

      // Step 2: Stop ConnectionManager (flush Redis, close exchange)
      if (this.connectionManager) {
        this.logger('debug', 'TickerWatcher: Stopping connection manager');
        await this.connectionManager.stop();
        this.logger('debug', 'TickerWatcher: Connection manager stopped');
      }

      // Step 3: Disconnect Redis
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
   * @private
   */
  async _onSignal(signal) {
    this.logger('info', `TickerWatcher: Received ${signal}`);
    try {
      await this.stop();
      process.exit(0);
    } catch (error) {
      this.logger('error', 'TickerWatcher: Error during signal shutdown');
      process.exit(1);
    }
  }

  /**
   * Market discovery loop - refresh markets, detect changes, allocate symbols
   * @private
   */
  async _refreshMarkets() {
    try {
      if (this.isStopping) return;

      this.logger('debug', 'TickerWatcher: Refreshing markets...');

      // Load fresh market list
      const freshMarkets = await this.exchangeFactory.loadMarkets();
      const newSymbols = new Set(freshMarkets.map(m => m.symbol));

      // Detect changes
      const added = [...newSymbols].filter(s => !this.currentSymbols.has(s));
      const removed = [...this.currentSymbols].filter(s => !newSymbols.has(s));

      // No changes
      if (added.length === 0 && removed.length === 0) {
        this.logger('debug', 'TickerWatcher: No market changes detected', {
          totalSymbols: this.currentSymbols.size,
        });
        return;
      }

      // Handle removed symbols
      if (removed.length > 0) {
        this.logger('info', 'TickerWatcher: Removing symbols', {
          count: removed.length,
          symbols: removed.slice(0, 5), // Log first 5
        });
        this._handleRemovedSymbols(removed);
      }

      // Handle new symbols
      if (added.length > 0) {
        this.logger('info', 'TickerWatcher: Adding new symbols', {
          count: added.length,
          symbols: added.slice(0, 5), // Log first 5
        });
        this._handleNewSymbols(added);
      }

      // Update current state
      this.currentSymbols = newSymbols;

      this.logger('info', 'TickerWatcher: Market refresh complete', {
        newCount: added.length,
        removedCount: removed.length,
        totalSymbols: this.currentSymbols.size,
        batchCount: this.connectionManager.batches.length,
      });
    } catch (error) {
      this.logger('warn', `TickerWatcher: Market refresh error: ${error.message}`, {
        error: error.stack,
      });
      // Continue - don't crash on market discovery error
    }
  }

  /**
   * Handle newly added symbols
   * @private
   */
  _handleNewSymbols(added) {
    try {
      // Try to fit into existing batches
      for (const symbol of added) {
        let allocated = false;

        // Find batch with space
        for (let i = 0; i < this.connectionManager.batches.length; i++) {
          const batch = this.connectionManager.batches[i];
          if (batch.length < this.config.batchSize) {
            batch.push(symbol);
            this.currentSymbols.add(symbol);
            this.logger('debug', 'TickerWatcher: Symbol allocated to existing batch', {
              symbol,
              batchIndex: i,
              batchSize: batch.length,
            });
            allocated = true;
            break;
          }
        }

        // If no space, need to recalculate batches
        if (!allocated) {
          // Add to symbols array and recalculate batches
          if (!this.connectionManager.symbols.includes(symbol)) {
            this.connectionManager.symbols.push(symbol);
          }
          this.currentSymbols.add(symbol);
          this.logger('debug', 'TickerWatcher: Symbol queued for batch recalculation', {
            symbol,
          });
        }
      }

      // Recalculate batches to distribute any new symbols into new batches
      const oldBatchCount = this.connectionManager.batches.length;
      this.connectionManager._createBatches();
      const newBatchCount = this.connectionManager.batches.length;

      if (newBatchCount > oldBatchCount) {
        this.logger('info', 'TickerWatcher: New batches created', {
          oldCount: oldBatchCount,
          newCount: newBatchCount,
          newBatchesCount: newBatchCount - oldBatchCount,
        });

        // Start subscription for new batches
        for (let i = oldBatchCount; i < newBatchCount; i++) {
          const batch = this.connectionManager.batches[i];
          const batchId = `batch-${i}`;
          this.logger('debug', 'TickerWatcher: Starting subscription for new batch', {
            batchId,
            symbolCount: batch.length,
          });
          // Stagger the start to avoid thundering herd
          const delay = i * 100;
          setTimeout(() => {
            if (this.isRunning && !this.isStopping) {
              this.connectionManager
                ._subscriptionLoop(batchId, batch)
                .catch(error => {
                  this.logger('error', `TickerWatcher: Subscription loop error [${batchId}]`, {
                    error: error.message,
                  });
                });
            }
          }, delay);
        }
      }
    } catch (error) {
      this.logger('error', `TickerWatcher: Error handling new symbols: ${error.message}`, {
        error: error.stack,
      });
    }
  }

  /**
   * Handle removed symbols
   * @private
   */
  _handleRemovedSymbols(removed) {
    try {
      for (const symbol of removed) {
        // Find and remove from batches
        for (let i = 0; i < this.connectionManager.batches.length; i++) {
          const batch = this.connectionManager.batches[i];
          const index = batch.indexOf(symbol);
          if (index !== -1) {
            batch.splice(index, 1);
            this.logger('debug', 'TickerWatcher: Symbol removed from batch', {
              symbol,
              batchIndex: i,
            });
            break;
          }
        }

        // Mark as non-retryable to prevent reconnect attempts
        this.connectionManager.nonRetryableSymbols.add(symbol);
        this.currentSymbols.delete(symbol);
      }

      // Remove empty batches
      const beforeCount = this.connectionManager.batches.length;
      this.connectionManager.batches = this.connectionManager.batches.filter(
        batch => batch.length > 0
      );
      const afterCount = this.connectionManager.batches.length;

      if (afterCount < beforeCount) {
        this.logger('info', 'TickerWatcher: Empty batches cleaned up', {
          removedBatches: beforeCount - afterCount,
          remainingBatches: afterCount,
        });
      }
    } catch (error) {
      this.logger('error', `TickerWatcher: Error handling removed symbols: ${error.message}`, {
        error: error.stack,
      });
    }
  }

  /**
   * Get orchestrator status snapshot
   * @returns {Object}
   */
  getStatus() {
    const connectionStatus = this.connectionManager?.getStatus() || {};
    const nextRefreshMs = this.marketRefreshTimer
      ? Math.ceil(
          (this.connectionManager?.config?.marketRefreshInterval || 300000) / 1000
        ) * 1000
      : null;

    return {
      isRunning: this.isRunning && !this.isStopping,
      exchange: this.config.exchange,
      marketType: this.config.type,
      currentSymbols: this.currentSymbols.size,
      nextMarketRefreshInSec: nextRefreshMs ? Math.ceil(nextRefreshMs / 1000) : null,
      redisConnected: this.redisService?.isConnected || false,
      ...connectionStatus,
    };
  }

  /**
   * Helper: sleep
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = TickerWatcher;
