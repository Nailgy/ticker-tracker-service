/**
 * SubscriptionEngine Unit Tests
 *
 * Tests subscription loop coordination, resilience, health checks, and error handling
 * Updated for Stage 2D: Uses AdapterPool for per-batch health tracking
 */

const SubscriptionEngine = require('../../src/core/subscription.engine');
const RetryScheduler = require('../../src/utils/retry.scheduler');
const AdapterPool = require('../../src/core/adapter.pool');

// Mock AdapterPool to work with tests (Stage 2D)
jest.mock('../../src/core/adapter.pool');

describe('SubscriptionEngine', () => {
  let engine;
  let mockAdapter;
  let mockRegistry;
  let mockWriter;
  let mockLogger;
  let mockAdapterPool;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockLogger = jest.fn();

    mockAdapter = {
      config: { exchange: 'binance', marketType: 'spot' },
      getExchangeId: jest.fn(() => 'binance'),
      getMarketType: jest.fn(() => 'spot'),
      subscribe: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockRegistry = {
      getNonRetryableSymbols: jest.fn().mockReturnValue(new Set()),
      markNonRetryable: jest.fn(),
    };

    mockWriter = {
      writeTicker: jest.fn().mockResolvedValue({ written: true }),
    };

    // Mock AdapterPool (Stage 2D)
    mockAdapterPool = {
      initialize: jest.fn().mockResolvedValue(undefined),
      recordDataForBatch: jest.fn(),
      recordErrorForBatch: jest.fn(),
      resetBatchForRecovery: jest.fn(),
      getAllBatchHealth: jest.fn().mockReturnValue([]),
      close: jest.fn().mockResolvedValue(undefined),
    };
    AdapterPool.mockImplementation(() => mockAdapterPool);

    engine = new SubscriptionEngine(mockAdapter, mockRegistry, mockWriter, {
      logger: mockLogger,
      batchSize: 100,
      healthCheckIntervalMs: 15000,
      healthCheckTimeoutMs: 60000,
      subscriptionDelay: 100,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Constructor & Initialization', () => {
    test('should initialize with default config', () => {
      expect(engine.config.batchSize).toBe(100);
      expect(engine.config.healthCheckIntervalMs).toBe(15000);
      expect(engine.config.healthCheckTimeoutMs).toBe(60000);
    });

    test('should start with isRunning false', () => {
      expect(engine.isRunning).toBe(false);
      expect(engine.metrics.isRunning).toBe(false);
    });

    test('should initialize empty state', () => {
      expect(engine.subscriptionLoops.size).toBe(0);
      expect(engine.tickerCallbacks.length).toBe(0);
      expect(engine.errorCallbacks.length).toBe(0);
    });

    test('should create RetryScheduler', () => {
      expect(engine.retryScheduler).toBeInstanceOf(RetryScheduler);
    });
  });

  describe('Callbacks', () => {
    test('should register ticker callback', () => {
      const callback = jest.fn();
      engine.onTicker(callback);

      expect(engine.tickerCallbacks.length).toBe(1);
      expect(engine.tickerCallbacks[0]).toBe(callback);
    });

    test('should register error callback', () => {
      const callback = jest.fn();
      engine.onError(callback);

      expect(engine.errorCallbacks.length).toBe(1);
      expect(engine.errorCallbacks[0]).toBe(callback);
    });

    test('should register health check callback', () => {
      const callback = jest.fn();
      engine.onHealthCheck(callback);

      expect(engine.healthCheckCallbacks.length).toBe(1);
      expect(engine.healthCheckCallbacks[0]).toBe(callback);
    });

    test('should allow multiple callbacks', () => {
      engine.onTicker(() => {});
      engine.onTicker(() => {});
      engine.onError(() => {});

      expect(engine.tickerCallbacks.length).toBe(2);
      expect(engine.errorCallbacks.length).toBe(1);
    });
  });

  describe('Start Subscriptions', () => {
    test('should reject empty batches', async () => {
      await expect(engine.startSubscriptions([])).rejects.toThrow(
        'Cannot start subscriptions with empty batches'
      );
    });

    test('should reject null batches', async () => {
      await expect(engine.startSubscriptions(null)).rejects.toThrow(
        'Cannot start subscriptions with empty batches'
      );
    });

    test('should set isRunning to true', async () => {
      const batchesMock = jest.fn();
      await engine.startSubscriptions([['BTC/USDT']]);

      expect(engine.isRunning).toBe(true);
      expect(engine.metrics.isRunning).toBe(true);
    });

    test('should reject if already running', async () => {
      engine.isRunning = true;

      await engine.startSubscriptions([['BTC/USDT']]);

      expect(mockLogger).toHaveBeenCalledWith('warn', 'SubscriptionEngine: Already running');
    });

    test('should initialize subscription loops', async () => {
      await engine.startSubscriptions([['BTC/USDT', 'ETH/USDT'], ['BNB/USDT']]);

      expect(engine.subscriptionLoops.size).toBe(2);
      expect(engine.subscriptionLoops.has('batch-0')).toBe(true);
      expect(engine.subscriptionLoops.has('batch-1')).toBe(true);
    });

    test('should set activeConnections in metrics', async () => {
      await engine.startSubscriptions([['BTC/USDT'], ['ETH/USDT'], ['BNB/USDT']]);

      expect(engine.metrics.activeConnections).toBe(3);
    });

    test('should start health check', async () => {
      engine.startSubscriptions([['BTC/USDT']]).catch(() => {});

      expect(engine.healthCheckInterval).toBeDefined();
    });
  });

  describe('Stop Subscriptions', () => {
    test('should set isRunning to false', async () => {
      engine.isRunning = true;
      await engine.stopSubscriptions();

      expect(engine.isRunning).toBe(false);
      expect(engine.metrics.isRunning).toBe(false);
    });

    test('should clear subscription timers', async () => {
      const timer = setTimeout(() => {}, 1000);
      engine.subscriptionTimers.push(timer);

      await engine.stopSubscriptions();

      expect(engine.subscriptionTimers.length).toBe(0);
    });

    test('should clear health check interval', async () => {
      engine.healthCheckInterval = setInterval(() => {}, 1000);

      await engine.stopSubscriptions();

      expect(engine.healthCheckInterval).toBeNull();
    });

    test('should close adapter', async () => {
      await engine.stopSubscriptions();

      expect(engine.adapterPool.close).toHaveBeenCalled();
    });

    test('should handle adapter close errors', async () => {
      engine.adapterPool.close.mockRejectedValue(new Error('Close failed'));

      await expect(engine.stopSubscriptions()).resolves.not.toThrow();
      expect(mockLogger).toHaveBeenCalledWith('warn', expect.stringContaining('Error closing adapter'), expect.any(Object));
    });
  });

  describe('Error Classification', () => {
    test('should identify non-retryable errors', () => {
      const nonRetryableErrors = [
        'symbol not found',
        'not found',
        'invalid symbol',
        'suspended',
        'delisted',
        'market not found',
        'no such market',
      ];

      for (const msg of nonRetryableErrors) {
        const error = new Error(msg);
        expect(engine._isNonRetryableError(error)).toBe(true);
      }
    });

    test('should identify retryable errors', () => {
      const retryableErrors = [
        'timeout',
        'connection refused',
        'ECONNRESET',
        'socket hang up',
      ];

      for (const msg of retryableErrors) {
        const error = new Error(msg);
        expect(engine._isNonRetryableError(error)).toBe(false);
      }
    });

    test('should handle null error message', () => {
      const error = new Error();
      error.message = null;

      expect(engine._isNonRetryableError(error)).toBe(false);
    });
  });

  describe('Symbol Extraction', () => {
    test('should extract symbol from error message', () => {
      const error = new Error('Trading pair BTC/USDT not found');
      const symbol = engine._extractSymbolFromError(error);

      expect(symbol).toBe('BTC/USDT');
    });

    test('should extract symbol with symbol= format', () => {
      const error = new Error("Error: symbol='ETH/USDT' not found");
      const symbol = engine._extractSymbolFromError(error);

      expect(symbol).toBe('ETH/USDT');
    });

    test('should return null if no symbol found', () => {
      const error = new Error('Generic connection error');
      const symbol = engine._extractSymbolFromError(error);

      expect(symbol).toBeNull();
    });

    test('should handle multiple symbols (first match)', () => {
      const error = new Error('BTC/USDT and ETH/USDT both failed');
      const symbol = engine._extractSymbolFromError(error);

      expect(symbol).toBe('BTC/USDT');
    });
  });

  describe('Status & Metrics', () => {
    test('should return current status', () => {
      engine.isRunning = true;
      engine.subscriptionLoops.set('batch-0', { symbols: ['BTC/USDT'] });
      engine.metrics.failedBatches = 1;
      engine.metrics.retryQueue = 2;

      const status = engine.getStatus();

      expect(status.isRunning).toBe(true);
      expect(status.activeConnections).toBe(1);
      expect(status.failedBatches).toBe(1);
      expect(status.retryQueue).toBe(2);
    });

    test('should report metrics snapshot', () => {
      engine.metrics.totalTickers = 100;
      engine.metrics.totalErrors = 5;
      engine.metrics.staleDetections = 2;

      const status = engine.getStatus();

      expect(status.metrics.totalTickers).toBe(100);
      expect(status.metrics.totalErrors).toBe(5);
      expect(status.metrics.staleDetections).toBe(2);
    });
  });

  describe('Health Check', () => {
    test('should detect stale connections', () => {
      engine.isRunning = true;

      // Mock AdapterPool health data (Stage 2D: per-batch health)
      mockAdapterPool.getAllBatchHealth.mockReturnValue([
        {
          id: 'batch-0',
          state: 'idle',
          isStale: true,
          timeSinceLastDataMs: 120000,
          errorCount: 0,
          retryAttempts: 0,
          lastError: null,
        },
      ]);

      engine.subscriptionLoops.set('batch-0', {
        symbols: ['BTC/USDT'],
        retryAttempts: 0,
      });

      engine._startHealthCheck();
      jest.advanceTimersByTime(engine.config.healthCheckIntervalMs);

      expect(mockAdapterPool.resetBatchForRecovery).toHaveBeenCalledWith('batch-0');
      expect(engine.metrics.staleDetections).toBe(1);
    });

    test('should call health check callbacks on stale detection', () => {
      engine.isRunning = true;

      // Mock AdapterPool health data
      mockAdapterPool.getAllBatchHealth.mockReturnValue([
        {
          id: 'batch-0',
          state: 'idle',
          isStale: true,
          timeSinceLastDataMs: 120000,
          errorCount: 0,
          retryAttempts: 0,
          lastError: null,
        },
      ]);

      const callback = jest.fn();
      engine.onHealthCheck(callback);

      engine.subscriptionLoops.set('batch-0', {
        symbols: ['BTC/USDT'],
        retryAttempts: 0,
      });

      engine._startHealthCheck();
      jest.advanceTimersByTime(engine.config.healthCheckIntervalMs);

      expect(callback).toHaveBeenCalledWith('batch-0', { stale: true });
    });

    test('should recover from stale state when data flows', () => {
      engine.isRunning = true;

      // Mock AdapterPool health data showing recovered state
      mockAdapterPool.getAllBatchHealth.mockReturnValue([
        {
          id: 'batch-0',
          state: 'recovering',
          isStale: false,
          timeSinceLastDataMs: 5000,
          errorCount: 0,
          retryAttempts: 0,
          lastError: null,
        },
      ]);

      engine.subscriptionLoops.set('batch-0', {
        symbols: ['BTC/USDT'],
        retryAttempts: 0,
      });

      engine._startHealthCheck();
      jest.advanceTimersByTime(engine.config.healthCheckIntervalMs);

      // Verify stale is not detected again (no recovery callback)
      expect(mockAdapterPool.resetBatchForRecovery).not.toHaveBeenCalled();
    });
  });

  describe('Logging', () => {
    test('should log subscription start', async () => {
      await engine.startSubscriptions([['BTC/USDT']]);

      // Find the "Starting subscriptions" log message (may not be first due to AdapterPool initialization log)
      const startingCall = mockLogger.mock.calls.find(call => call[1].includes('Starting'));
      expect(startingCall).toBeDefined();
      expect(startingCall[0]).toBe('info');
    });

    test('should log subscription stop', async () => {
      await engine.stopSubscriptions();

      // Check that "Stopped" message was logged (may have multiple calls)
      const stoppedCall = mockLogger.mock.calls.find(call => call[1].includes('Stopped'));
      expect(stoppedCall).toBeDefined();
      expect(stoppedCall[0]).toBe('info');
    });
  });
});
