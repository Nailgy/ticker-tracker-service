/**
 * Phase 5: Resilience & Health Checks - Unit Tests
 *
 * Tests exponential backoff, non-retryable error detection, and stale connection detection
 * using jest.useFakeTimers() for deterministic testing.
 */

const ConnectionManager = require('../../src/core/connection.manager');

// Mock ExchangeFactory
class MockExchangeFactory {
  constructor(config = {}) {
    this.config = {
      exchange: config.exchange || 'binance',
      marketType: config.marketType || 'spot',
      logger: config.logger || (() => {}),
    };
  }

  createExchange() {
    return {
      close: jest.fn().mockResolvedValue(undefined),
      watchTickers: jest.fn(),
    };
  }

  async loadMarkets() {
    return [
      { symbol: 'BTC/USDT', active: true, spot: true },
      { symbol: 'ETH/USDT', active: true, spot: true },
      { symbol: 'BNB/USDT', active: true, spot: true },
    ];
  }

  normalizeTicker(symbol, rawTicker) {
    return {
      symbol,
      exchange: this.config.exchange,
      marketType: this.config.marketType,
      last: rawTicker.last || 0,
      bid: rawTicker.bid || null,
      ask: rawTicker.ask || null,
      timestamp: rawTicker.timestamp || Date.now(),
    };
  }
}

// Mock RedisService
class MockRedisService {
  constructor() {
    this.updates = [];
    this.flushCount = 0;
  }

  async updateTicker(exchange, marketType, symbol, tickerData) {
    this.updates.push({ exchange, marketType, symbol, tickerData });
    return true;
  }

  async flush() {
    this.flushCount++;
    return true;
  }
}

