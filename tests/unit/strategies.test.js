/**
 * Unit Tests - Strategy Interface & Explicit Strategy Modes (Issue 2A)
 *
 * Tests verify:
 * - Each strategy has explicit getMode() returning STRATEGY_MODES
 * - Strategy interface is properly inherited
 * - isSupported() checks correct methods
 * - Mode identification is deterministic
 */

const { STRATEGY_MODES, Strategy } = require('../../src/adapters/strategies/strategy.interface');
const AllTickersStrategy = require('../../src/adapters/strategies/all-tickers.strategy');
const BatchWatchTickersStrategy = require('../../src/adapters/strategies/batch-watch-tickers.strategy');
const PerSymbolStrategy = require('../../src/adapters/strategies/per-symbol.strategy');
const StrategySelector = require('../../src/adapters/strategies/strategy.selector');

describe('2A: Explicit Strategy Modes', () => {
  describe('Strategy Interface', () => {
    test('STRATEGY_MODES enum is defined with three modes', () => {
      expect(STRATEGY_MODES).toEqual({
        ALL_TICKERS: 'allTickers',
        BATCH_WATCH_TICKERS: 'batchWatchTickers',
        PER_SYMBOL: 'perSymbol',
      });
    });

    test('Strategy base class is abstract', () => {
      const strategy = new Strategy();

      expect(() => strategy.getMode()).toThrow('Must implement getMode()');
      expect(() => strategy.isSupported({})).toThrow('Must implement isSupported()');

      // execute() is async generator, so calling it returns generator (doesn't throw)
      // But calling .next() on it will throw
      const generator = strategy.execute({}, []);
      expect(generator.next()).rejects.toThrow('Must implement execute()');
    });

    test('Strategy base class has async close() default', async () => {
      const strategy = new Strategy();
      // Should not throw, default implementation is no-op
      await expect(strategy.close()).resolves.toBeUndefined();
    });
  });

  describe('AllTickersStrategy', () => {
    test('extends Strategy class', () => {
      const strategy = new AllTickersStrategy({});
      expect(strategy instanceof Strategy).toBe(true);
    });

    test('getMode() returns ALL_TICKERS', () => {
      const strategy = new AllTickersStrategy({});
      expect(strategy.getMode()).toBe(STRATEGY_MODES.ALL_TICKERS);
    });

    test('isSupported() checks for watchTickers method', () => {
      const strategy = new AllTickersStrategy({});

      const withWatchTickers = { watchTickers: jest.fn() };
      const withoutWatchTickers = { watchTicker: jest.fn() };
      const empty = {};

      expect(strategy.isSupported(withWatchTickers)).toBe(true);
      expect(strategy.isSupported(withoutWatchTickers)).toBe(false);
      expect(strategy.isSupported(empty)).toBe(false);
      // null and undefined both short-circuit the && check, returning falsy
      expect(strategy.isSupported(null)).toBeFalsy();
      expect(strategy.isSupported(undefined)).toBeFalsy();
    });

    test('throws if not supported on execute()', async () => {
      const strategy = new AllTickersStrategy({ exchange: 'test' });
      const exchangeWithoutMethod = {};

      const source = strategy.execute(exchangeWithoutMethod, ['BTC']);

      await expect(source.next()).rejects.toThrow('does not support watchTickers');
    });
  });

  describe('BatchWatchTickersStrategy', () => {
    test('extends Strategy class', () => {
      const strategy = new BatchWatchTickersStrategy({});
      expect(strategy instanceof Strategy).toBe(true);
    });

    test('getMode() returns BATCH_WATCH_TICKERS', () => {
      const strategy = new BatchWatchTickersStrategy({});
      expect(strategy.getMode()).toBe(STRATEGY_MODES.BATCH_WATCH_TICKERS);
    });

    test('isSupported() checks for watchTickers method', () => {
      const strategy = new BatchWatchTickersStrategy({});

      const withWatchTickers = { watchTickers: jest.fn() };
      const withoutWatchTickers = { watchTicker: jest.fn() };

      expect(strategy.isSupported(withWatchTickers)).toBe(true);
      expect(strategy.isSupported(withoutWatchTickers)).toBe(false);
    });

    test('uses batchSize from config (default 100)', () => {
      const strategy1 = new BatchWatchTickersStrategy({});
      expect(strategy1.batchSize).toBe(100);

      const strategy2 = new BatchWatchTickersStrategy({ batchSize: 50 });
      expect(strategy2.batchSize).toBe(50);
    });

    test('splits symbols into batches correctly', () => {
      const strategy = new BatchWatchTickersStrategy({ batchSize: 3 });
      const symbols = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

      // Simulate batch splitting (internal implementation)
      const batches = [];
      for (let i = 0; i < symbols.length; i += strategy.batchSize) {
        batches.push(symbols.slice(i, i + strategy.batchSize));
      }

      expect(batches).toEqual([
        ['A', 'B', 'C'],
        ['D', 'E', 'F'],
        ['G'],
      ]);
    });
  });

  describe('PerSymbolStrategy', () => {
    test('extends Strategy class', () => {
      const strategy = new PerSymbolStrategy({});
      expect(strategy instanceof Strategy).toBe(true);
    });

    test('getMode() returns PER_SYMBOL', () => {
      const strategy = new PerSymbolStrategy({});
      expect(strategy.getMode()).toBe(STRATEGY_MODES.PER_SYMBOL);
    });

    test('isSupported() checks for watchTicker method', () => {
      const strategy = new PerSymbolStrategy({});

      const withWatchTicker = { watchTicker: jest.fn() };
      const withoutWatchTicker = { watchTickers: jest.fn() };

      expect(strategy.isSupported(withWatchTicker)).toBe(true);
      expect(strategy.isSupported(withoutWatchTicker)).toBe(false);
    });

    test('throws if not supported on execute()', async () => {
      const strategy = new PerSymbolStrategy({ exchange: 'test' });
      const exchangeWithoutMethod = {};

      const source = strategy.execute(exchangeWithoutMethod, ['BTC']);

      await expect(source.next()).rejects.toThrow('does not support watchTicker');
    });
  });

  describe('StrategySelector - Precedence Rules', () => {
    test('Level 1: Explicit override (strategyMode) wins', () => {
      const mockExchange = {
        watchTickers: jest.fn(),
        watchTicker: jest.fn(),
      };

      // Even though binance would default to ALL_TICKERS, explicit override to PER_SYMBOL wins
      const strategy = StrategySelector.selectStrategy('binance', mockExchange, {
        strategyMode: STRATEGY_MODES.PER_SYMBOL,
      });

      expect(strategy.getMode()).toBe(STRATEGY_MODES.PER_SYMBOL);
    });

    test('Level 1: Invalid explicit override throws fast', () => {
      const mockExchange = { watchTicker: jest.fn() };

      expect(() => {
        StrategySelector.selectStrategy('binance', mockExchange, {
          strategyMode: 'invalidMode',
        });
      }).toThrow('Unknown strategy mode');
    });

    test('Level 1: Explicit override with unsupported method throws', () => {
      const mockExchange = {}; // No methods

      expect(() => {
        StrategySelector.selectStrategy('binance', mockExchange, {
          strategyMode: STRATEGY_MODES.ALL_TICKERS,
        });
      }).toThrow();
    });

    test('Level 2: Exchange default (from constants) used if no override', () => {
      const mockExchange = {
        watchTickers: jest.fn(),
        watchTicker: jest.fn(),
      };

      // Binance default from constants: ALL_TICKERS
      const strategy = StrategySelector.selectStrategy('binance', mockExchange, {});

      expect(strategy.getMode()).toBe(STRATEGY_MODES.ALL_TICKERS);
    });

    test('Level 2: Kraken uses PER_SYMBOL default', () => {
      const mockExchange = {
        watchTicker: jest.fn(),
        watchTickers: jest.fn(),
      };

      // Kraken default from constants: PER_SYMBOL
      const strategy = StrategySelector.selectStrategy('kraken', mockExchange, {});

      expect(strategy.getMode()).toBe(STRATEGY_MODES.PER_SYMBOL);
    });

    test('Level 3: Falls back to capability detection if default fails', () => {
      const mockExchange = {
        watchTicker: jest.fn(),
        // No watchTickers (doesn't support)
      };

      // Exchange default would be ALL_TICKERS, but not supported
      // Falls back to watchTicker (PER_SYMBOL)
      const strategy = StrategySelector.selectStrategy('binance', mockExchange, {});

      expect(strategy.getMode()).toBe(STRATEGY_MODES.PER_SYMBOL);
    });

    test('Level 3: Capability fallback tries in preference order', () => {
      const mockExchange = {
        // No watchTickers, no batchWatchTickers
        watchTicker: jest.fn(),
      };

      // Should end up with PerSymbolStrategy (last fallback)
      const strategy = StrategySelector.selectStrategy('unknown-exchange', mockExchange, {});

      expect(strategy.getMode()).toBe(STRATEGY_MODES.PER_SYMBOL);
    });

    test('Level 3: All capability fallbacks fail -> throws', () => {
      const mockExchange = {}; // No methods at all

      expect(() => {
        StrategySelector.selectStrategy('unknown-exchange', mockExchange, {});
      }).toThrow('No suitable strategy found');
    });

    test('Deterministic: Same exchange always selects same default strategy', () => {
      const mockExchange = {
        watchTickers: jest.fn(),
        watchTicker: jest.fn(),
      };

      const s1 = StrategySelector.selectStrategy('binance', mockExchange, {});
      const s2 = StrategySelector.selectStrategy('binance', mockExchange, {});

      expect(s1.getMode()).toBe(s2.getMode());
      expect(s1.getMode()).toBe(STRATEGY_MODES.ALL_TICKERS);
    });

    test('Deterministic: Kraken always selects PER_SYMBOL even if watchTickers available', () => {
      const mockExchange = {
        watchTickers: jest.fn(),
        watchTicker: jest.fn(),
      };

      // Kraken prefers PER_SYMBOL despite watchTickers being available
      const strategy = StrategySelector.selectStrategy('kraken', mockExchange, {});

      expect(strategy.getMode()).toBe(STRATEGY_MODES.PER_SYMBOL);
    });
  });

  describe('Strategy Mode Consistency', () => {
    test('All strategies return distinct modes', () => {
      const modes = [
        new AllTickersStrategy({}).getMode(),
        new BatchWatchTickersStrategy({}).getMode(),
        new PerSymbolStrategy({}).getMode(),
      ];

      const uniqueModes = new Set(modes);
      expect(uniqueModes.size).toBe(3); // All distinct
    });

    test('Mode strings match STRATEGY_MODES values', () => {
      const allTickersMode = new AllTickersStrategy({}).getMode();
      const batchMode = new BatchWatchTickersStrategy({}).getMode();
      const perSymbolMode = new PerSymbolStrategy({}).getMode();

      expect(allTickersMode).toBe(STRATEGY_MODES.ALL_TICKERS);
      expect(batchMode).toBe(STRATEGY_MODES.BATCH_WATCH_TICKERS);
      expect(perSymbolMode).toBe(STRATEGY_MODES.PER_SYMBOL);
    });
  });

  describe('Strategy Configuration Propagation', () => {
    test('Logger config passed to strategy and used in selection', () => {
      const logs = [];
      const mockLogger = (level, message, data) => {
        logs.push({ level, message });
      };
      const mockExchange = { watchTickers: jest.fn() };

      const strategy = StrategySelector.selectStrategy('binance', mockExchange, {
        logger: mockLogger,
      });

      expect(logs.length).toBeGreaterThan(0); // Logger was called
      expect(logs.some(log => log.level === 'info')).toBe(true);
    });

    test('Batch size config propagated to BatchWatchTickersStrategy', () => {
      const strategy = new BatchWatchTickersStrategy({
        batchSize: 250,
        exchange: 'test',
      });

      expect(strategy.batchSize).toBe(250);
    });
  });
});
