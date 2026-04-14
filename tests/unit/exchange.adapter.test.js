/**
 * ExchangeAdapter Unit Tests
 *
 * Tests abstract adapter interface and error handling for unimplemented methods
 */

const ExchangeAdapter = require('../../src/adapters/exchange.adapter');

describe('ExchangeAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new ExchangeAdapter();
  });

  describe('Abstract Methods', () => {
    test('should throw when initialize() not implemented', async () => {
      await expect(adapter.initialize()).rejects.toThrow('initialize() must be implemented by subclass');
    });

    test('should throw when loadMarkets() not implemented', async () => {
      await expect(adapter.loadMarkets()).rejects.toThrow('loadMarkets() must be implemented by subclass');
    });

    test('should throw when subscribe() not implemented', async () => {
      const gen = adapter.subscribe(['BTC/USDT']);
      await expect(gen.next()).rejects.toThrow('subscribe() must be implemented by subclass');
    });

    test('should throw when close() not implemented', async () => {
      await expect(adapter.close()).rejects.toThrow('close() must be implemented by subclass');
    });

    test('should throw when isWatchTickersSupported() not implemented', () => {
      expect(() => adapter.isWatchTickersSupported()).toThrow(
        'isWatchTickersSupported() must be implemented by subclass'
      );
    });

    test('should throw when getMetrics() not implemented', () => {
      expect(() => adapter.getMetrics()).toThrow('getMetrics() must be implemented by subclass');
    });

    test('should throw when getExchangeId() not implemented', () => {
      expect(() => adapter.getExchangeId()).toThrow('getExchangeId() must be implemented by subclass');
    });

    test('should throw when getMarketType() not implemented', () => {
      expect(() => adapter.getMarketType()).toThrow('getMarketType() must be implemented by subclass');
    });
  });

  describe('Concrete Implementation Requirements', () => {
    test('should be instantiable (abstract class)', () => {
      expect(adapter).toBeInstanceOf(ExchangeAdapter);
    });

    test('should have all required methods', () => {
      expect(typeof adapter.initialize).toBe('function');
      expect(typeof adapter.loadMarkets).toBe('function');
      expect(typeof adapter.subscribe).toBe('function');
      expect(typeof adapter.close).toBe('function');
      expect(typeof adapter.isWatchTickersSupported).toBe('function');
      expect(typeof adapter.getExchangeId).toBe('function');
      expect(typeof adapter.getMarketType).toBe('function');
      expect(typeof adapter.getMetrics).toBe('function');
    });

    test('should allow subclassing', () => {
      class ConcreteAdapter extends ExchangeAdapter {
        async initialize() {
          return true;
        }

        async loadMarkets() {
          return [];
        }

        async *subscribe() {
          yield { symbol: 'BTC/USDT', ticker: {} };
        }

        async close() {
          return true;
        }

        isWatchTickersSupported() {
          return true;
        }

        getExchangeId() {
          return 'binance';
        }

        getMarketType() {
          return 'spot';
        }

        getMetrics() {
          return {};
        }
      }

      const concrete = new ConcreteAdapter();
      expect(concrete).toBeInstanceOf(ExchangeAdapter);
    });

    test('should allow partial override', () => {
      class PartialAdapter extends ExchangeAdapter {
        async initialize() {
          return true;
        }
      }

      const partial = new PartialAdapter();
      expect(partial.initialize()).resolves.toBe(true);
    });
  });
});
