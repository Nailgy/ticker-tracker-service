/**
 * ConnectionStateMachine Unit Tests
 *
 * Tests guarded state transitions, history tracking, illegal transitions
 */

const ConnectionStateMachine = require('../../src/core/state-machine');

describe('ConnectionStateMachine', () => {
  let stateMachine;
  const mockLogger = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    stateMachine = new ConnectionStateMachine('batch-0', { logger: mockLogger });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Initialization', () => {
    test('should start in idle state', () => {
      expect(stateMachine.getState()).toBe('idle');
    });

    test('should have empty transition history', () => {
      expect(stateMachine.getTransitionHistory().length).toBe(0);
    });

    test('should have correct batch ID', () => {
      const sm = new ConnectionStateMachine('batch-123', {});
      expect(sm.batchId).toBe('batch-123');
    });
  });

  describe('Legal Transitions', () => {
    test('should transition from idle to connecting', () => {
      const record = stateMachine.transition('connecting', 'test reason');

      expect(stateMachine.getState()).toBe('connecting');
      expect(record.from).toBe('idle');
      expect(record.to).toBe('connecting');
      expect(record.reason).toBe('test reason');
    });

    test('should transition from connecting to subscribed', () => {
      stateMachine.transition('connecting', 'start');
      const record = stateMachine.transition('subscribed', 'data received');

      expect(stateMachine.getState()).toBe('subscribed');
      expect(record.from).toBe('connecting');
      expect(record.to).toBe('subscribed');
    });

    test('should transition from subscribed to stale', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');
      const record = stateMachine.transition('stale', 'no data');

      expect(stateMachine.getState()).toBe('stale');
      expect(record.from).toBe('subscribed');
    });

    test('should transition from stale to recovering', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');
      stateMachine.transition('stale', 'no data');
      const record = stateMachine.transition('recovering', 'recovery attempt');

      expect(stateMachine.getState()).toBe('recovering');
      expect(record.from).toBe('stale');
    });

    test('should transition from recovering to subscribed', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');
      stateMachine.transition('stale', 'no data');
      stateMachine.transition('recovering', 'recovery attempt');
      const record = stateMachine.transition('subscribed', 'recovery successful');

      expect(stateMachine.getState()).toBe('subscribed');
      expect(record.from).toBe('recovering');
    });

    test('should transition from any state to failed', () => {
      const states = ['idle', 'connecting', 'subscribed', 'stale', 'recovering'];

      for (const initialState of states) {
        const sm = new ConnectionStateMachine('batch-test', {});

        // Navigate to state if not idle
        if (initialState !== 'idle') {
          sm.transition('connecting', 'start');
          if (initialState !== 'connecting') {
            sm.transition('subscribed', 'data');
            if (initialState !== 'subscribed') {
              sm.transition('stale', 'stale');
              if (initialState !== 'stale') {
                sm.transition('recovering', 'recovery');
              }
            }
          }
        }

        const record = sm.transition('failed', 'error');
        expect(sm.getState()).toBe('failed');
        expect(record.from).toBe(initialState);
      }
    });

    test('should transition from failed to connecting (only retry path)', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('failed', 'error');
      const record = stateMachine.transition('connecting', 'retry');

      expect(stateMachine.getState()).toBe('connecting');
      expect(record.from).toBe('failed');
    });
  });

  describe('Illegal Transitions', () => {
    test('should reject idle to subscribed (skipping connecting)', () => {
      expect(() => {
        stateMachine.transition('subscribed', 'invalid');
      }).toThrow('Illegal transition');
    });

    test('should reject connecting to idle (reverse direction)', () => {
      stateMachine.transition('connecting', 'start');

      expect(() => {
        stateMachine.transition('idle', 'invalid');
      }).toThrow('Illegal transition');
    });

    test('should reject subscribed to failed transition if already failed', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('failed', 'error');

      expect(() => {
        stateMachine.transition('stale', 'invalid');
      }).toThrow('Illegal transition');
    });

    test('should reject recovering to stale (backward)', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');
      stateMachine.transition('stale', 'stale');
      stateMachine.transition('recovering', 'recovery');

      expect(() => {
        stateMachine.transition('stale', 'backward');
      }).toThrow('Illegal transition');
    });
  });

  describe('Transition History', () => {
    test('should track all transitions', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');
      stateMachine.transition('stale', 'no data');

      const history = stateMachine.getTransitionHistory();
      expect(history.length).toBe(3);
      expect(history[0].to).toBe('connecting');
      expect(history[1].to).toBe('subscribed');
      expect(history[2].to).toBe('stale');
    });

    test('should record reason for each transition', () => {
      stateMachine.transition('connecting', 'subscription started');
      stateMachine.transition('subscribed', 'data received');

      const history = stateMachine.getTransitionHistory();
      expect(history[0].reason).toBe('subscription started');
      expect(history[1].reason).toBe('data received');
    });

    test('should record timestamp for each transition', () => {
      const before = Date.now();
      stateMachine.transition('connecting', 'start');
      const after = Date.now();

      const history = stateMachine.getTransitionHistory();
      expect(history[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(history[0].timestamp).toBeLessThanOrEqual(after);
    });

    test('should include from and to', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');

      const history = stateMachine.getTransitionHistory();
      expect(history[0]).toEqual(expect.objectContaining({
        from: 'idle',
        to: 'connecting',
      }));
      expect(history[1]).toEqual(expect.objectContaining({
        from: 'connecting',
        to: 'subscribed',
      }));
    });

    test('should return copy of history (not reference)', () => {
      stateMachine.transition('connecting', 'start');

      const history1 = stateMachine.getTransitionHistory();
      history1.push({ fake: true });

      const history2 = stateMachine.getTransitionHistory();
      expect(history2.length).toBe(1);  // Not affected by modification
      expect(history2[0].fake).toBeUndefined();
    });
  });

  describe('Transition Statistics', () => {
    test('should return stats for transitions', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');
      stateMachine.transition('stale', 'timeout');
      stateMachine.transition('recovering', 'recovery');
      stateMachine.transition('subscribed', 'recovered');

      const stats = stateMachine.getTransitionStats();

      expect(stats['idle→connecting']).toBe(1);
      expect(stats['connecting→subscribed']).toBe(1);
      expect(stats['subscribed→stale']).toBe(1);
      expect(stats['stale→recovering']).toBe(1);
      expect(stats['recovering→subscribed']).toBe(1);
    });

    test('should track transition counts', () => {
      stateMachine.transition('connecting', 'start');

      // Simulate some time passing
      jest.advanceTimersByTime(100);

      stateMachine.transition('subscribed', 'data');

      const stats = stateMachine.getTransitionStats();
      expect(stats['idle→connecting']).toBe(1);
      expect(stats['connecting→subscribed']).toBe(1);
    });
  });

  describe('Metadata in Transitions', () => {
    test('should store metadata with transition', () => {
      const metadata = {
        errorCode: 'TIMEOUT',
        attempt: 3,
        symbol: 'BTC/USDT',
      };

      stateMachine.transition('connecting', 'start');
      stateMachine.transition('failed', 'error', metadata);

      const history = stateMachine.getTransitionHistory();
      expect(history[1].metadata).toEqual(metadata);
    });

    test('should include metadata in filtered results', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('failed', 'error', { reason: 'TIMEOUT' });

      const failureHistory = stateMachine.getTransitionHistoryFiltered({ to: 'failed' });
      expect(failureHistory.length).toBe(1);
      expect(failureHistory[0].metadata.reason).toBe('TIMEOUT');
    });
  });

  describe('Filtered History', () => {
    test('should filter by to', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');
      stateMachine.transition('stale', 'timeout');
      stateMachine.transition('recovering', 'recovery');

      const staleTransitions = stateMachine.getTransitionHistoryFiltered({ to: 'stale' });
      expect(staleTransitions.length).toBe(1);
      expect(staleTransitions[0].to).toBe('stale');
    });

    test('should filter by from', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');
      stateMachine.transition('stale', 'timeout');
      stateMachine.transition('recovering', 'recovery');
      stateMachine.transition('subscribed', 'recovered');

      const fromStale = stateMachine.getTransitionHistoryFiltered({ from: 'stale' });
      expect(fromStale.length).toBe(1);
      expect(fromStale[0].from).toBe('stale');
    });

    test('should filter by multiple criteria', () => {
      stateMachine.transition('connecting', 'start');
      stateMachine.transition('subscribed', 'data');
      stateMachine.transition('stale', 'timeout');
      stateMachine.transition('recovering', 'recovery');

      const fromSubscribedToStale = stateMachine.getTransitionHistoryFiltered({
        from: 'subscribed',
        to: 'stale'
      });
      expect(fromSubscribedToStale.length).toBe(1);
      expect(fromSubscribedToStale[0].from).toBe('subscribed');
      expect(fromSubscribedToStale[0].to).toBe('stale');
    });

    test('should return empty if no matches', () => {
      stateMachine.transition('connecting', 'start');

      const result = stateMachine.getTransitionHistoryFiltered({ to: 'failed' });
      expect(result.length).toBe(0);
    });
  });

  describe('Error Messages', () => {
    test('should have descriptive error for illegal transitions', () => {
      stateMachine.transition('connecting', 'start');

      try {
        stateMachine.transition('idle', 'invalid');
        fail('Should have thrown');
      } catch (error) {
        expect(error.message).toContain('Illegal transition');
        expect(error.message).toContain('connecting');
        expect(error.message).toContain('idle');
      }
    });
  });
});
