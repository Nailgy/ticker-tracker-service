const MarketRegistry = require('../../src/core/market.registry');

describe('MarketRegistry', () => {
  let registry;
  let mockAdapter;
  let mockLogger;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = jest.fn();
    mockAdapter = {
      loadMarkets: jest.fn().mockResolvedValue([
        { symbol: 'BTC/USDT', active: true, spot: true, swap: false },
        { symbol: 'ETH/USDT', active: true, spot: true, swap: false },
        { symbol: 'BNB/USDT', active: true, spot: true, swap: false },
      ]),
    };

    registry = new MarketRegistry({ logger: mockLogger });
  });

  describe('initialization', () => {
    it('should initialize with empty state', () => {
      expect(registry.getDesiredSymbols().size).toBe(0);
      expect(registry.getActiveSymbols().size).toBe(0);
      expect(registry.getNonRetryableSymbols().size).toBe(0);
    });

    it('should track metrics counters', () => {
      const metrics = registry.getMetrics();
      expect(metrics.desiredCount).toBe(0);
      expect(metrics.activeCount).toBe(0);
      expect(metrics.nonRetryableCount).toBe(0);
    });

    it('should handle logger configuration', () => {
      const customRegistry = new MarketRegistry({ logger: mockLogger });
      expect(customRegistry.config.logger).toBe(mockLogger);
    });
  });

  describe('symbol lifecycle', () => {
    it('should load desired markets from adapter', async () => {
      const result = await registry.loadDesiredMarkets(mockAdapter);

      expect(result.symbols).toEqual(['BTC/USDT', 'ETH/USDT', 'BNB/USDT']);
      expect(registry.getDesiredSymbols().size).toBe(3);
      expect(result.count).toBe(3);
    });

    it('should add symbols to active tracking', () => {
      const result = registry.addSymbols(['BTC/USDT', 'ETH/USDT']);

      expect(result.added).toEqual(['BTC/USDT', 'ETH/USDT']);
      expect(registry.getActiveSymbols().size).toBe(2);
      expect(result.existingCount).toBe(2);
    });

    it('should remove symbols from active tracking', () => {
      registry.addSymbols(['BTC/USDT', 'ETH/USDT']);
      const result = registry.removeSymbols(['BTC/USDT']);

      expect(result.removed).toEqual(['BTC/USDT']);
      expect(registry.getActiveSymbols().size).toBe(1);
      expect(registry.getActiveSymbols().has('ETH/USDT')).toBe(true);
    });

    it('should mark symbols as non-retryable', () => {
      registry.addSymbols(['BTC/USDT', 'ETH/USDT']);
      const result = registry.markNonRetryable(['BTC/USDT']);

      expect(result.marked).toEqual(['BTC/USDT']);
      expect(registry.getNonRetryableSymbols().has('BTC/USDT')).toBe(true);
      expect(registry.getActiveSymbols().has('BTC/USDT')).toBe(false);
    });

    it('should maintain state consistency (no symbol in multiple states)', () => {
      registry.addSymbols(['BTC/USDT', 'ETH/USDT']);
      registry.markNonRetryable(['BTC/USDT']);

      const active = registry.getActiveSymbols();
      const nonRetryable = registry.getNonRetryableSymbols();

      const intersection = [...active].filter(s => nonRetryable.has(s));
      expect(intersection.length).toBe(0);
    });

    it('should be idempotent on removal of non-existent symbols', () => {
      registry.addSymbols(['BTC/USDT']);
      const result = registry.removeSymbols(['NON/EXISTENT']);

      expect(result.removed).toEqual([]);
      expect(registry.getActiveSymbols().size).toBe(1);
    });

    it('should not crash on double removal', () => {
      registry.addSymbols(['BTC/USDT']);
      registry.removeSymbols(['BTC/USDT']);

      expect(() => registry.removeSymbols(['BTC/USDT'])).not.toThrow();
      expect(registry.getActiveSymbols().size).toBe(0);
    });

    it('should re-enable non-retryable symbol when re-added', () => {
      registry.addSymbols(['BTC/USDT']);
      registry.markNonRetryable(['BTC/USDT']);
      registry.addSymbols(['BTC/USDT']);

      expect(registry.getActiveSymbols().has('BTC/USDT')).toBe(true);
      expect(registry.getNonRetryableSymbols().has('BTC/USDT')).toBe(false);
    });
  });

  describe('batch allocation', () => {
    beforeEach(() => {
      registry.addSymbols(['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'XRP/USDT']);
    });

    it('should distribute symbols round-robin', () => {
      const result = registry.allocateToBatches(['b1', 'b2']);

      expect(result.totalSymbols).toBe(4);
      expect(result.batches).toBe(2);

      const allocations = registry.getAllocationsAsArray();
      expect(allocations.length).toBe(2);
    });

    it('should allocate all symbols exactly once', () => {
      registry.allocateToBatches(['b1', 'b2', 'b3']);

      let totalAllocated = 0;
      const allocations = registry.getAllocationsAsArray();
      for (const batch of allocations) {
        totalAllocated += batch.count;
      }

      expect(totalAllocated).toBe(4);
    });

    it('should balance distribution across batches', () => {
      registry.allocateToBatches(['b1', 'b2', 'b3']);

      const allocations = registry.getAllocationsAsArray();
      const counts = allocations.map(b => b.count);

      // For 4 symbols and 3 batches: [2, 1, 1] or similar distribution
      const maxDiff = Math.max(...counts) - Math.min(...counts);
      expect(maxDiff).toBeLessThanOrEqual(1);
    });

    it('should survive symbol removal', () => {
      registry.allocateToBatches(['b1', 'b2']);
      registry.removeSymbols(['BTC/USDT']);

      const allocations = registry.getAllocationsAsArray();
      let totalAllocated = 0;
      for (const batch of allocations) {
        totalAllocated += batch.count;
        expect(batch.symbols).not.toContain('BTC/USDT');
      }

      expect(totalAllocated).toBe(3);
    });

    it('should re-allocate after new symbols added', () => {
      registry.allocateToBatches(['b1', 'b2']);
      registry.addSymbols(['SOL/USDT', 'ADA/USDT']);
      registry.allocateToBatches(['b1', 'b2']);

      let totalAllocated = 0;
      const allocations = registry.getAllocationsAsArray();
      for (const batch of allocations) {
        totalAllocated += batch.count;
      }

      expect(totalAllocated).toBe(6);
    });
  });

  describe('state queries', () => {
    it('should return copy of desired symbols (not reference)', () => {
      registry.addSymbols(['BTC/USDT']);
      const copy1 = registry.getDesiredSymbols();
      copy1.add('FAKE/USDT');

      const copy2 = registry.getDesiredSymbols();
      expect(copy2.has('FAKE/USDT')).toBe(false);
    });

    it('should return copy of active symbols (not reference)', () => {
      registry.addSymbols(['BTC/USDT']);
      const copy1 = registry.getActiveSymbols();
      copy1.add('FAKE/USDT');

      const copy2 = registry.getActiveSymbols();
      expect(copy2.has('FAKE/USDT')).toBe(false);
    });

    it('should return copy of non-retryable symbols (not reference)', () => {
      registry.addSymbols(['BTC/USDT']);
      registry.markNonRetryable(['BTC/USDT']);

      const copy1 = registry.getNonRetryableSymbols();
      copy1.add('FAKE/USDT');

      const copy2 = registry.getNonRetryableSymbols();
      expect(copy2.has('FAKE/USDT')).toBe(false);
    });
  });

  describe('diff detection', () => {
    it('should detect additions via getDiffSince', async () => {
      const previousState = {
        desiredSymbols: new Set(['BTC/USDT']),
      };

      await registry.loadDesiredMarkets(mockAdapter);
      const diff = registry.getDiffSince(previousState);

      expect(diff.added).toContain('ETH/USDT');
      expect(diff.added).toContain('BNB/USDT');
    });

    it('should detect removals via getDiffSince', async () => {
      const previousState = {
        desiredSymbols: new Set(['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'XRP/USDT']),
      };

      await registry.loadDesiredMarkets(mockAdapter);
      const diff = registry.getDiffSince(previousState);

      expect(diff.removed).toContain('XRP/USDT');
    });

    it('should return empty diff when no changes', async () => {
      await registry.loadDesiredMarkets(mockAdapter);
      const state1 = { desiredSymbols: registry.getDesiredSymbols() };

      const diff = registry.getDiffSince(state1);
      expect(diff.added.length).toBe(0);
      expect(diff.removed.length).toBe(0);
    });
  });

  describe('metrics', () => {
    it('should track metrics accurately', () => {
      registry.addSymbols(['BTC/USDT', 'ETH/USDT']);
      registry.markNonRetryable(['BTC/USDT']);
      registry.allocateToBatches(['b1', 'b2']);

      const metrics = registry.getMetrics();

      expect(metrics.activeCount).toBe(1);
      expect(metrics.nonRetryableCount).toBe(1);
      expect(metrics.batchAllocations).toBe(2);
    });

    it('should return copy of metrics (not reference)', () => {
      const metrics1 = registry.getMetrics();
      metrics1.activeCount = 999;

      const metrics2 = registry.getMetrics();
      expect(metrics2.activeCount).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should throw when adapter fails to load markets', async () => {
      const failingAdapter = {
        loadMarkets: jest.fn().mockRejectedValueOnce(new Error('Network error')),
      };

      await expect(registry.loadDesiredMarkets(failingAdapter)).rejects.toThrow(
        'Network error'
      );
    });

    it('should handle empty symbol arrays gracefully', () => {
      const result = registry.addSymbols([]);
      expect(result.added).toEqual([]);
      expect(result.existingCount).toBe(0);
    });

    it('should handle null/undefined symbol arrays', () => {
      expect(() => registry.addSymbols(null)).not.toThrow();
      expect(() => registry.addSymbols(undefined)).not.toThrow();
    });
  });
});
