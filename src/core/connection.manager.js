/**
 * ConnectionManager - Pure Coordinator for Subscription Components
 *
 * REFACTORED: DOES NOT manage subscription loops directly.
 * Coordinates and delegates to specialized components:
 * - ExchangeAdapter for CCXT behavior
 * - SubscriptionEngine for loop coordination
 * - MarketRegistry for symbol state
 * - RedisWriter for data persistence
 *
 * This is the ONLY place where these components talk to each other.
 * NO private method calls. All behavior is delegated.
 *
 * STRICT ENCAPSULATION: All mutable state is #private.
 * Access only through public methods (immutable copies).
 *
 * Usage:
 *   const manager = new ConnectionManager(config);
 *   await manager.initialize();
 *   await manager.startSubscriptions();
 *   const status = manager.getStatus();
 *   await manager.stop();
 */

const ExchangeAdapter = require('../adapters/ccxt.adapter');
const SubscriptionEngine = require('./subscription.engine');
const MarketRegistry = require('./market.registry');
const RedisWriter = require('../services/redis.writer');
const { NoProxyProvider, LocalIPProvider } = require('../services/proxy.provider');
const { getResilienceConfig } = require('../constants/exchanges');

/**
 * Default adapter factory (creates CCXTAdapter instances)
 */
function defaultAdapterFactory(config) {
  return new ExchangeAdapter(config);
}

/**
 * Default proxy provider factory (creates NoProxyProvider)
 */
function defaultProxyProviderFactory(config) {
  if (config.noProxy) {
    return new NoProxyProvider();
  }
  if (Array.isArray(config.localIps) && config.localIps.length > 0) {
    return new LocalIPProvider(config.localIps, { logger: config.logger });
  }
  return new NoProxyProvider();
}

class ConnectionManager {
  // Private fields - strict encapsulation
  #adapter = null;
  #subscriptionEngine = null;
  #marketRegistry = null;
  #redisWriter = null;
  #batches = [];
  #isRefreshing = false;  // Concurrency guard (mutex) for single-flight refreshMarkets()

  constructor(config = {}) {
    this.config = {
      exchange: config.exchange || 'binance', // Default for tests
      marketType: config.marketType || 'spot',
      batchSize: config.batchSize || 100,
      subscriptionDelay: config.subscriptionDelay || 100,
      strategyMode: config.strategyMode, // Optional explicit strategy override (Level 1 precedence)
      logger: config.logger || this._defaultLogger,
      redisBatching: config.redisBatching,
      redisFlushMs: config.redisFlushMs,
      redisMaxBatch: config.redisMaxBatch,
      redisOnlyOnChange: config.redisOnlyOnChange,
      redisMinIntervalMs: config.redisMinIntervalMs,

      // Resilience config (can be overridden)
      retryBaseDelayMs: config.retryBaseDelayMs,
      retryMaxDelayMs: config.retryMaxDelayMs,
      healthCheckIntervalMs: config.healthCheckIntervalMs,
      healthCheckTimeoutMs: config.healthCheckTimeoutMs,

      // Redis
      redisService: config.redisService,

      // Factories for dependency injection
      adapterFactory: config.adapterFactory || defaultAdapterFactory,
      proxyProviderFactory: config.proxyProviderFactory || defaultProxyProviderFactory,
      subscriptionEngineFactory: config.subscriptionEngineFactory, // Optional: for testing
      localIps: config.localIps || [],
      noProxy: config.noProxy || false,
    };

    // Inject exchange-specific resilience config (safely handle undefined)
    if (this.config.exchange) {
      const resilience = getResilienceConfig(this.config.exchange);
      this.config.retryBaseDelayMs = this.config.retryBaseDelayMs ?? resilience.retryBaseDelayMs;
      this.config.retryMaxDelayMs = this.config.retryMaxDelayMs ?? resilience.retryMaxDelayMs;
      this.config.healthCheckIntervalMs = this.config.healthCheckIntervalMs ?? resilience.healthCheckIntervalMs;
      this.config.healthCheckTimeoutMs = this.config.healthCheckTimeoutMs ?? resilience.healthCheckTimeoutMs;
    }

    // Public state flags
    this.isInitialized = false;
    this.isRunning = false;
  }

