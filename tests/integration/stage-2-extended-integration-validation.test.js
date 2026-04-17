/**
 * Stage 2 Extended: Integration & Validation Tests
 *
 * Comprehensive test suite for per-batch connection isolation, fairness mechanisms,
 * and recovery validation.
 *
 * All 5 UC (use case) tests integrated as Jest tests:
 * - UC1: Promise.race() poisoning prevention (per-symbol fairness)
 * - UC2: Per-batch adapter isolation (blast radius)
 * - UC3: Lifecycle state preservation (refreshMarkets)
 * - UC4: Mid-flight symbol delisting self-healing
 * - UC5: Memory leak check (accordion effect)
 */

const ConnectionManager = require('../../src/core/connection.manager');
const PerSymbolStrategy = require('../../src/adapters/strategies/per-symbol.strategy');

// ============================================================================
// UC1: Promise.race() Poison Bug - Per-Symbol Error Isolation
// ============================================================================
describe('Stage 2 - UC1: Promise.race() Poison Prevention', () => {
  test('healthy symbols bypass fast-failing symbols in promise race', async () => {
    const mockExchange = {
      watchTicker: async (symbol) => {
        if (symbol === 'SCAM/USDT') {
          throw new Error('API Glitch on SCAM/USDT');
        }
        // Healthy symbols have 100ms latency to act slowly
        await new Promise(r => setTimeout(r, 100));
        return {
          symbol,
          last: 100 + Math.random() * 10,
          bid: 99 + Math.random() * 10,
          ask: 101 + Math.random() * 10,
          timestamp: Date.now(),
        };
      },
    };

    const strategy = new PerSymbolStrategy({
      exchange: 'binance',
      logger: () => {},
    });

    const output = [];
    const startTime = Date.now();

    try {
      // Run strategy for 2 seconds
      for await (const { symbol, ticker } of strategy.execute(mockExchange, [
        'BTC/USDT',
        'ETH/USDT',
        'SCAM/USDT',
      ])) {
        output.push({ symbol, ticker });

        if (Date.now() - startTime > 2000) {
          break;
        }
      }
    } catch (error) {
      // Expected some warnings about SCAM failures
    }

    await strategy.close();

    // ✅ SUCCESS: Healthy symbols produced tickers despite SCAM failure
    expect(output.length).toBeGreaterThan(0);

    const uniqueSymbols = [...new Set(output.map(t => t.symbol))];
    const healthySymbols = uniqueSymbols.filter(s => s !== 'SCAM/USDT');

    expect(healthySymbols.length).toBeGreaterThan(0);
    expect(uniqueSymbols).toContain('BTC/USDT');
    expect(uniqueSymbols).toContain('ETH/USDT');
  });
});

