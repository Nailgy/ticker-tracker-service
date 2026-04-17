/**
 * StaleWatchdog Unit Tests
 *
 * Tests escalation levels, state transitions, auto-recovery
 */

const StaleWatchdog = require('../../src/core/stale-watchdog');

describe('StaleWatchdog', () => {
  let watchdog;
  const mockLogger = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    watchdog = new StaleWatchdog('batch-0', {
      logger: mockLogger,
      staleTimeoutMs: 60000,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Initialization', () => {
    test('should start at HEALTHY level', () => {
      expect(watchdog.currentLevel).toBe(0);  // HEALTHY
      expect(watchdog.getLevelName()).toBe('HEALTHY');
    });

    test('should have empty escalation history', () => {
      expect(watchdog.escalationHistory.length).toBe(0);
    });

    test('should have initial data time', () => {
      expect(watchdog.lastDataAt).toBeDefined();
    });

    test('should use default stale timeout if not provided', () => {
      const defaultWatchdog = new StaleWatchdog('batch-1', {});
      expect(defaultWatchdog.staleTimeoutMs).toBe(60000);
    });
  });

  describe('Level Names', () => {
    test('should return correct level names', () => {
      expect(watchdog.getLevelName()).toBe('HEALTHY');

      watchdog.currentLevel = 1;
      expect(watchdog.getLevelName()).toBe('WARNED');

      watchdog.currentLevel = 2;
      expect(watchdog.getLevelName()).toBe('RECOVERING');

      watchdog.currentLevel = 3;
      expect(watchdog.getLevelName()).toBe('FAILED');
    });
  });

  describe('Data Recording', () => {
    test('should reset to HEALTHY when data received', () => {
      // Move to WARNED level (simulate stale)
      watchdog.currentLevel = 1;
      watchdog.lastDataAt = Date.now() - 120000;  // 2 minutes ago

      watchdog.recordData();

      expect(watchdog.currentLevel).toBe(0);  // Back to HEALTHY
      expect(watchdog.getLevelName()).toBe('HEALTHY');
    });

    test('should update lastDataAt when data received', () => {
      const oldTime = Date.now() - 100000;
      watchdog.lastDataAt = oldTime;

      const now = Date.now();
      watchdog.recordData();

      expect(watchdog.lastDataAt).toBeGreaterThan(oldTime);
      expect(watchdog.lastDataAt).toBeGreaterThanOrEqual(now);
    });

    test('should add to escalation history when recovering to healthy', () => {
      watchdog.currentLevel = 2;  // RECOVERING

      watchdog.recordData();

      expect(watchdog.escalationHistory.length).toBeGreaterThan(0);
      // Last entry should be recovery event
      const lastEntry = watchdog.escalationHistory[watchdog.escalationHistory.length - 1];
      expect(lastEntry.to).toBe('HEALTHY');
    });

    test('should not escalate if data keeps arriving', () => {
      watchdog.recordData();
      expect(watchdog.currentLevel).toBe(0);

      jest.advanceTimersByTime(30000);  // 30 seconds later
      watchdog.recordData();
      expect(watchdog.currentLevel).toBe(0);

      jest.advanceTimersByTime(30000);  // 30 more seconds
      watchdog.recordData();
      expect(watchdog.currentLevel).toBe(0);
    });
  });

  describe('Escalation Flow', () => {
    test('should escalate HEALTHY → WARNED after stale timeout', () => {
      // Set data time to past
      watchdog.lastDataAt = Date.now() - 70000;  // 70 seconds ago, past 60s timeout

      const result = watchdog.checkStale();

      expect(watchdog.currentLevel).toBe(1);  // WARNED
      expect(result.level).toBe('WARNED');
      expect(result.action).toBe('warn');
    });

    test('should escalate WARNED → RECOVERING on next check', () => {
      watchdog.currentLevel = 1;  // WARNED
      watchdog.lastDataAt = Date.now() - 70000;  // Still stale

      const result = watchdog.checkStale();

      expect(watchdog.currentLevel).toBe(2);  // RECOVERING
      expect(result.level).toBe('RECOVERING');
      expect(result.action).toBe('recover');
    });

    test('should escalate RECOVERING → FAILED on continued stale', () => {
      watchdog.currentLevel = 2;  // RECOVERING
      watchdog.lastDataAt = Date.now() - 70000;  // Still stale

      const result = watchdog.checkStale();

      expect(watchdog.currentLevel).toBe(3);  // FAILED
      expect(result.level).toBe('FAILED');
      expect(result.action).toBe('fail');
    });

    test('should stay FAILED if still stale', () => {
      watchdog.currentLevel = 3;  // FAILED
      watchdog.lastDataAt = Date.now() - 70000;  // Still stale

      const result = watchdog.checkStale();

      expect(watchdog.currentLevel).toBe(3);  // Remains FAILED
      expect(result.level).toBe('FAILED');
      expect(result.action).toBe('none');  // Already failed, no further action
    });

    test('should not escalate if data arrives during degraded state', () => {
      watchdog.lastDataAt = Date.now() - 70000;  // Stale
      watchdog.checkStale();
      expect(watchdog.currentLevel).toBe(1);  // WARNED

      // Data arrives!
      watchdog.recordData();
      expect(watchdog.currentLevel).toBe(0);  // Back to HEALTHY

      // Next check should keep it healthy
      const result = watchdog.checkStale();
      expect(result.level).toBe('HEALTHY');
    });
  });

  describe('Escalation History', () => {
    test('should record each escalation event', () => {
      watchdog.lastDataAt = Date.now() - 70000;
      watchdog.checkStale();  // HEALTHY → WARNED

      watchdog.checkStale();  // WARNED → RECOVERING

      const history = watchdog.getEscalationHistory();
      expect(history.length).toBe(2);
      expect(history[0].to).toBe('WARNED');
      expect(history[1].to).toBe('RECOVERING');
    });

    test('should include timestamp with each escalation', () => {
      const before = Date.now();
      watchdog.lastDataAt = Date.now() - 70000;
      watchdog.checkStale();
      const after = Date.now();

      const history = watchdog.getEscalationHistory();
      const escalation = history[0];

      expect(escalation.timestamp).toBeGreaterThanOrEqual(before);
      expect(escalation.timestamp).toBeLessThanOrEqual(after);
    });

    test('should include reason for escalation', () => {
      watchdog.lastDataAt = Date.now() - 70000;
      watchdog.checkStale();

      const history = watchdog.getEscalationHistory();
      expect(history[0].reason).toBeDefined();
      expect(history[0].reason).toContain('no data');
    });

    test('should record recovery events', () => {
      watchdog.currentLevel = 2;  // RECOVERING
      watchdog.recordData();  // Recover to HEALTHY

      const history = watchdog.getEscalationHistory();
      const recovery = history[0];

      expect(recovery.to).toBe('HEALTHY');
      expect(recovery.reason).toContain('recovered');
    });

    test('should return copy of history', () => {
      watchdog.lastDataAt = Date.now() - 70000;
      watchdog.checkStale();

      const history1 = watchdog.getEscalationHistory();
      history1.push({ fake: true });

      const history2 = watchdog.getEscalationHistory();
      expect(history2.length).toBe(1);
      expect(history2[0].fake).toBeUndefined();
    });
  });

  describe('Reset', () => {
    test('should reset level to HEALTHY', () => {
      watchdog.currentLevel = 3;  // FAILED

      watchdog.reset();

      expect(watchdog.currentLevel).toBe(0);  // HEALTHY
      expect(watchdog.getLevelName()).toBe('HEALTHY');
    });

    test('should reset lastDataAt to now', () => {
      watchdog.lastDataAt = Date.now() - 100000;

      const before = Date.now();
      watchdog.reset();
      const after = Date.now();

      expect(watchdog.lastDataAt).toBeGreaterThanOrEqual(before);
      expect(watchdog.lastDataAt).toBeLessThanOrEqual(after);
    });
  });

  describe('Check Stale Return Values', () => {
    test('should return action on each check', () => {
      watchdog.lastDataAt = Date.now() - 70000;

      const result = watchdog.checkStale();

      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('level');
      expect(result).toHaveProperty('ms');
      expect(['warn', 'recover', 'fail', 'none']).toContain(result.action);
    });

    test('should include time since last data in result', () => {
      const staleTime = 70000;
      watchdog.lastDataAt = Date.now() - staleTime;

      const result = watchdog.checkStale();

      expect(result).toHaveProperty('ms');
      expect(result.ms).toBeGreaterThanOrEqual(staleTime);
    });
  });

  describe('Per-Exchange Configuration', () => {
    test('should support custom stale timeout (30s for fast exchanges)', () => {
      const fastWatchdog = new StaleWatchdog('batch-fast', {
        staleTimeoutMs: 30000,  // 30s instead of 60s
      });

      fastWatchdog.lastDataAt = Date.now() - 35000;  // 35s without data

      const result = fastWatchdog.checkStale();

      // Should escalate because 35s > 30s timeout
      expect(fastWatchdog.currentLevel).toBe(1);  // WARNED
    });

    test('should support generous stale timeout (120s for slow exchanges)', () => {
      const slowWatchdog = new StaleWatchdog('batch-slow', {
        staleTimeoutMs: 120000,  // 120s
      });

      slowWatchdog.lastDataAt = Date.now() - 70000;  // 70s without data

      const result = slowWatchdog.checkStale();

      // Should NOT escalate because 70s < 120s timeout
      expect(slowWatchdog.currentLevel).toBe(0);  // Still HEALTHY
      expect(result.action).toBe('none');
    });
  });

  describe('Continuous Stale Detection', () => {
    test('should properly track escalation over multiple checks', () => {
      watchdog.lastDataAt = Date.now() - 70000;

      // Check 1: HEALTHY → WARNED
      let result = watchdog.checkStale();
      expect(result.level).toBe('WARNED');

      // Check 2: WARNED → RECOVERING
      result = watchdog.checkStale();
      expect(result.level).toBe('RECOVERING');

      // Check 3: RECOVERING → FAILED
      result = watchdog.checkStale();
      expect(result.level).toBe('FAILED');

      // Check 4: FAILED → FAILED (no change)
      result = watchdog.checkStale();
      expect(result.level).toBe('FAILED');
      expect(result.action).toBe('none');
    });

    test('should auto-recover when data arrives during any escalation level', () => {
      watchdog.lastDataAt = Date.now() - 70000;

      // Escalate to RECOVERING
      watchdog.checkStale();
      watchdog.checkStale();

      expect(watchdog.getLevelName()).toBe('RECOVERING');

      // Data arrives
      watchdog.recordData();

      expect(watchdog.getLevelName()).toBe('HEALTHY');
    });
  });

  describe('Snapshot', () => {
    test('should return watchdog snapshot', () => {
      const snapshot = watchdog.getSnapshot();

      expect(snapshot).toHaveProperty('batchId');
      expect(snapshot).toHaveProperty('currentLevel');
      expect(snapshot).toHaveProperty('lastDataAt');
      expect(snapshot).toHaveProperty('staleTimeoutMs');
      expect(snapshot).toHaveProperty('historyLength');
      expect(snapshot.batchId).toBe('batch-0');
      expect(snapshot.currentLevel).toBe('HEALTHY');
    });
  });
});