  /**
   * Default logger
   */
  _defaultLogger(level, message, data) {
    if (level === 'debug') return;
    console.log(`[ConnectionManager:${level.toUpperCase()}] ${message}`, data || '');
  }

  /**
   * Initialize - create all components and load markets
   */
  async initialize() {
    try {
      this.config.logger('info', `ConnectionManager: Initializing`, {
        exchange: this.config.exchange,
        marketType: this.config.marketType,
      });

      // Create proxy provider using factory
      const proxyProvider = this.config.proxyProviderFactory({
        exchange: this.config.exchange,
        marketType: this.config.marketType,
        localIps: this.config.localIps,
        noProxy: this.config.noProxy,
        logger: this.config.logger,
      });

      // Create adapter using factory
      this.#adapter = this.config.adapterFactory({
        exchange: this.config.exchange,
        marketType: this.config.marketType,
        strategyMode: this.config.strategyMode, // Pass explicit override (Level 1 precedence)
        logger: this.config.logger,
        proxyProvider: proxyProvider,
      });

      this.#marketRegistry = new MarketRegistry({
        logger: this.config.logger,
      });

      this.#redisWriter = new RedisWriter(this.config.redisService, {
        redisBatching: this.config.redisBatching,
        redisFlushMs: this.config.redisFlushMs,
        redisMaxBatch: this.config.redisMaxBatch,
        redisOnlyOnChange: this.config.redisOnlyOnChange,
        redisMinIntervalMs: this.config.redisMinIntervalMs,
        logger: this.config.logger,
      });

      // Create adapter factory (for per-batch adapter creation via AdapterPool)
      // Each batch will get its OWN adapter instance via this factory
      const adapterFactory = async () => {
        return this.config.adapterFactory({
          exchange: this.config.exchange,
          marketType: this.config.marketType,
          strategyMode: this.config.strategyMode,
          logger: this.config.logger,
          proxyProvider: proxyProvider,
        });
      };

      // Extract Stage 3 per-exchange config
      const { getHealthRatioPolicy, getStaleWatchdogConfig } = require('../constants/exchanges');
      const healthRatioPolicyConfig = getHealthRatioPolicy(this.config.exchange);
      const staleWatchdogConfig = getStaleWatchdogConfig(this.config.exchange);

      this.#subscriptionEngine = this.config.subscriptionEngineFactory
        ? this.config.subscriptionEngineFactory()
        : new SubscriptionEngine(
          adapterFactory,  // Pass factory (not single adapter) for per-batch isolation
          this.#marketRegistry,
          this.#redisWriter,
          {
            batchSize: this.config.batchSize,
            subscriptionDelay: this.config.subscriptionDelay,
            retryBaseDelayMs: this.config.retryBaseDelayMs,
            retryMaxDelayMs: this.config.retryMaxDelayMs,
            healthCheckIntervalMs: this.config.healthCheckIntervalMs,
            healthCheckTimeoutMs: this.config.healthCheckTimeoutMs,
            logger: this.config.logger,
            // Stage 3 per-exchange config
            healthRatioPolicyConfig: healthRatioPolicyConfig,
            staleWatchdogConfig: staleWatchdogConfig,
          }
        );

      // Initialize one adapter for market loading (metadata gathering)
      this.#adapter = await adapterFactory();
      await this.#adapter.initialize();

      // Load markets
      await this.#marketRegistry.loadDesiredMarkets(this.#adapter);

      // Add all desired symbols to active tracking
      const desiredSymbols = Array.from(this.#marketRegistry.getDesiredSymbols());
      this.#marketRegistry.addSymbols(desiredSymbols);

      // Create batches
      this.#createBatches();

      this.isInitialized = true;

      this.config.logger('info', `ConnectionManager: Initialized`, {
        symbols: this.#marketRegistry.getDesiredSymbols().size,
        batches: this.#batches.length,
      });
    } catch (error) {
      this.config.logger('error', `ConnectionManager: Initialization failed`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Start subscriptions
   */
  async startSubscriptions() {
    if (!this.isInitialized) {
      throw new Error('ConnectionManager not initialized - call initialize() first');
    }

    if (this.isRunning) {
      this.config.logger('warn', `ConnectionManager: Already running`);
      return;
    }

    try {
      // Register callbacks on subscription engine
      this.#subscriptionEngine.onTicker((symbol, ticker) => {
        // Tickers already handled by RedisWriter internally
      });

      this.#subscriptionEngine.onError((batchId, error) => {
        this.config.logger('debug', `ConnectionManager: Subscription error [${batchId}]`, {
          error: error.message,
        });
      });

      // Start subscription engine with current batches
      await this.#subscriptionEngine.startSubscriptions(this.#batches);
      this.isRunning = true;

      this.config.logger('info', `ConnectionManager: Subscriptions started`);
    } catch (error) {
      this.config.logger('error', `ConnectionManager: Start subscriptions failed`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Stop subscriptions and cleanup
   */
  async stop() {
    if (!this.isRunning) return;

    try {
      this.config.logger('info', `ConnectionManager: Stopping`);

      this.isRunning = false;

      // Stop subscription engine
      if (this.#subscriptionEngine) {
        await this.#subscriptionEngine.stopSubscriptions();
      }

      // Flush Redis
      if (this.#redisWriter) {
        await this.#redisWriter.flush();
      }

      this.config.logger('info', `ConnectionManager: Stopped`);
    } catch (error) {
      this.config.logger('error', `ConnectionManager: Stop failed`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Refresh markets and reallocate symbols
   * STAGE 4: Incremental reconciliation without full restart
   * CONCURRENCY GUARD: Single-flight mutex prevents concurrent API calls to exchange
   */
  async refreshMarkets() {
    if (!this.isInitialized) {
      throw new Error('ConnectionManager not initialized');
    }

    // --- CONCURRENCY GUARD (Single-flight mutex) ---
    if (this.#isRefreshing) {
      this.config.logger('debug', `ConnectionManager: Refresh already in progress, skipping (coalescing)`);
      return { added: [], removed: [] };  // Skip, don't make concurrent exchange call
    }
    this.#isRefreshing = true;  // Acquire lock

    try {
      this.config.logger('debug', `ConnectionManager: Refreshing markets (Stage 4 - zero downtime)`);

      // CRITICAL: SNAPSHOT MUST BE TAKEN BEFORE ANY MUTATIONS (atomicity requirement)
      // This captures the TRUE pre-refresh state before loadDesiredMarkets/addSymbols/removeSymbols
      const registrySnapshot = {
        desiredSymbols: new Set(this.#marketRegistry.desiredSymbols),
        activeSymbols: new Set(this.#marketRegistry.activeSymbols),
        batchAllocations: new Map(
          Array.from(this.#marketRegistry.batchAllocations.entries()).map(
            ([batchId, symbols]) => [batchId, new Set(symbols)]  // Deep copy each Set
          )
        ),
        symbolToBatchMap: new Map(this.#marketRegistry.symbolToBatchMap),
        // CRITICAL: Also snapshot metrics (for full atomic consistency)
        metrics: { ...this.#marketRegistry.metrics },
      };

      // Save original #batches BEFORE any mutations (for rollback)
      const originalBatches = [...this.#batches];

      // Get previous state for diffing
      const previousState = {
        desiredSymbols: this.#marketRegistry.getDesiredSymbols(),
      };

      // Load fresh markets (Phase 1: reload: true in ccxt.adapter.js)
      await this.#marketRegistry.loadDesiredMarkets(this.#adapter);

      // Detect changes
      const { added, removed } = this.#marketRegistry.getDiffSince(previousState);

      if (added.length > 0) {
        this.#marketRegistry.addSymbols(added);
        this.config.logger('info', `ConnectionManager: New symbols detected`, {
          count: added.length,
        });
      }

      if (removed.length > 0) {
        this.#marketRegistry.removeSymbols(removed);
        this.config.logger('info', `ConnectionManager: Removed symbols detected`, {
          count: removed.length,
        });
      }

      // STAGE 4: Incremental reconciliation without restart
      // STAGE 4: Rebalance with minimal diff (preserves batch IDs, moves only changed symbols)
      const rebalanceDiff = this.#marketRegistry.rebalance(this.config.batchSize);

      // Build next plan from rebalanced batches
      const nextPlan = Array.from(this.#marketRegistry.batchAllocations.entries()).map(
        ([batchId, symbols]) => ({
          batchId,
          symbols: Array.from(symbols),
        })
      );

      // Update #batches with new plan
      this.#batches = nextPlan.map(p => p.symbols);

      if (added.length > 0 || removed.length > 0) {
        if (!this.isRunning) {
          // Market changes detected but subscriptions are not running.
          // Don't restart them - respect the stopped state.
          // #batches are now fresh for next startup.
          this.config.logger('debug', `ConnectionManager: Market changes detected but subscriptions not running, skipping reconciliation`, {
            added: added.length,
            removed: removed.length,
          });
          return { added, removed };
        }

        try {
          this.config.logger('debug', `ConnectionManager: Rebalance plan created`, {
            newBatches: rebalanceDiff.added.length,
            modifiedBatches: rebalanceDiff.modified.length,
            unchangedBatches: rebalanceDiff.unchanged.length,
            removedBatches: rebalanceDiff.removed.length,
          });

          // STAGE 4: Reconcile subscriptions (add/remove symbols without restart)
          const reconcileDiff = await this.#subscriptionEngine.reconcileBatches(nextPlan);

          this.config.logger('info', `ConnectionManager: Reconciliation complete (zero downtime)`, {
            newBatches: reconcileDiff.added.length,
            modifiedBatches: reconcileDiff.modified.length,
            unchangedBatches: reconcileDiff.unchanged.length,
            pausedBatches: reconcileDiff.removed.length,
          });
        } catch (reconcileError) {
          // ATOMIC ROLLBACK for symbol changes: If reconcile fails, undo add/remove
          this.config.logger('error', `ConnectionManager: Reconciliation failed, rolling back symbol changes (atomic transaction)`, {
            error: reconcileError.message,
            addedSymbols: added.length,
            removedSymbols: removed.length,
          });

          // CRITICAL FIX: Mark failed symbols as non-retryable to prevent "Groundhog Day" infinite loop
          // If new symbols caused reconciliation to fail, they're likely broken/incompatible
          // Blacklisting them prevents endless retry attempts on future refreshes
          if (added.length > 0) {
            this.#marketRegistry.markNonRetryable(added, 'reconcile_fatal_error', {
              errorMessage: reconcileError.message,
              timestamp: new Date().toISOString(),
            });
            this.config.logger('info', `ConnectionManager: Marked failed symbols as non-retryable (blacklist)`, {
              count: added.length,
              reason: 'reconcile_fatal_error',
              error: reconcileError.message,
            });
          }

          // Roll back ONLY the symbol changes (add/remove mutations)
          if (added.length > 0) {
            this.#marketRegistry.removeSymbols(added);
            this.config.logger('debug', `ConnectionManager: Rolled back added symbols`, { count: added.length });
          }
          if (removed.length > 0) {
            this.#marketRegistry.addSymbols(removed);
            this.config.logger('debug', `ConnectionManager: Rolled back removed symbols`, { count: removed.length });
          }

          // Also restore the broader state from snapshot (redundant but defensive)
          this.#marketRegistry.batchAllocations = registrySnapshot.batchAllocations;
          this.#marketRegistry.symbolToBatchMap = registrySnapshot.symbolToBatchMap;
          this.#marketRegistry.desiredSymbols = registrySnapshot.desiredSymbols;
          this.#marketRegistry.activeSymbols = registrySnapshot.activeSymbols;
          this.#marketRegistry.metrics = { ...registrySnapshot.metrics };
          this.#batches = originalBatches;

          throw reconcileError;  // Propagate error to caller
        }
      }

      return { added, removed };
    } catch (error) {
      this.config.logger('warn', `ConnectionManager: Market refresh error`, {
        error: error.message,
      });
      throw error;
    } finally {
      // --- RELEASE MUTEX ---
      // finally guarantees lock is released even if error occurs
      this.#isRefreshing = false;
    }
  }

  /**
   * Create batches from currently tracked symbols
   * This is a private method - called internally only
   */
  #createBatches() {
    const activeSymbols = Array.from(this.#marketRegistry.getActiveSymbols()).sort();
    this.#batches = [];

    for (let i = 0; i < activeSymbols.length; i += this.config.batchSize) {
      const batch = activeSymbols.slice(i, i + this.config.batchSize);
      this.#batches.push(batch);
    }

    // Allocate to registry for internal tracking
    const batchIds = this.#batches.map((_, i) => `batch-${i}`);
    this.#marketRegistry.allocateToBatches(batchIds);

    this.config.logger('debug', `ConnectionManager: Batches created`, {
      batches: this.#batches.length,
      symbolsPerBatch: Math.ceil(activeSymbols.length / this.#batches.length || 1),
    });
  }

  /**
   * PUBLIC GETTER - Get adapter (read-only proxy for tests/inspection only)
   * Returns a read-only proxy to prevent accidental mutations
   */
  get adapter() {
    if (!this.#adapter) return null;
    return new Proxy(this.#adapter, {
      set: () => {
        throw new Error('Cannot mutate adapter - component reference is read-only');
      },
      defineProperty: () => {
        throw new Error('Cannot define properties on adapter - component reference is read-only');
      },
      deleteProperty: () => {
        throw new Error('Cannot delete properties on adapter - component reference is read-only');
      },
    });
  }

  /**
   * PUBLIC GETTER - Get subscription engine (read-only proxy)
   */
  get subscriptionEngine() {
    if (!this.#subscriptionEngine) return null;
    return new Proxy(this.#subscriptionEngine, {
      set: () => {
        throw new Error('Cannot mutate subscriptionEngine - component reference is read-only');
      },
      defineProperty: () => {
        throw new Error('Cannot define properties on subscriptionEngine - component reference is read-only');
      },
      deleteProperty: () => {
        throw new Error('Cannot delete properties on subscriptionEngine - component reference is read-only');
      },
    });
  }

  /**
   * PUBLIC GETTER - Get market registry (read-only proxy)
   */
  get marketRegistry() {
    if (!this.#marketRegistry) return null;
    return new Proxy(this.#marketRegistry, {
      set: () => {
        throw new Error('Cannot mutate marketRegistry - component reference is read-only');
      },
      defineProperty: () => {
        throw new Error('Cannot define properties on marketRegistry - component reference is read-only');
      },
      deleteProperty: () => {
        throw new Error('Cannot delete properties on marketRegistry - component reference is read-only');
      },
    });
  }

  /**
   * PUBLIC GETTER - Get redis writer (read-only proxy)
   */
  get redisWriter() {
    if (!this.#redisWriter) return null;
    return new Proxy(this.#redisWriter, {
      set: () => {
        throw new Error('Cannot mutate redisWriter - component reference is read-only');
      },
      defineProperty: () => {
        throw new Error('Cannot define properties on redisWriter - component reference is read-only');
      },
      deleteProperty: () => {
        throw new Error('Cannot delete properties on redisWriter - component reference is read-only');
      },
    });
  }

  /**
   * PUBLIC GETTER - Get batches array (immutable - returns fresh copy)
   */
  get batches() {
    return [...this.#batches];
  }

  /**
   * Get active symbol count
   */
  getSymbolCount() {
    return this.#marketRegistry?.getActiveSymbols()?.size || 0;
  }

  /**
   * Get batch count
   */
  getBatchCount() {
    return this.#batches.length;
  }

  /**
   * Get active symbols (fresh copy)
   */
  getActiveSymbols() {
    const symbols = this.#marketRegistry?.getActiveSymbols() || new Set();
    return new Set(symbols);
  }

  /**
   * Get status
   */
  getStatus() {
    // Stage 2: AdapterPool is managed by SubscriptionEngine, get via engine.getStatus()
    const engineStatus = this.#subscriptionEngine?.getStatus() || {};

    // For backward compatibility, extract adapter metrics from engine's adapterPool if available
    const adapterMetrics = engineStatus.batchHealth ?
      { batchCount: engineStatus.batchHealth.length } :
      {};

    const registryMetrics = this.#marketRegistry?.getMetrics() || {};
    const writerMetrics = this.#redisWriter?.getMetrics() || {};

    return {
      isInitialized: this.isInitialized,
      isRunning: this.isRunning,
      exchange: this.config.exchange,
      marketType: this.config.marketType,
      symbolCount: registryMetrics.activeCount || 0,
      batches: this.#batches.length,
      adapter: adapterMetrics,
      engine: engineStatus,
      registry: registryMetrics,
      writer: writerMetrics,
    };
  }
}

module.exports = ConnectionManager;