// ============================================================================
// UC2: Blast Radius Isolation - Per-Batch Adapter Isolation
// ============================================================================
describe('Stage 2 - UC2: Per-Batch Adapter Isolation (Blast Radius)', () => {
  test('batch adapter crash does not affect other batches', async () => {
    let adapterInstancesCount = 0;
    const adapters = [];

    const mockAdapterFactory = () => {
      adapterInstancesCount++;
      const adapterId = `Adapter-${adapterInstancesCount}`;
      const adapter = {
        id: 'binance',
        marketType: 'spot',
        name: adapterId,
        isClosed: false,
        initialize: async () => {},
        loadMarkets: async () => [
          { symbol: 'A/USDT' },
          { symbol: 'B/USDT' },
          { symbol: 'C/USDT' },
          { symbol: 'D/USDT' },
        ],

        // Stage 2: Engine expects `subscribe` as an async generator!
        subscribe: async function*(symbols) {
          if (this.isClosed) throw new Error(`${this.name} is Closed!`);

          // SIMULATE CRASH: Kill adapter ONLY if it serves batch with 'A/USDT'
          if (symbols.includes('A/USDT') && !this.crashed) {
            this.isClosed = true;
            this.crashed = true; // Prevent spam
            throw new Error('Fatal Socket Crash');
          }

          // For other batches (with C/USDT) everything works fine
          let iteration = 0;
          while (!this.isClosed) {
            await new Promise(r => setTimeout(r, 200));
            if (iteration++ > 5) break; // Prevent infinite loop
            yield { symbol: symbols[0], ticker: { last: 1 } };
          }
        },

        hasCapability: () => true,
        close: async function() {
          this.isClosed = true;
        },

        // Utility methods needed by SubscriptionEngine
        getMetrics: () => ({}),
        getExchangeId: () => 'binance',
        getMarketType: () => 'spot',
      };
      adapters.push(adapter);
      return adapter;
    };

    const mockRedis = {
      isReady: () => true,
      pipeline: () => ({
        hset: () => ({ publish: () => ({}) }),
        exec: async () => [],
      }),
    };

    const manager = new ConnectionManager({
      batchSize: 2, // 4 coins / 2 = 2 BATCHES
      strategyMode: 'BATCH_WATCH_TICKERS',
      redisService: mockRedis,
      adapterFactory: mockAdapterFactory,
      retryBaseDelayMs: 5000,
      logger: () => {},
    });

    await manager.initialize();
    await manager.startSubscriptions();

    // Give system time to process
    await new Promise(r => setTimeout(r, 1000));

    // ✅ SUCCESS: At least one adapter crashed and survived
    const crashedAdapters = adapters.filter(a => a.isClosed);
    const survivingAdapters = adapters.filter(
      a => !a.isClosed && a.crashed === undefined
    );

    expect(crashedAdapters.length).toBeGreaterThanOrEqual(1);
    expect(survivingAdapters.length).toBeGreaterThanOrEqual(1);

    await manager.stop();
  });
});

// ============================================================================
// UC3: Lifecycle State Preservation - refreshMarkets() safety
// ============================================================================
describe('Stage 2 - UC3: Lifecycle State Preservation', () => {
  test('refreshMarkets respects lifecycle state when engine not running', async () => {
    let loadMarketsCalls = 0;
    const mockAdapterFactory = () => ({
      id: 'binance',
      marketType: 'spot',
      initialize: async () => {},
      loadMarkets: async () => {
        loadMarketsCalls++;
        if (loadMarketsCalls > 1)
          return [
            { symbol: 'BTC/USDT' },
            { symbol: 'ETH/USDT' },
            { symbol: 'NEW_COIN/USDT' },
          ];
        return [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }];
      },
      hasCapability: () => true,
      close: async () => {},
    });

    const manager = new ConnectionManager({
      batchSize: 10,
      redisService: { isReady: () => true },
      adapterFactory: mockAdapterFactory,
      logger: () => {},
    });

    await manager.initialize();

    // ⚠️ We do NOT call manager.startSubscriptions()
    expect(manager.isRunning).toBe(false);

    // Call refreshMarkets - Exchange returns new coin
    await manager.refreshMarkets();

    // ✅ SUCCESS: State is preserved, not auto-started
    expect(manager.isRunning).toBe(false);

    const stats = manager.getStatus();
    expect(stats.engine.isRunning).toBe(false);
  });
});

