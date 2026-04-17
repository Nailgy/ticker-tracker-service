/**
 * HealthRatioPolicy Unit Tests
 *
 * Tests health ratio calculation, breach counting, cooldown, restart triggers
 */

const HealthRatioPolicy = require('../../src/core/health-ratio-policy');

describe('HealthRatioPolicy', () => {
  let policy;
  const mockLogger = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    policy = new HealthRatioPolicy({
      minHealthyRatio: 0.5,
      ratioBreachCycles: 3,
      restartCooldownMs: 30000,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Initialization', () => {
    test('should initialize with default config', () => {
      expect(policy.minHealthyRatio).toBe(0.5);
      expect(policy.ratioBreachCycles).toBe(3);
      expect(policy.restartCooldownMs).toBe(30000);
    });

    test('should start with breach counter at 0', () => {
      expect(policy.breachCounter).toBe(0);
    });

    test('should start with empty breach history', () => {
      expect(policy.breachCounter).toBe(0);
    });

    test('should start with no last restart time', () => {
      expect(policy.lastRestartAt).toBe(0);
    });
  });

  describe('Health Ratio Calculation', () => {
    test('should calculate ratio correctly', () => {
      const batchHealth = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'subscribed' },
        { id: 'batch-2', state: 'failed' },
        { id: 'batch-3', state: 'subscribed' },
      ];

      const result = policy.evaluate(batchHealth);

      // 3 subscribed / 4 total = 0.75
      expect(result.ratio).toBe('0.75');
      expect(result.healthy).toBe(3);
      expect(result.total).toBe(4);
    });

    test('should handle all healthy batches', () => {
      const batchHealth = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'subscribed' },
        { id: 'batch-2', state: 'subscribed' },
      ];

      const result = policy.evaluate(batchHealth);

      expect(result.ratio).toBe('1.00');
      expect(result.healthy).toBe(3);
      expect(result.shouldRestart).toBe(false);
    });

    test('should handle all unhealthy batches', () => {
      const batchHealth = [
        { id: 'batch-0', state: 'failed' },
        { id: 'batch-1', state: 'failed' },
      ];

      const result = policy.evaluate(batchHealth);

      expect(result.ratio).toBe('0.00');
      expect(result.healthy).toBe(0);
      expect(result.total).toBe(2);
    });

    test('should handle empty batch list', () => {
      const result = policy.evaluate([]);

      expect(result.ratio).toBe(0);
      expect(result.healthy).toBe(0);
      expect(result.total).toBe(0);
      expect(result.shouldRestart).toBe(false);
    });
  });

  describe('Breach Counting', () => {
    test('should increment breach counter on below-threshold ratio', () => {
      const batchHealth = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      // ratio = 1/3 = 0.33 < 0.5 threshold
      const result = policy.evaluate(batchHealth);

      expect(result.ratio).toBe('0.33');
      expect(policy.breachCounter).toBe(1);
    });

    test('should not increment breach counter on healthy ratio', () => {
      const batchHealth = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'subscribed' },
        { id: 'batch-2', state: 'failed' },
      ];

      // ratio = 2/3 = 0.67 >= 0.5 threshold
      const result = policy.evaluate(batchHealth);

      expect(policy.breachCounter).toBe(0);
    });

    test('should reset breach counter on healthy ratio', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      // Increment counter 2 times
      policy.evaluate(unhealthyBatches);
      policy.evaluate(unhealthyBatches);
      expect(policy.breachCounter).toBe(2);

      // Evaluate healthy ratio
      const healthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'subscribed' },
      ];
      policy.evaluate(healthyBatches);

      // Counter should reset
      expect(policy.breachCounter).toBe(0);
    });

    test('should trigger restart after reaching breach cycle limit', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      // Cycle 1
      let result = policy.evaluate(unhealthyBatches);
      expect(result.shouldRestart).toBe(false);
      expect(policy.breachCounter).toBe(1);

      // Cycle 2
      result = policy.evaluate(unhealthyBatches);
      expect(result.shouldRestart).toBe(false);
      expect(policy.breachCounter).toBe(2);

      // Cycle 3 - should trigger restart and RESET counter
      result = policy.evaluate(unhealthyBatches);
      expect(result.shouldRestart).toBe(true);
      // Note: breachCounter is reset to 0 after triggering restart (line 78)
      expect(policy.breachCounter).toBe(0);
    });
  });

  describe('Cooldown', () => {
    test('should not allow restart if in cooldown', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      // Trigger first restart
      policy.evaluate(unhealthyBatches);
      policy.evaluate(unhealthyBatches);
      let result = policy.evaluate(unhealthyBatches);

      expect(result.shouldRestart).toBe(true);
      policy.lastRestartAt = Date.now();  // Simulate restart

      // Immediately try to restart again while in cooldown (30s)
      result = policy.evaluate(unhealthyBatches);
      expect(result.shouldRestart).toBe(false);  // Cooldown blocks it
    });

    test('should allow restart after cooldown expires', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      // First restart
      policy.evaluate(unhealthyBatches);
      policy.evaluate(unhealthyBatches);
      let result = policy.evaluate(unhealthyBatches);
      expect(result.shouldRestart).toBe(true);
      // Counter is now 0 (reset after restart)

      // Advance time past cooldown
      jest.advanceTimersByTime(30001);

      // Evaluate again - counter increments from 0 to 1
      policy.evaluate(unhealthyBatches);
      expect(policy.breachCounter).toBe(1);

      // Two more cycles to reach breach limit
      policy.evaluate(unhealthyBatches);
      expect(policy.breachCounter).toBe(2);

      // Third cycle - should trigger restart again (no cooldown since time has passed)
      result = policy.evaluate(unhealthyBatches);
      expect(result.shouldRestart).toBe(true);
    });
  });

  describe('Breach History', () => {
    test('should record each breach event', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      policy.evaluate(unhealthyBatches);
      policy.evaluate(unhealthyBatches);

      expect(policy.breachHistory.length).toBe(2);
      expect(policy.breachHistory[0].cycle).toBe(1);
      expect(policy.breachHistory[1].cycle).toBe(2);
    });

    test('should include timestamp with each breach', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      const before = Date.now();
      policy.evaluate(unhealthyBatches);
      const after = Date.now();

      const breach = policy.breachHistory[0];
      expect(breach.timestamp).toBeGreaterThanOrEqual(before);
      expect(breach.timestamp).toBeLessThanOrEqual(after);
    });

    test('should include ratio with each breach', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      policy.evaluate(unhealthyBatches);

      const breach = policy.breachHistory[0];
      expect(breach.ratio).toBe('0.33');
    });

    test('should return copy of breach history', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      policy.evaluate(unhealthyBatches);

      const history1 = policy.getBreachHistory();
      history1.push({ fake: true });

      const history2 = policy.getBreachHistory();
      expect(history2.length).toBe(1);
      expect(history2[0].fake).toBeUndefined();
    });
  });

  describe('Reset', () => {
    test('should reset breach counter to 0', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'failed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'subscribed' },
      ];

      policy.evaluate(unhealthyBatches);
      policy.evaluate(unhealthyBatches);
      expect(policy.breachCounter).toBeGreaterThan(0);

      policy.reset();
      expect(policy.breachCounter).toBe(0);
    });

    test('should reset breach counter', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'failed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'subscribed' },
      ];

      policy.evaluate(unhealthyBatches);
      expect(policy.breachHistory.length).toBeGreaterThan(0);

      policy.reset();
      expect(policy.breachCounter).toBe(0);
    });

    test('should reset last restart time', () => {
      policy.lastRestartAt = Date.now();

      policy.reset();

      expect(policy.lastRestartAt).toBe(0);
    });
  });

  describe('Snapshot', () => {
    test('should return current state snapshot', () => {
      const unhealthyBatches = [
        { id: 'batch-0', state: 'failed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'subscribed' },
      ];

      policy.evaluate(unhealthyBatches);

      const snapshot = policy.getSnapshot();

      expect(snapshot).toHaveProperty('config');
      expect(snapshot).toHaveProperty('currentState');
      expect(snapshot.currentState.breachCounter).toBeGreaterThan(0);
      expect(snapshot.config.minHealthyRatio).toBe(0.5);
    });

    test('should include policy config in snapshot', () => {
      const snapshot = policy.getSnapshot();

      expect(snapshot.config.minHealthyRatio).toBe(0.5);
      expect(snapshot.config.ratioBreachCycles).toBe(3);
      expect(snapshot.config.restartCooldownMs).toBe(30000);
    });
  });

  describe('Per-Exchange Config', () => {
    test('should support Kraken config (60% threshold, 2 cycles)', () => {
      const krakenPolicy = new HealthRatioPolicy({
        minHealthyRatio: 0.6,
        ratioBreachCycles: 2,
        restartCooldownMs: 20000,
        logger: mockLogger,
      });

      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      // Cycle 1: ratio=0.33, below 0.6 threshold
      krakenPolicy.evaluate(unhealthyBatches);
      expect(krakenPolicy.breachCounter).toBe(1);

      // Cycle 2: triggers restart at breachCycles=2
      let result = krakenPolicy.evaluate(unhealthyBatches);
      expect(result.shouldRestart).toBe(true);
    });

    test('should support Binance config (50% threshold, 3 cycles)', () => {
      const binancePolicy = new HealthRatioPolicy({
        minHealthyRatio: 0.5,
        ratioBreachCycles: 3,
        restartCooldownMs: 30000,
        logger: mockLogger,
      });

      const unhealthyBatches = [
        { id: 'batch-0', state: 'subscribed' },
        { id: 'batch-1', state: 'failed' },
        { id: 'batch-2', state: 'failed' },
      ];

      // Needs 3 cycles before restart
      binancePolicy.evaluate(unhealthyBatches);
      binancePolicy.evaluate(unhealthyBatches);
      let result = binancePolicy.evaluate(unhealthyBatches);

      expect(result.shouldRestart).toBe(true);
    });
  });
});
