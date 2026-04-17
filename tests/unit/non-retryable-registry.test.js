/**
 * NonRetryableRegistry Unit Tests
 *
 * Tests metadata tracking, eviction audit trail, statistics
 */

const NonRetryableRegistry = require('../../src/core/non-retryable-registry');

describe('NonRetryableRegistry', () => {
  let registry;
  const mockLogger = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    registry = new NonRetryableRegistry({ logger: mockLogger });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Initialization', () => {
    test('should initialize with empty registry', () => {
      expect(registry.symbolsRegistry.size).toBe(0);
    });
  });

  describe('Symbol Eviction', () => {
    test('should mark symbol as non-retryable', () => {
      registry.markNonRetryable('BTC/USDT', 'INVALID_SYMBOL');

      expect(registry.symbolsRegistry.has('BTC/USDT')).toBe(true);
    });

    test('should track eviction reason', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED');

      const record = registry.getSymbolRecord('BTC/USDT');
      expect(record.reason).toBe('DELISTED');
    });

    test('should track first eviction time', () => {
      const before = Date.now();
      registry.markNonRetryable('BTC/USDT', 'INVALID');
      const after = Date.now();

      const record = registry.getSymbolRecord('BTC/USDT');
      expect(record.firstSeen).toBeGreaterThanOrEqual(before);
      expect(record.firstSeen).toBeLessThanOrEqual(after);
    });

    test('should track eviction metadata', () => {
      const metadata = {
        batchId: 'batch-0',
        errorMessage: 'symbol not found',
        attempt: 5,
      };

      registry.markNonRetryable('BTC/USDT', 'NOT_FOUND', metadata);

      const record = registry.getSymbolRecord('BTC/USDT');
      expect(record.metadata).toEqual(metadata);
    });

    test('should mark multiple symbols', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED');
      registry.markNonRetryable('ETH/USDT', 'SUSPENDED');
      registry.markNonRetryable('SCAM/USDT', 'INVALID');

      expect(registry.symbolsRegistry.size).toBe(3);
    });
  });

  describe('Symbol Records', () => {
    test('should retrieve symbol record', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED', { batchId: 'batch-0' });

      const record = registry.getSymbolRecord('BTC/USDT');

      expect(record).toBeDefined();
      expect(record.symbol).toBe('BTC/USDT');
      expect(record.reason).toBe('DELISTED');
      expect(record.metadata.batchId).toBe('batch-0');
    });

    test('should return null for unknown symbol', () => {
      const record = registry.getSymbolRecord('UNKNOWN/USDT');
      expect(record).toBeNull();
    });

    test('should include attempt count in record', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED', { attempts: 3 });

      const record = registry.getSymbolRecord('BTC/USDT');
      expect(record.metadata.attempts).toBe(3);
    });
  });

  describe('Query Methods', () => {
    test('should check if symbol is non-retryable', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED');

      expect(registry.isNonRetryable('BTC/USDT')).toBe(true);
      expect(registry.isNonRetryable('ETH/USDT')).toBe(false);
    });

    test('should get all non-retryable symbols', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED');
      registry.markNonRetryable('ETH/USDT', 'SUSPENDED');
      registry.markNonRetryable('SCAM/USDT', 'INVALID');

      const symbols = registry.getAllNonRetryableSymbols();

      expect(symbols.length).toBe(3);
      expect(symbols).toContain('BTC/USDT');
      expect(symbols).toContain('ETH/USDT');
      expect(symbols).toContain('SCAM/USDT');
    });
  });

  describe('Statistics', () => {
    test('should return stats for non-retryable symbols', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED');
      registry.markNonRetryable('ETH/USDT', 'DELISTED');
      registry.markNonRetryable('SCAM/USDT', 'INVALID');

      const stats = registry.getStats();

      expect(stats.totalNonRetryable).toBe(3);
      expect(stats.byReason.DELISTED).toBe(2);
      expect(stats.byReason.INVALID).toBe(1);
    });

    test('should break down stats by reason', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED');
      registry.markNonRetryable('ETH/USDT', 'DELISTED');
      registry.markNonRetryable('SCAM/USDT', 'SUSPENDED');
      registry.markNonRetryable('BAD/USDT', 'INVALID');

      const stats = registry.getStats();

      expect(stats.byReason.DELISTED).toBe(2);
      expect(stats.byReason.SUSPENDED).toBe(1);
      expect(stats.byReason.INVALID).toBe(1);
    });

    test('should break down stats by batch', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED', { batchId: 'batch-0' });
      registry.markNonRetryable('ETH/USDT', 'DELISTED', { batchId: 'batch-0' });
      registry.markNonRetryable('SCAM/USDT', 'INVALID', { batchId: 'batch-1' });

      const stats = registry.getStats();

      expect(stats.byBatch['batch-0']).toBe(2);
      expect(stats.byBatch['batch-1']).toBe(1);
    });

    test('should provide stats structure', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED');
      registry.markNonRetryable('ETH/USDT', 'DELISTED');

      const stats = registry.getStats();

      expect(stats).toHaveProperty('totalNonRetryable');
      expect(stats).toHaveProperty('byReason');
      expect(stats).toHaveProperty('byBatch');
      expect(stats).toHaveProperty('totalAttempts');
      expect(stats.totalNonRetryable).toBe(2);
    });
  });

  describe('Reason Categories', () => {
    test('should handle common eviction reasons', () => {
      const reasons = ['DELISTED', 'SUSPENDED', 'INVALID_SYMBOL', 'NOT_FOUND'];

      reasons.forEach((reason, i) => {
        registry.markNonRetryable(`COIN${i}/USDT`, reason);
      });

      const stats = registry.getStats();

      reasons.forEach(reason => {
        expect(stats.byReason[reason]).toBe(1);
      });
    });
  });

  describe('Lifecycle', () => {
    test('should support complete lifecycle: mark, query, stats', () => {
      // Mark symbols
      registry.markNonRetryable('BTC/USDT', 'DELISTED', { batchId: 'batch-0' });
      registry.markNonRetryable('ETH/USDT', 'SUSPENDED', { batchId: 'batch-1' });

      // Query
      expect(registry.isNonRetryable('BTC/USDT')).toBe(true);
      expect(registry.getAllNonRetryableSymbols().length).toBe(2);

      // Stats
      const stats = registry.getStats();
      expect(stats.totalNonRetryable).toBe(2);
      expect(stats.byReason.DELISTED).toBe(1);
    });

    test('should maintain consistency across operations', () => {
      registry.markNonRetryable('BTC/USDT', 'DELISTED');
      registry.markNonRetryable('ETH/USDT', 'DELISTED');

      // Get from different query methods
      const allSymbols = registry.getAllNonRetryableSymbols();
      const stats = registry.getStats();

      expect(allSymbols.length).toBe(stats.totalNonRetryable);
    });
  });

  describe('Metadata Tracking', () => {
    test('should track detailed metadata per symbol', () => {
      const metadata = {
        batchId: 'batch-0',
        errorMessage: 'symbol not found',
        attempt: 5,
        originalError: 'ExchangeNotAvailable',
        timestamp: Date.now(),
      };

      registry.markNonRetryable('BTC/USDT', 'DELISTED', metadata);

      const record = registry.getSymbolRecord('BTC/USDT');

      expect(record.metadata).toEqual(metadata);
      expect(record.metadata.attempt).toBe(5);
      expect(record.metadata.originalError).toBe('ExchangeNotAvailable');
    });
  });
});