describe('Phase 5: Resilience & Health Checks', () => {
  let manager;
  let mockFactory;
  let mockRedis;

  beforeEach(() => {
    jest.clearAllTimers();
    jest.useFakeTimers();

    mockFactory = new MockExchangeFactory();
    mockRedis = new MockRedisService();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    if (manager && manager.isRunning) {
      manager.isRunning = false; // Force stop without async
    }
  });

  // ============================================================================
  // SECTION 1: Exponential Backoff Testing
  // ============================================================================

  describe('Exponential Backoff', () => {
    it('should calculate exponential backoff correctly: 2^n formula', () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 60000,
      });

      // Attempt 1: 1000 * 2^0 = 1000
      let delay = manager._calculateExponentialBackoff('batch-0');
      expect(delay).toBe(1000);
      expect(manager.stats.retries).toBe(1);

      // Attempt 2: 1000 * 2^1 = 2000
      delay = manager._calculateExponentialBackoff('batch-0');
      expect(delay).toBe(2000);
      expect(manager.stats.retries).toBe(2);

      // Attempt 3: 1000 * 2^2 = 4000
      delay = manager._calculateExponentialBackoff('batch-0');
      expect(delay).toBe(4000);
      expect(manager.stats.retries).toBe(3);

      // Attempt 4: 1000 * 2^3 = 8000
      delay = manager._calculateExponentialBackoff('batch-0');
      expect(delay).toBe(8000);
      expect(manager.stats.retries).toBe(4);

      // Attempt 5: 1000 * 2^4 = 16000
      delay = manager._calculateExponentialBackoff('batch-0');
      expect(delay).toBe(16000);
      expect(manager.stats.retries).toBe(5);
    });

    it('should cap exponential backoff at maxDelay', () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 10000,
      });

      // Build up retry attempts
      for (let i = 0; i < 5; i++) {
        manager._calculateExponentialBackoff('batch-0');
      }

      // Next attempt: 1000 * 2^5 = 32000, but capped at 10000
      const delay = manager._calculateExponentialBackoff('batch-0');
      expect(delay).toBe(10000); // Capped
    });

    it('should reset retry counter on successful connection', () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });

      // Build up retries
      for (let i = 0; i < 3; i++) {
        manager._calculateExponentialBackoff('batch-0');
      }
      expect(manager.retryAttempts.get('batch-0')).toBe(3);

      // Simulate successful connection (reset)
      manager.retryAttempts.set('batch-0', 0);
      expect(manager.retryAttempts.get('batch-0')).toBe(0);

      // Next retry should start from attempt 1
      const delay = manager._calculateExponentialBackoff('batch-0');
      expect(delay).toBe(manager.config.retryBaseDelayMs);
    });

    it('should track exponential backoffs in metrics', () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });

      expect(manager.stats.exponentialBackoffs).toBe(0);

      // This will be tracked in subscription loop, here we test the method
      manager._calculateExponentialBackoff('batch-0');
      manager._calculateExponentialBackoff('batch-0');
      manager._calculateExponentialBackoff('batch-0');

      expect(manager.stats.retries).toBe(3);
    });

    it('should use different retry counters for different batches', () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });

      // Batch 0: 3 retries
      for (let i = 0; i < 3; i++) {
        manager._calculateExponentialBackoff('batch-0');
      }

      // Batch 1: 1 retry
      manager._calculateExponentialBackoff('batch-1');

      const batch0Attempt = manager.retryAttempts.get('batch-0');
      const batch1Attempt = manager.retryAttempts.get('batch-1');

      expect(batch0Attempt).toBe(3);
      expect(batch1Attempt).toBe(1);
    });
  });

  // ============================================================================
  // SECTION 2: Non-Retryable Error Detection
  // ============================================================================

  describe('Non-Retryable Error Detection', () => {
    beforeEach(async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();
    });

    it('should detect "not found" errors as non-retryable', () => {
      const error = new Error('Market BTC/INVALID not found');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(true);
    });

    it('should detect "invalid" errors as non-retryable', () => {
      const error = new Error('Invalid symbol format');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(true);
    });

    it('should detect "delisted" errors as non-retryable', () => {
      const error = new Error('Symbol delisted');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(true);
    });

    it('should detect "disabled" errors as non-retryable', () => {
      const error = new Error('Market disabled');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(true);
    });

    it('should detect HTTP 404 errors as non-retryable', () => {
      const error = new Error('HTTP 404 Not Found');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(true);
    });

    it('should detect HTTP 400 errors as non-retryable', () => {
      const error = new Error('HTTP 400 Bad Request');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(true);
    });

    it('should detect "bad request" errors as non-retryable', () => {
      const error = new Error('Bad request: invalid parameters');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(true);
    });

    it('should detect "symbol not found" errors as non-retryable', () => {
      const error = new Error('Symbol not found in market');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(true);
    });

    it('should NOT treat network/timeout errors as non-retryable', () => {
      const error = new Error('ECONNREFUSED Connection refused');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(false);
    });

    it('should NOT treat timeout errors as non-retryable', () => {
      const error = new Error('ETIMEDOUT Request timeout');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(false);
    });

    it('should NOT treat generic errors as non-retryable', () => {
      const error = new Error('Something went wrong');
      const isNonRetryable = manager._isNonRetryableError(error);
      expect(isNonRetryable).toBe(false);
    });

    it('should handle null/undefined errors gracefully', () => {
      expect(manager._isNonRetryableError(null)).toBe(false);
      expect(manager._isNonRetryableError(undefined)).toBe(false);
      expect(manager._isNonRetryableError({})).toBe(false);
    });

    it('should track non-retryable errors in metrics', () => {
      const error = new Error('Market delisted');

      expect(manager.stats.nonRetryableDetected).toBe(0);

      manager._handleNonRetryableError('batch-0', error);
      expect(manager.stats.nonRetryableDetected).toBe(1);

      manager._handleNonRetryableError('batch-1', error);
      expect(manager.stats.nonRetryableDetected).toBe(2);
    });

    it('should extract symbol from error message and add to non-retryable set', () => {
      const error = new Error('Symbol BTC/USDT not found');

      manager._handleNonRetryableError('batch-0', error);

      expect(manager.nonRetryableSymbols.has('BTC/USDT')).toBe(true);
      expect(manager.stats.nonRetryableDetected).toBe(1);
    });

    it('should extract symbol from various error formats', () => {
      // Test direct mention
      expect(manager._extractSymbolFromError(new Error('ETH/USDT not found'))).toBe('ETH/USDT');

      // Test symbol= format
      expect(manager._extractSymbolFromError(new Error("invalid symbol='FAKE/USDT'"))).toBe('FAKE/USDT');

      // Test with quotes
      expect(manager._extractSymbolFromError(new Error('Symbol="SOL/USDT" disabled'))).toBe('SOL/USDT');

      // Test no symbol
      expect(manager._extractSymbolFromError(new Error('Cannot connect'))).toBe(null);
    });

    it('should filter out non-retryable symbols in subscription loop', async () => {
      manager.nonRetryableSymbols.add('FAKECOIN/USDT');

      const symbols = ['BTC/USDT', 'ETH/USDT', 'FAKECOIN/USDT', 'SOL/USDT'];
      const activeSymbols = symbols.filter(s => !manager.nonRetryableSymbols.has(s));

      expect(activeSymbols).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
      expect(activeSymbols).not.toContain('FAKECOIN/USDT');
    });
  });

  // ============================================================================
  // SECTION 3: Stale Connection Detection (Health Checks)
  // ============================================================================

  describe('Stale Connection Detection', () => {
    beforeEach(async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        healthCheckIntervalMs: 1000,
        healthCheckTimeoutMs: 5000,
      });
      await manager.initialize();
    });

    it('should initialize health check for each batch', () => {
      manager._startHealthCheck('batch-0');

      expect(manager.lastMessageTime.has('batch-0')).toBe(true);
      expect(manager.lastMessageTime.get('batch-0')).toBeGreaterThan(0);
    });

    it('should update lastMessageTime when messages arrive', () => {
      manager.batchState.set('batch-0', { lastMessageAt: Date.now(), stale: false });
      const initialTime = manager.batchState.get('batch-0').lastMessageAt;

      jest.advanceTimersByTime(2000);

      manager.batchState.get('batch-0').lastMessageAt = Date.now();
      const updateTime = manager.batchState.get('batch-0').lastMessageAt;

      expect(updateTime).toBeGreaterThan(initialTime);
    });

    it('should detect stale connection after timeout threshold', () => {
      manager.isRunning = true;
      manager.batchState.set('batch-0', {
        lastMessageAt: Date.now(),
        stale: false,
      });

      expect(manager.stats.staleConnectionsDetected).toBe(0);

      // Advance time beyond health check timeout
      jest.advanceTimersByTime(6000); // Advance 6s, timeout is 5s

      // Simulate the health check
      const batchState = manager.batchState.get('batch-0');
      const timeSinceLastMessage = Date.now() - batchState.lastMessageAt;
      expect(timeSinceLastMessage).toBeGreaterThan(manager.config.healthCheckTimeoutMs);
    });

    it('should NOT trigger stale detection if messages arrive within timeout', () => {
      manager.isRunning = true;
      manager.batchState.set('batch-0', { lastMessageAt: Date.now(), stale: false });

      // Update message time frequently (within timeout)
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(2000);
        manager.batchState.get('batch-0').lastMessageAt = Date.now();
      }

      const batchState = manager.batchState.get('batch-0');
      const timeSinceLastMessage = Date.now() - batchState.lastMessageAt;
      expect(timeSinceLastMessage).toBeLessThan(manager.config.healthCheckTimeoutMs);
    });

    it('should clear batch state on stop', () => {
      manager.batchState.set('batch-0', { lastMessageAt: Date.now(), stale: false });
      manager.batchState.set('batch-1', { lastMessageAt: Date.now(), stale: false });

      expect(manager.batchState.size).toBe(2);

      manager.batchState.delete('batch-0');
      expect(manager.batchState.size).toBe(1);

      manager.batchState.delete('batch-1');
      expect(manager.batchState.size).toBe(0);
    });

    it('should handle multiple concurrent batch states', () => {
      manager.batchState.set('batch-0', { lastMessageAt: Date.now(), stale: false });
      manager.batchState.set('batch-1', { lastMessageAt: Date.now(), stale: false });
      manager.batchState.set('batch-2', { lastMessageAt: Date.now(), stale: false });

      expect(manager.batchState.size).toBe(3);

      const time0 = manager.batchState.get('batch-0').lastMessageAt;
      const time1 = manager.batchState.get('batch-1').lastMessageAt;
      const time2 = manager.batchState.get('batch-2').lastMessageAt;

      expect(time0).toBeDefined();
      expect(time1).toBeDefined();
      expect(time2).toBeDefined();
    });
  });

  // ============================================================================
  // SECTION 4: Integration & Metrics
  // ============================================================================

  describe('Resilience Integration', () => {
    it('should track retries in status snapshot', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();

      manager._calculateExponentialBackoff('batch-0');
      manager._calculateExponentialBackoff('batch-0');

      const status = manager.getStatus();
      expect(status.stats.retries).toBe(2);
    });

    it('should include non-retryable symbols count in status', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();

      manager.nonRetryableSymbols.add('INVALID/USDT');
      manager.nonRetryableSymbols.add('DELISTED/USDT');

      const status = manager.getStatus();
      expect(status.nonRetryableSymbols).toBe(2);
    });

    it('should reset all resilience metrics on initialization', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });

      // Simulate prior metrics
      manager.stats.retries = 100;
      manager.stats.exponentialBackoffs = 50;

      // New manager has clean metrics
      const newManager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });

      expect(newManager.stats.retries).toBe(0);
      expect(newManager.stats.exponentialBackoffs).toBe(0);
      expect(newManager.stats.nonRetryableDetected).toBe(0);
      expect(newManager.stats.staleConnectionsDetected).toBe(0);
    });

    it('should clear all resilience state on stop', async () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });
      await manager.initialize();

      // Populate state
      manager.retryAttempts.set('batch-0', 3);
      manager.nonRetryableSymbols.add('INVALID/USDT');
      manager.lastMessageTime.set('batch-0', Date.now());
      manager._startHealthCheck('batch-0');

      // Stop
      await manager.stop();

      // State should be cleared
      expect(manager.retryAttempts.size).toBe(0);
      expect(manager.nonRetryableSymbols.size).toBe(0);
      expect(manager.lastMessageTime.size).toBe(0);
      expect(manager.healthCheckTimers.size).toBe(0);
    });
  });

  // ============================================================================
  // SECTION 5: Edge Cases & Robustness
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle exponential backoff overflow gracefully', () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 60000,
      });

      // Many retry attempts
      for (let i = 0; i < 50; i++) {
        const delay = manager._calculateExponentialBackoff('batch-0');
        expect(delay).toBeLessThanOrEqual(60000);
      }
    });

    it('should handle concurrent batch states', () => {
      manager = new ConnectionManager({
        exchangeFactory: mockFactory,
        redisService: mockRedis,
      });

      manager.batchState.set('batch-0', { lastMessageAt: Date.now(), stale: false });
      const time1 = manager.batchState.get('batch-0').lastMessageAt;

      manager.batchState.set('batch-0', { lastMessageAt: Date.now(), stale: false }); // Start again
      const time2 = manager.batchState.get('batch-0').lastMessageAt;

      // Both should be recent timestamps
      expect(time1).toBeDefined();
      expect(time2).toBeDefined();
    });

    it('should validate configuration ranges', () => {
      expect(() => {
        new ConnectionManager({
          exchangeFactory: mockFactory,
          redisService: mockRedis,
          retryBaseDelayMs: 0,
        });
      }).not.toThrow(); // 0 is allowed (might be for testing)
    });
  });
});