// ============================================================================
// UC4: Mid-Flight Self-Healing - Symbol Delisting During Stream
// ============================================================================
describe('Stage 2 - UC4: Mid-Flight Symbol Delisting Self-Healing', () => {
  test('engine recovers when symbol is delisted mid-stream', async () => {
    const mockAdapterFactory = () => ({
      id: 'binance',
      marketType: 'spot',
      initialize: async () => {},
      loadMarkets: async () => [
        { symbol: 'BTC/USDT' },
        { symbol: 'ETH/USDT' },
        { symbol: 'DOOMED/USDT' },
      ],

      subscribe: async function*(symbols) {
        let iteration = 0;
        while (true) {
          iteration++;
          await new Promise(r => setTimeout(r, 100));

          if (iteration === 3 && symbols.includes('DOOMED/USDT')) {
            // Exchange delists DOOMED/USDT mid-stream
            const err = new Error(
              'binance does not have market symbol DOOMED/USDT'
            );
            err.name = 'BadSymbol';
            throw err;
          }

          for (const sym of symbols) {
            yield { symbol: sym, ticker: { last: 100 } };
          }
        }
      },

      hasCapability: () => true,
      close: async () => {},
    });

    const manager = new ConnectionManager({
      batchSize: 5,
      strategyMode: 'BATCH_WATCH_TICKERS',
      redisService: {
        isReady: () => true,
        pipeline: () => ({
          hset: () => ({ publish: () => ({}) }),
          exec: async () => [],
        }),
      },
      adapterFactory: mockAdapterFactory,
      logger: () => {},
    });

    await manager.initialize();
    await manager.startSubscriptions();

    // Give system time to process delisting
    await new Promise(r => setTimeout(r, 1000));

    const metrics = manager.getStatus().engine.metrics;

    // ✅ SUCCESS: Engine survived delisting
    expect(metrics.isRunning).toBe(true);
    expect(metrics.failedBatches).toBe(0);

    await manager.stop();
  });
});

// ============================================================================
// UC5: Memory Leak Check - Dynamic Market Scaling (Accordion Effect)
// ============================================================================
describe('Stage 2 - UC5: Memory Leak Prevention (Accordion Effect)', () => {
  test('adapter pool correctly removes adapters when markets shrink', async () => {
    let createdAdapters = 0;
    let closedAdapters = 0;

    // Dynamic exchange state
    let currentMarkets = Array.from({ length: 10 }, (_, i) => ({
      symbol: `COIN${i}/USDT`,
    }));

    const mockAdapterFactory = () => {
      createdAdapters++;
      return {
        id: 'binance',
        marketType: 'spot',
        initialize: async () => {},
        loadMarkets: async () => currentMarkets,
        subscribe: async function*(symbols) {
          let iterations = 0;
          while (iterations++ < 5) {
            await new Promise(r => setTimeout(r, 100));
            yield { symbol: symbols[0], ticker: {} };
          }
        },
        hasCapability: () => true,
        close: async () => {
          closedAdapters++;
        },
      };
    };

    const manager = new ConnectionManager({
      batchSize: 2, // 10 coins = 5 batches
      strategyMode: 'BATCH_WATCH_TICKERS',
      redisService: { isReady: () => true },
      adapterFactory: mockAdapterFactory,
      logger: () => {},
    });

    // Step 1: Initialize with 10 coins -> 5 batches
    await manager.initialize();
    await manager.startSubscriptions();
    await new Promise(r => setTimeout(r, 200));

    // Step 2: Market shrinks to 2 coins -> 1 batch
    currentMarkets = [
      { symbol: 'COIN1/USDT' },
      { symbol: 'COIN2/USDT' },
    ];
    await manager.refreshMarkets();
    await new Promise(r => setTimeout(r, 200));

    // Step 3: Market grows to 8 coins -> 4 batches
    currentMarkets = Array.from({ length: 8 }, (_, i) => ({
      symbol: `COIN${i}/USDT`,
    }));
    await manager.refreshMarkets();
    await new Promise(r => setTimeout(r, 200));

    // ✅ SUCCESS: Memory usage is correct
    // If we created N adapters, and currently have 4 active batches,
    // then we should have closed N - 4 (plus/minus 1 for REST adapter)
    const activeExpected = 4;
    const unaccounted = createdAdapters - closedAdapters - activeExpected;

    // Allow 1-2 adapters for utility or loadMarkets operations
    expect(unaccounted).toBeLessThanOrEqual(2);

    await manager.stop();
  });
});
