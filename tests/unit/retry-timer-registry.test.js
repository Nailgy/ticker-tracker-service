/**
 * RetryTimerRegistry Unit Tests
 *
 * Tests per-batch timer registration, cancellation, cleanup
 */

const RetryTimerRegistry = require('../../src/core/retry-timer-registry');

describe('RetryTimerRegistry', () => {
  let registry;
  const mockLogger = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new RetryTimerRegistry({ logger: mockLogger });
  });

  describe('Initialization', () => {
    test('should initialize with empty timers', () => {
      expect(registry.timers.size).toBe(0);
    });

    test('should have zero pending timers', () => {
      expect(registry.getTotalPendingTimers()).toBe(0);
    });
  });

  describe('Timer Registration', () => {
    test('should register timer for batch', () => {
      const handle = setTimeout(() => {}, 1000);

      registry.registerTimer('batch-0', handle);

      expect(registry.timers.has('batch-0')).toBe(true);
      expect(registry.timers.get('batch-0').size).toBe(1);

      clearTimeout(handle);
    });

    test('should register multiple timers for same batch', () => {
      const handle1 = setTimeout(() => {}, 1000);
      const handle2 = setTimeout(() => {}, 2000);

      registry.registerTimer('batch-0', handle1);
      registry.registerTimer('batch-0', handle2);

      expect(registry.timers.get('batch-0').size).toBe(2);

      clearTimeout(handle1);
      clearTimeout(handle2);
    });

    test('should register timers for different batches', () => {
      const handle1 = setTimeout(() => {}, 1000);
      const handle2 = setTimeout(() => {}, 2000);

      registry.registerTimer('batch-0', handle1);
      registry.registerTimer('batch-1', handle2);

      expect(registry.timers.has('batch-0')).toBe(true);
      expect(registry.timers.has('batch-1')).toBe(true);
      expect(registry.timers.get('batch-0').size).toBe(1);
      expect(registry.timers.get('batch-1').size).toBe(1);

      clearTimeout(handle1);
      clearTimeout(handle2);
    });

    test('should track total pending timers', () => {
      const handle1 = setTimeout(() => {}, 1000);
      const handle2 = setTimeout(() => {}, 2000);
      const handle3 = setTimeout(() => {}, 3000);

      registry.registerTimer('batch-0', handle1);
      registry.registerTimer('batch-0', handle2);
      registry.registerTimer('batch-1', handle3);

      expect(registry.getTotalPendingTimers()).toBe(3);

      clearTimeout(handle1);
      clearTimeout(handle2);
      clearTimeout(handle3);
    });
  });

  describe('Timer Cancellation by Batch', () => {
    test('should cancel all timers for specific batch', () => {
      const spy1 = jest.fn();
      const spy2 = jest.fn();

      const handle1 = setTimeout(spy1, 1000);
      const handle2 = setTimeout(spy2, 2000);

      registry.registerTimer('batch-0', handle1);
      registry.registerTimer('batch-0', handle2);

      expect(registry.getTotalPendingTimers()).toBe(2);

      registry.cancelBatchTimers('batch-0');

      expect(registry.timers.has('batch-0')).toBe(false);
      expect(registry.getTotalPendingTimers()).toBe(0);
    });

    test('should not affect timers for other batches', () => {
      const handle1 = setTimeout(() => {}, 1000);
      const handle2 = setTimeout(() => {}, 2000);

      registry.registerTimer('batch-0', handle1);
      registry.registerTimer('batch-1', handle2);

      registry.cancelBatchTimers('batch-0');

      expect(registry.timers.has('batch-0')).toBe(false);
      expect(registry.timers.has('batch-1')).toBe(true);
      expect(registry.getTotalPendingTimers()).toBe(1);

      clearTimeout(handle2);
    });

    test('should handle cancellation of non-existent batch', () => {
      expect(() => {
        registry.cancelBatchTimers('non-existent');
      }).not.toThrow();
    });

    test('should clear batch from map after cancellation', () => {
      const handle = setTimeout(() => {}, 1000);

      registry.registerTimer('batch-0', handle);
      expect(registry.timers.has('batch-0')).toBe(true);

      registry.cancelBatchTimers('batch-0');

      expect(registry.timers.has('batch-0')).toBe(false);
    });
  });

  describe('Total Timer Cancellation', () => {
    test('should cancel all timers', () => {
      const handle1 = setTimeout(() => {}, 1000);
      const handle2 = setTimeout(() => {}, 2000);
      const handle3 = setTimeout(() => {}, 3000);

      registry.registerTimer('batch-0', handle1);
      registry.registerTimer('batch-0', handle2);
      registry.registerTimer('batch-1', handle3);

      expect(registry.getTotalPendingTimers()).toBe(3);

      registry.cancelAllTimers();

      expect(registry.timers.size).toBe(0);
      expect(registry.getTotalPendingTimers()).toBe(0);
    });

    test('should clear all batch entries', () => {
      const handle1 = setTimeout(() => {}, 1000);
      const handle2 = setTimeout(() => {}, 2000);

      registry.registerTimer('batch-0', handle1);
      registry.registerTimer('batch-1', handle2);

      registry.cancelAllTimers();

      expect(registry.timers.has('batch-0')).toBe(false);
      expect(registry.timers.has('batch-1')).toBe(false);
    });

    test('should handle cancelAllTimers on empty registry', () => {
      expect(() => {
        registry.cancelAllTimers();
      }).not.toThrow();

      expect(registry.getTotalPendingTimers()).toBe(0);
    });
  });

  describe('Statistics', () => {
    test('should return timer stats', () => {
      const handle1 = setTimeout(() => {}, 1000);
      const handle2 = setTimeout(() => {}, 2000);
      const handle3 = setTimeout(() => {}, 3000);

      registry.registerTimer('batch-0', handle1);
      registry.registerTimer('batch-0', handle2);
      registry.registerTimer('batch-1', handle3);

      const stats = registry.getStats();

      expect(stats['batch-0']).toBe(2);
      expect(stats['batch-1']).toBe(1);

      clearTimeout(handle1);
      clearTimeout(handle2);
      clearTimeout(handle3);
    });

    test('should return empty stats when no timers', () => {
      const stats = registry.getStats();

      expect(Object.keys(stats).length).toBe(0);
    });

    test('should return copy of stats (not reference)', () => {
      const handle = setTimeout(() => {}, 1000);
      registry.registerTimer('batch-0', handle);

      const stats1 = registry.getStats();
      stats1['batch-0'] = 999;

      const stats2 = registry.getStats();
      expect(stats2['batch-0']).toBe(1);

      clearTimeout(handle);
    });
  });

  describe('Lifecycle Integration', () => {
    test('should support complete lifecycle: register, register, cancel batch, cancel all', () => {
      // Register timers for 2 batches
      const h1 = setTimeout(() => {}, 1000);
      const h2 = setTimeout(() => {}, 2000);
      const h3 = setTimeout(() => {}, 3000);

      registry.registerTimer('batch-0', h1);
      registry.registerTimer('batch-0', h2);
      registry.registerTimer('batch-1', h3);

      expect(registry.getTotalPendingTimers()).toBe(3);

      // Cancel batch-0
      registry.cancelBatchTimers('batch-0');
      expect(registry.getTotalPendingTimers()).toBe(1);
      expect(registry.timers.has('batch-0')).toBe(false);
      expect(registry.timers.has('batch-1')).toBe(true);

      // Cancel all remaining
      registry.cancelAllTimers();
      expect(registry.getTotalPendingTimers()).toBe(0);
      expect(registry.timers.size).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid timer handles gracefully', () => {
      // Try to register undefined handle
      expect(() => {
        registry.registerTimer('batch-0', undefined);
      }).not.toThrow();
    });

    test('should handle cancelling same batch twice', () => {
      const handle = setTimeout(() => {}, 1000);
      registry.registerTimer('batch-0', handle);

      // First cancel
      registry.cancelBatchTimers('batch-0');
      expect(registry.getTotalPendingTimers()).toBe(0);

      // Second cancel should not throw
      expect(() => {
        registry.cancelBatchTimers('batch-0');
      }).not.toThrow();

      expect(registry.getTotalPendingTimers()).toBe(0);
    });

    test('should handle mixed batch and total cancellation', () => {
      const h1 = setTimeout(() => {}, 1000);
      const h2 = setTimeout(() => {}, 2000);

      registry.registerTimer('batch-0', h1);
      registry.registerTimer('batch-1', h2);

      registry.cancelBatchTimers('batch-0');
      registry.cancelAllTimers();

      expect(registry.getTotalPendingTimers()).toBe(0);
      expect(registry.timers.size).toBe(0);
    });
  });

  describe('Batch-Based Operations', () => {
    test('should list all batches with timers', () => {
      const h1 = setTimeout(() => {}, 1000);
      const h2 = setTimeout(() => {}, 2000);
      const h3 = setTimeout(() => {}, 3000);

      registry.registerTimer('batch-0', h1);
      registry.registerTimer('batch-0', h2);
      registry.registerTimer('batch-1', h3);

      const stats = registry.getStats();
      const batches = Object.keys(stats);

      expect(batches).toContain('batch-0');
      expect(batches).toContain('batch-1');
      expect(batches.length).toBe(2);

      clearTimeout(h1);
      clearTimeout(h2);
      clearTimeout(h3);
    });

    test('should correctly count timers per batch', () => {
      const handles = Array(5).fill().map(() => setTimeout(() => {}, 1000));

      // 3 timers for batch-0
      registry.registerTimer('batch-0', handles[0]);
      registry.registerTimer('batch-0', handles[1]);
      registry.registerTimer('batch-0', handles[2]);

      // 2 timers for batch-1
      registry.registerTimer('batch-1', handles[3]);
      registry.registerTimer('batch-1', handles[4]);

      const stats = registry.getStats();

      expect(stats['batch-0']).toBe(3);
      expect(stats['batch-1']).toBe(2);

      handles.forEach(h => clearTimeout(h));
    });
  });
});
