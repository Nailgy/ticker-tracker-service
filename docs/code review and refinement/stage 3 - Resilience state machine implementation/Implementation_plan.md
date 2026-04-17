# Stage 3 Implementation Plan - Resilience & State Machine Hardening

## Context - Senior Backend Developer Verdict

**Current Status**: Stage 2 ✅ APPROVED (105 tests, per-batch isolation proven)

**Stage 3 Verdict**: ⚠️ NOT PASS YET - Partial Implementation

The backend developer reviewed Stage 3 requirements (Resilience/state machine implementation) and found:
- ✅ **Capped exponential backoff**: Already present
- ⚠️ **Explicit connection state machine**: Only state strings, no guarded transitions
- ⚠️ **Stale watchdog**: Basic detection exists, recovery policy incomplete
- ❌ **Healthy-connection ratio restart policy**: MISSING entirely
- ❌ **Retry-timer registry**: MISSING - timers use bare _sleep, no per-batch tracking
- ❌ **Hard non-retryable eviction**: Only removes from active, not from desired state model

**What's Needed to PASS**:
1. **3A**: Explicit state machine with guarded transitions, reason tracking, per-batch
2. **3B**: Retry-timer registry (Map<batchId, timeoutHandle>) with cancellation
3. **3C**: Healthy-connection ratio policy with thresholds and restart triggers
4. **3D**: Stale watchdog escalation (warn → recover → fail) with per-batch recovery first
5. **3E**: Hard non-retryable symbol eviction from BOTH desired + active sets
6. **3F**: Comprehensive tests for all 5 above items

**Impact**: Move from health-only metrics to true connection-aware resilience

---

## Stage 3 Requirements Breakdown

### 3A: Explicit State Machine with Guarded Transitions

**Current State**: Strings only (idle, subscribing, stale, failed, recovering)
**Required**: Formal state machine with legal transitions, transition guards, and auditability

**File Location**: `src/core/state-machine.js` (NEW) + refactored `src/core/adapter.pool.js`

**Implementation**:
```javascript
// NEW FILE: src/core/state-machine.js
class ConnectionStateMachine {
  constructor(batchId, config = {}) {
    this.batchId = batchId;
    this.currentState = 'idle';
    this.transitionHistory = [];  // Track all state changes
    this.legalTransitions = {
      'idle':        ['connecting', 'failed'],
      'connecting':  ['subscribed', 'stale', 'failed'],
      'subscribed':  ['stale', 'connecting', 'failed'],
      'stale':       ['recovering', 'failed'],
      'recovering':  ['subscribed', 'failed'],
      'failed':      ['connecting'],  // Only retry or give up
    };
  }
  
  // Guarded transition with reason tracking
  transition(newState, reason = '', metadata = {}) {
    const legal = this.legalTransitions[this.currentState] || [];
    if (!legal.includes(newState)) {
      throw new Error(
        `Invalid transition: ${this.currentState} → ${newState} [batch: ${this.batchId}]`
      );
    }
    
    const record = {
      from: this.currentState,
      to: newState,
      reason: reason,
      timestamp: Date.now(),
      metadata: metadata,
    };
    
    this.transitionHistory.push(record);
    this.currentState = newState;
    return record;
  }
  
  // Get full audit trail
  getTransitionHistory() {
    return [...this.transitionHistory];  // Copy to prevent mutation
  }
}
```

**Where Used**:
- AdapterPool wraps each batch with state machine instance
- SubscriptionEngine calls `stateMachine.transition()` instead of direct state assignment
- Each transition logged with reason + timestamp for auditability
- Line in adapter.pool.js: `this.stateMachine = new ConnectionStateMachine(batchId);`

**Benefits**:
- ✅ No illegal transitions (catches bugs)
- ✅ Auditability: why did state change and when
- ✅ Testable: verify transition sequences via history

---

### 3B: Retry-Timer Registry with Per-Batch Cancellation

**Current State**: Retry delays use `await _sleep(ms)` (Promise-based, transient)
**Required**: Explicit timer registry Map<batchId, timeoutHandle> with cancellation ownership

**File Location**: `src/core/retry-timer-registry.js` (NEW) + refactored `src/core/subscription.engine.js`

**Implementation**:
```javascript
// NEW FILE: src/core/retry-timer-registry.js
class RetryTimerRegistry {
  constructor(config = {}) {
    this.timers = new Map();  // Map<batchId, Set<timeoutHandle>>
    this.config = config;
    this.logger = config.logger || (() => {});
  }
  
  // Register a pending retry timer for a batch
  registerTimer(batchId, timeoutHandle) {
    if (!this.timers.has(batchId)) {
      this.timers.set(batchId, new Set());
    }
    this.timers.get(batchId).add(timeoutHandle);
    return timeoutHandle;
  }
  
  // Cancel all timers for a batch (cleanup on batch removal)
  cancelBatchTimers(batchId) {
    const handles = this.timers.get(batchId) || [];
    let cancelled = 0;
    
    for (const handle of handles) {
      clearTimeout(handle);
      cancelled++;
    }
    
    this.timers.delete(batchId);
    return { batchId, cancelled };
  }
  
  // Cancel ALL pending timers (engine shutdown)
  cancelAllTimers() {
    let totalCancelled = 0;
    
    for (const [batchId, handles] of this.timers.entries()) {
      for (const handle of handles) {
        clearTimeout(handle);
        totalCancelled++;
      }
    }
    
    this.timers.clear();
    return { totalCancelled };
  }
  
  // Query: how many timers pending per batch
  getStats() {
    const stats = {};
    for (const [batchId, handles] of this.timers.entries()) {
      stats[batchId] = handles.size;
    }
    return stats;
  }
}
```

**Integration in SubscriptionEngine**:
```javascript
// In subscription.engine.js constructor
this.timerRegistry = new RetryTimerRegistry({ logger: config.logger });

// In _subscriptionLoop when scheduling retry
const delay = this.retryScheduler.calculateBackoff(loopState.retryAttempts);
const timeoutHandle = setTimeout(() => {
  // Actual retry logic
}, delay);
this.timerRegistry.registerTimer(batchId, timeoutHandle);
await new Promise(r => this.timerRegistry.registerTimer(batchId, setTimeout(r, delay)));

// In stopSubscriptions() cleanup
this.timerRegistry.cancelAllTimers();

// When removing a batch
this.timerRegistry.cancelBatchTimers(batchId);
```

**Benefits**:
- ✅ All retry delays explicitly tracked
- ✅ Per-batch timer cancellation (no orphaned timers)
- ✅ Clean shutdown: cancel all timers atomically
- ✅ Testable: inspect pending timers via getStats()

---

### 3C: Healthy-Connection Ratio Policy

**Current State**: Per-batch health tracking only
**Required**: Global health ratio with restart trigger when unhealthy/total < threshold

**File Location**: `src/core/health-ratio-policy.js` (NEW) + `src/core/subscription.engine.js` integration

**Implementation**:
```javascript
// NEW FILE: src/core/health-ratio-policy.js
class HealthRatioPolicy {
  constructor(config = {}) {
    this.minHealthyRatio = config.minHealthyRatio || 0.5;        // 50% healthy minimum
    this.ratioBreachCycles = config.ratioBreachCycles || 3;       // 3 cycles before restart
    this.restartCooldownMs = config.restartCooldownMs || 30000;   // 30s cooldown
    
    this.breachCounter = 0;
    this.lastRestartAt = 0;
    this.logger = config.logger || (() => {});
  }
  
  // Call once per health-check cycle (e.g., every 15s)
  evaluate(batchHealthList) {
    if (!batchHealthList || batchHealthList.length === 0) {
      return { shouldRestart: false, reason: 'no batches' };
    }
    
    const healthy = batchHealthList.filter(h => h.state === 'subscribed').length;
    const total = batchHealthList.length;
    const ratio = healthy / total;
    
    const meetsMinimum = ratio >= this.minHealthyRatio;
    
    if (!meetsMinimum) {
      this.breachCounter++;
      
      if (this.breachCounter >= this.ratioBreachCycles) {
        const timeSinceLastRestart = Date.now() - this.lastRestartAt;
        
        if (timeSinceLastRestart >= this.restartCooldownMs) {
          this.lastRestartAt = Date.now();
          this.breachCounter = 0;  // Reset counter after restart
          
          return {
            shouldRestart: true,
            reason: `health ratio ${ratio.toFixed(2)} < ${this.minHealthyRatio} for ${this.breachCounter} cycles`,
            healthy,
            total,
            ratio,
          };
        }
      }
    } else {
      this.breachCounter = 0;  // Reset on good health
    }
    
    return {
      shouldRestart: false,
      reason: 'health ratio acceptable',
      healthy,
      total,
      ratio,
    };
  }
  
  reset() {
    this.breachCounter = 0;
    this.lastRestartAt = 0;
  }
}
```

**Integration in SubscriptionEngine health-check loop** (line ~350):
```javascript
// In global health check (setInterval)
const allBatchHealth = this.adapterPool.getAllBatchHealth();
const ratioDecision = this.healthRatioPolicy.evaluate(allBatchHealth);

if (ratioDecision.shouldRestart) {
  this.logger('warn', `SubscriptionEngine: Health ratio trigger restart [${ratioDecision.reason}]`);
  this.metrics.ratioRestartCount++;
  
  // Controlled recycle: stop + restart subscriptions
  await this.stopSubscriptions();
  await this.startSubscriptions(this.currentBatches);
}
```

**Config in constants/exchanges.js**:
```javascript
binance: {
  healthRatioPolicy: {
    minHealthyRatio: 0.5,        // Restart if < 50% batches healthy
    ratioBreachCycles: 3,        // After 3 bad cycles (45s)
    restartCooldownMs: 30000,    // Cooldown between restarts
  }
}
```

**Benefits**:
- ✅ Global health monitoring (not per-batch only)
- ✅ Automatic controlled recycle when degraded
- ✅ Cooldown prevents restart loops
- ✅ Auditability: track restart reasons in metrics

---

### 3D: Stale Watchdog Escalation Model

**Current State**: Stale detection exists, recovery is immediate reset
**Required**: Escalation path (warn → recover attempt → fail) with per-batch first, global via ratio policy

**File Location**: `src/core/stale-watchdog.js` (NEW) + integration in `src/core/adapter.pool.js`

**Implementation**:
```javascript
// NEW FILE: src/core/stale-watchdog.js
class StaleWatchdog {
  constructor(batchId, config = {}) {
    this.batchId = batchId;
    this.staleTimeoutMs = config.staleTimeoutMs || 60000;  // 60s stale threshold
    this.escalationLevels = {
      HEALTHY: 0,
      WARNED: 1,
      RECOVERING: 2,
      FAILED: 3,
    };
    
    this.currentLevel = this.escalationLevels.HEALTHY;
    this.escalationHistory = [];
    this.lastDataAt = Date.now();
    this.logger = config.logger || (() => {});
  }
  
  // Record ticker data received
  recordData() {
    this.lastDataAt = Date.now();
    if (this.currentLevel > this.escalationLevels.HEALTHY) {
      // Recovery: data received while in degraded state
      this._recordEscalation('DATA_RECEIVED', this.escalationLevels.HEALTHY, 'connection recovered');
      this.currentLevel = this.escalationLevels.HEALTHY;
    }
  }
  
  // Check for staleness (called by watchdog interval)
  checkStale(currentTime = Date.now()) {
    const timeSinceData = currentTime - this.lastDataAt;
    
    if (timeSinceData > this.staleTimeoutMs) {
      // Escalate: WARNED → RECOVERING → FAILED
      switch (this.currentLevel) {
        case this.escalationLevels.HEALTHY:
          this._recordEscalation('STALE_DETECTED', this.escalationLevels.WARNED, `no data for ${timeSinceData}ms`);
          this.currentLevel = this.escalationLevels.WARNED;
          return { action: 'warn', level: 'WARNED' };
          
        case this.escalationLevels.WARNED:
          this._recordEscalation('ESCALATE_RECOVER', this.escalationLevels.RECOVERING, 'attempt per-batch recovery');
          this.currentLevel = this.escalationLevels.RECOVERING;
          return { action: 'recover', level: 'RECOVERING' };
          
        case this.escalationLevels.RECOVERING:
          this._recordEscalation('ESCALATE_FAIL', this.escalationLevels.FAILED, 'recovery failed, batch stale');
          this.currentLevel = this.escalationLevels.FAILED;
          return { action: 'fail', level: 'FAILED' };
          
        case this.escalationLevels.FAILED:
          return { action: 'none', level: 'FAILED', reason: 'already failed' };
      }
    }
    
    return { action: 'none', level: this.currentLevel };
  }
  
  // Get escalation audit trail
  getEscalationHistory() {
    return [...this.escalationHistory];
  }
  
  _recordEscalation(event, newLevel, reason) {
    this.escalationHistory.push({
      event,
      previousLevel: this.currentLevel,
      newLevel,
      reason,
      timestamp: Date.now(),
    });
  }
}
```

**Integration in AdapterPool** (lines ~150-190):
```javascript
// Each batch wrapper includes watchdog
const wrapper = {
  id: batchId,
  adapter: adapter,
  state: 'idle',
  staleWatchdog: new StaleWatchdog(batchId, config.healthConfig),
  // ...
};

// In health check loop, use watchdog escalation
const staleCheck = wrapper.staleWatchdog.checkStale();
if (staleCheck.action === 'recover') {
  // Per-batch recovery attempt (per-batch first!)
  await this.resetBatchForRecovery(batchId);
} else if (staleCheck.action === 'fail') {
  // Mark for global restart via health ratio policy
  wrapper.state = 'failed';
}
```

**Benefits**:
- ✅ Escalation prevents false positives (1 alert → attempt recovery → fail if persistent)
- ✅ Per-batch recovery FIRST (ratio policy triggers global restart only if needed)
- ✅ Auditability: escalation history shows exactly when/why state changed
- ✅ Configurable thresholds per exchange

---

### 3E: Hard Non-Retryable Eviction from Desired + Active Sets

**Current State**: markNonRetryable() removes from active + batch allocations only
**Required**: Also remove from desired state, add metadata (reason, firstSeen, lastSeen)

**File Location**: Refactored `src/core/market.registry.js` + `src/core/non-retryable-registry.js` (NEW)

**Implementation Enhancement**:
```javascript
// NEW FILE: src/core/non-retryable-registry.js
class NonRetryableRegistry {
  constructor(config = {}) {
    this.symbolsRegistry = new Map();  // symbol → { reason, firstSeen, lastSeen, attempts }
    this.logger = config.logger || (() => {});
  }
  
  // Mark symbol as permanently non-retryable with metadata
  markNonRetryable(symbol, reason = 'unknown', metadata = {}) {
    if (!this.symbolsRegistry.has(symbol)) {
      this.symbolsRegistry.set(symbol, {
        symbol,
        reason,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        attempts: 1,
        batchId: metadata.batchId,
        errorMessage: metadata.errorMessage,
      });
    } else {
      const record = this.symbolsRegistry.get(symbol);
      record.lastSeen = Date.now();
      record.attempts++;
    }
  }
  
  // Get full audit trail for a symbol
  getSymbolRecord(symbol) {
    return this.symbolsRegistry.get(symbol);
  }
  
  // Get all non-retryable symbols
  getAllNonRetryableSymbols() {
    return [...this.symbolsRegistry.keys()];
  }
  
  // Audit: when was symbol marked non-retryable
  getAuditTrail() {
    return Array.from(this.symbolsRegistry.values());
  }
}
```

**Integration in MarketRegistry** (lines ~156-191):
```javascript
// Constructor: add non-retryable metadata tracking
this.nonRetryableMetadata = new NonRetryableRegistry(config);

markNonRetryable(symbols) {
  const marked = [];
  
  for (const symbol of symbols) {
    if (!this.nonRetryableSymbols.has(symbol)) {
      // Step 1: Remove from active (existing)
      this.activeSymbols.delete(symbol);
      marked.push(symbol);
      
      // Step 2: Remove from DESIRED (NEW)
      this.desiredSymbols.delete(symbol);
      
      // Step 3: Remove from batch allocations (existing)
      const batchId = this.symbolToBatchMap.get(symbol);
      if (batchId) { /* ... */ }
      
      // Step 4: Add to non-retryable with metadata (NEW)
      this.nonRetryableSymbols.add(symbol);
      this.nonRetryableMetadata.markNonRetryable(
        symbol,
        'permanent-delisted',  // reason
        { batchId, errorMessage: 'Symbol not found' }  // metadata
      );
    }
  }
  
  return { marked, auditTrail: this.nonRetryableMetadata.getAuditTrail() };
}
```

**Benefits**:
- ✅ Hard eviction: symbol removed from BOTH active AND desired (can't be re-added by market refresh)
- ✅ Auditability: reason, firstSeen, lastSeen, attempts tracked
- ✅ Forensics: can analyze non-retryable symbols for patterns (e.g., delisting trend)
- ✅ Flexible re-enabling: can call `addSymbols([symbol])` to override if needed

---

### 3F: Comprehensive Tests for Stage 3 Requirements

**File Location**: `tests/integration/stage-3-resilience-state-machine.test.js` (NEW)

**Test Coverage** (~500-700 lines, 20+ test cases):

```javascript
describe('Stage 3: Resilience & State Machine Hardening', () => {
  // 3A: State Machine Tests (6 tests)
  describe('3A: Explicit Connection State Machine', () => {
    test('valid transition: idle → connecting → subscribed'),
    test('valid transition: subscribed → stale → recovering → subscribed'),
    test('invalid transition: subscribed → idle (should throw)'),
    test('transition history tracks reason + timestamp'),
    test('state machine rejects illegal transitions with clear error'),
    test('audit trail shows full transition sequence per batch'),
  });
  
  // 3B: Retry-Timer Registry Tests (5 tests)
  describe('3B: Retry-Timer Registry with Per-Batch Cancellation', () => {
    test('registerTimer tracks timeout handles per batchId'),
    test('cancelBatchTimers clears all timers for batch'),
    test('cancelAllTimers clears timers across all batches'),
    test('getStats returns pending timer count per batch'),
    test('cleanup prevents timer callback execution after cancel'),
  });
  
  // 3C: Health Ratio Policy Tests (4 tests)
  describe('3C: Healthy-Connection Ratio Policy', () => {
    test('ratio below threshold increments breach counter'),
    test('restart triggered after N breach cycles'),
    test('cooldown prevents rapid restart loops'),
    test('ratio recovery resets breach counter'),
  });
  
  // 3D: Stale Watchdog Escalation Tests (4 tests)
  describe('3D: Stale Watchdog Escalation Model', () => {
    test('stale watchdog escalates: HEALTHY → WARNED → RECOVERING → FAILED'),
    test('data reception during WARNED state recovers to HEALTHY'),
    test('escalation history records event, reason, timestamp'),
    test('per-batch recovery attempt before global restart'),
  });
  
  // 3E: Hard Non-Retryable Eviction Tests (3 tests)
  describe('3E: Hard Non-Retryable Symbol Eviction', () => {
    test('markNonRetryable removes from BOTH active AND desired sets'),
    test('non-retryable metadata tracks reason, firstSeen, lastSeen, attempts'),
    test('audit trail shows symbol eviction history with reasons'),
  });
  
  // Integration Tests (5 tests)
  describe('Integration: Full Resilience Flow', () => {
    test('stale detection → per-batch recovery → healthy ratio maintained'),
    test('multiple stale batches trigger global restart via ratio policy'),
    test('non-retryable symbols prevent infinite retry loop'),
    test('retry timers cleaned up on engine shutdown'),
    test('state machine enforces legal transitions throughout lifecycle'),
  });
});
```

**Test Strategy**:
- Unit tests for each component (state machine, timer registry, ratio policy, watchdog)
- Integration tests using mock adapters and fake timers
- Verify state transitions are guarded and auditable
- Prove per-batch recovery happens before global restart
- Validate cleanup and timer cancellation

---

## Critical Files to Create / Modify

**NEW FILES** (6 files, ~800 LOC):
1. `src/core/state-machine.js` - ConnectionStateMachine with guarded transitions (150 LOC)
2. `src/core/retry-timer-registry.js` - TimerRegistry for cleanup management (120 LOC)
3. `src/core/health-ratio-policy.js` - Global health ratio monitoring (150 LOC)
4. `src/core/stale-watchdog.js` - Escalation model (WARNED → RECOVERING → FAILED) (150 LOC)
5. `src/core/non-retryable-registry.js` - Metadata tracking for hard eviction (100 LOC)
6. `tests/integration/stage-3-resilience-state-machine.test.js` - 20+ tests (600 LOC)

**MODIFIED FILES** (4 files, ~400 LOC changes):
1. `src/core/adapter.pool.js` - Use state machine, watchdog, register timers (~200 lines changed)
2. `src/core/subscription.engine.js` - Use timer registry, health ratio policy (~150 lines changed)
3. `src/core/market.registry.js` - Hard eviction from desired + active, metadata tracking (~100 lines changed)
4. `src/constants/exchanges.js` - Add health policy config thresholds per exchange (~50 lines changed)

---

## Implementation Sequence

### Phase 1: Core Components (2-3 hours)
1. Create state-machine.js with guarded transitions
2. Create retry-timer-registry.js with per-batch cleanup
3. Create health-ratio-policy.js with restart logic
4. Create stale-watchdog.js with escalation
5. Create non-retryable-registry.js with metadata

### Phase 2: Integration (2-3 hours)
1. Refactor adapter.pool.js to use state machine, watchdog, register timers
2. Refactor subscription.engine.js to use timer registry, evaluate health ratio
3. Refactor market.registry.js for hard eviction from desired + active
4. Update constants/exchanges.js with health policy config

### Phase 3: Testing & Validation (2-3 hours)
1. Create comprehensive Stage 3 test suite (20+ tests)
2. Verify all components independently (unit tests)
3. Verify integration flows (integration tests)
4. Regression test: ensure Stage 2 tests still pass (105+ tests)

### Phase 4: Documentation (1 hour)
1. Create Stage 3 docs in `docs/code review and refinement/stage 3 - Resilience/`
2. Update MEMORY.md with Stage 3 completion status
3. Create migration guide for Stage 3 concepts

---

## Success Criteria

✅ **3A - Explicit State Machine**
- All state transitions guarded (invalid transitions throw)
- Transition history tracked with reason + timestamp
- Test: verify 5+ different state sequences work as expected

✅ **3B - Retry-Timer Registry**
- All retry delays registered in per-batch registry
- cancelBatchTimers() clears all timers for batch
- cancelAllTimers() used in engine shutdown
- Test: verify timers prevented from executing after cancel

✅ **3C - Healthy-Connection Ratio Policy**
- Global health ratio computed per cycle
- Threshold breach counter increments
- Restart triggered after N cycles with cooldown
- Test: verify restart triggered at correct ratio + cycle count

✅ **3D - Stale Watchdog Escalation**
- Escalation path HEALTHY → WARNED → RECOVERING → FAILED
- Per-batch recovery attempted before global restart
- Escalation history tracks all state changes
- Test: verify escalation sequence and recovery from WARNED

✅ **3E - Hard Non-Retryable Eviction**
- Symbols removed from BOTH desired AND active
- Metadata tracked (reason, firstSeen, lastSeen, attempts, batchId)
- Audit trail queryable for forensics
- Test: verify symbol can't be re-added by market refresh

✅ **3F - Comprehensive Tests**
- 20+ tests covering all 5 requirements
- Unit + integration test coverage
- All tests passing with zero failures

✅ **Stage 2 Regression**
- All 105+ Stage 2 tests still passing
- Zero regressions from refactoring

---

## Estimated Effort

- **Phase 1** (Core Components): 2-3 hours
- **Phase 2** (Integration): 2-3 hours
- **Phase 3** (Testing): 2-3 hours
- **Phase 4** (Documentation): 1 hour
- **Total**: 7-10 hours

---

## Verification Checklist

Before submission to backend developer:

```
Phase 1 - Components:
☐ state-machine.js compiles, guarded transitions work
☐ retry-timer-registry.js registers/cancels timers
☐ health-ratio-policy.js evaluates ratio + breach counter
☐ stale-watchdog.js escalates correctly
☐ non-retryable-registry.js tracks metadata

Phase 2 - Integration:
☐ adapter.pool.js uses all 5 components
☐ subscription.engine.js uses timer registry + health ratio
☐ market.registry.js removes from desired + active
☐ No console errors, all imports resolve
☐ Stage 2 tests still pass (105+)

Phase 3 - Tests:
☐ Stage 3 test suite created (20+ tests)
☐ All Stage 3 tests passing
☐ All Stage 2 tests still passing (380+ total)

Phase 4 - Documentation:
☐ Stage 3 docs folder created
☐ README explaining all 5 features
☐ Code comments explain guarded transitions + escalation
☐ MEMORY.md updated with Stage 3 status
```

---

## Senior Developer Review Package

**Deliverables**:
1. Git diff showing state-machine, timer-registry, ratio-policy, watchdog, eviction
2. Test evidence: 380+ total tests passing
3. Code walkthrough: state transitions → integration flow
4. Architecture diagram: (optional) state machine + timer lifecycle
5. Metrics export: can query escalation history, audit trail per batch/symbol

**Sign-Off**: ✅ Ready for Stage 3 strict approval

---

## Critical Fixes Required - Detailed Analysis

### Fix 1: BatchWatchTickersStrategy - Batch Identity Bug (Hard Blocker)

**File**: `src/adapters/strategies/batch-watch-tickers.strategy.js`  
**Lines**: 64, 77, 101  
**Problem**: Uses `batchSymbols.join(',')` as batchIndex (string key) but pending Map uses numeric index `i`

**Current Buggy Code** (lines 63-77):
```javascript
for (let i = 0; i < batches.length; i++) {
  pending.set(i, this._watchBatch(exchange, batches[i]));  // Set with numeric key i
}
while (pending.size > 0) {
  const { symbol, ticker, batchIndex } = await Promise.race(pending.values());
  yield { symbol, ticker };
  pending.set(batchIndex, this._watchBatch(...));  // Re-set with batchIndex (WRONG!)
}
```

**Line 101 in _watchBatch**:
```javascript
return { symbol, ticker, batchIndex: batchSymbols.join(',') };  // String key!
```

**Why It's Wrong**:
- pending.set(i, ...) creates numeric keys: 0, 1, 2
- Line 77 tries to re-set with string key: "BTC/USDT,ETH/USDT"
- pending.get("BTC/USDT,ETH/USDT") returns undefined
- Re-subscription fails, batch drops out of race

**Fix Strategy**:
- Pass numeric batchIndex to _watchBatch() as parameter
- Return numeric batchIndex instead of join(',')
- Ensure pending.set() always uses numeric key
- Verify line 77: `pending.set(batchIndex, ...)` where batchIndex is numeric

---

### Fix 2: BatchWatchTickersStrategy - Data Loss Bug (Hard Blocker) 

**File**: `src/adapters/strategies/batch-watch-tickers.strategy.js`  
**Lines**: 100-103  
**Problem**: for-loop iterates all tickers but only returns first one

**Current Buggy Code**:
```javascript
for (const [symbol, ticker] of Object.entries(tickers)) {
  return { symbol, ticker, batchIndex: batchSymbols.join(',') };  // Returns only first!
}
```

**Why It's Wrong**:
- watchTickers() returns N tickers: {BTC/USDT: {...}, ETH/USDT: {...}, SOL/USDT: {...}}
- for-loop on line 100 iterates 3 times
- But `return` on line 101 exits after FIRST iteration
- Only BTC/USDT is ever returned
- ETH/USDT and SOL/USDT data is LOST

**Fix Strategy**:
- Convert to async generator or array collection
- Yield/collect ALL tickers before re-subscribe
- Restructure: `for each ticker → yield/collect it → continue → when done, move to next batch`

---

### Fix 3: BatchWatchTickersStrategy - Recursive Re-call Pattern

**File**: `src/adapters/strategies/batch-watch-tickers.strategy.js`  
**Lines**: 93-113  
**Problem**: _watchBatch() self-recurses on line 106 when no tickers returned

**Current Buggy Code**:
```javascript
async _watchBatch(exchange, batchSymbols) {
  const tickers = await exchange.watchTickers(batchSymbols);
  if (tickers && typeof tickers === 'object') {
    for (const [symbol, ticker] of Object.entries(tickers)) {
      return { symbol, ticker, batchIndex: batchSymbols.join(',') };
    }
  }
  // If no tickers returned, retry with RECURSION
  return await this._watchBatch(exchange, batchSymbols);  // Self-call!
}
```

**Why It's Wrong**:
- Under unstable network, watchTickers(batchSymbols) might return empty object
- Recursive call to _watchBatch() stacks on call stack
- If network unstable for 1000+ calls, stack overflows
- Unbounded recursion risk

**Fix Strategy**:
- Wrap in do-while or for loop instead of recursion
- Max retry attempts counter to prevent unbounded loops
- Proper backoff delay between retries (if any)
- Handle empty response gracefully

---

### Fix 4: CCXTAdapter - Missing Import Bug

**File**: `src/adapters/ccxt.adapter.js`  
**Lines**: 265  
**Problem**: References undefined `AllTickersStrategy` class

**Current Buggy Code** (line 265):
```javascript
isWatchTickersSupported() {
  return this.strategy instanceof AllTickersStrategy;  // Not imported!
}
```

**Why It's Wrong**:
- AllTickersStrategy is never imported at top of ccxt.adapter.js
- At runtime: ReferenceError: AllTickersStrategy is not defined
- Crashes when isWatchTickersSupported() called

**Fix Strategy - RECOMMENDED**:
- Option A: Import AllTickersStrategy and PerSymbolStrategy at top (adds dependencies)
- Option B: Check strategy mode string instead (better, no new imports):
  ```javascript
  isWatchTickersSupported() {
    const { STRATEGY_MODES } = require('./strategies/strategy.interface');
    return this.strategy.getMode() === STRATEGY_MODES.ALL_TICKERS;
  }
  ```
- Use Option B (cleaner, more maintainable)

---

### CRITICAL FIX: Per-Connection Isolation - Per-Batch Exchange Instances

**Files**: 
- `src/core/connection.manager.js`
- `src/core/subscription.engine.js`
- `src/core/adapter.pool.js` (refactor)
- `src/adapters/ccxt.adapter.js`

**Problem**: All batches currently share ONE CCXT exchange instance through ONE CCXTAdapter

**Current Flow** (problematic):
```javascript
// ConnectionManager
this.#adapter = adapterFactory(...);  // ONE instance
this.exchangeInstance = this.#adapter.exchange;  // Shared by all batches

// SubscriptionEngine
startSubscriptions(batches) {
  for (each batch) {
    this._subscriptionLoop(batch) {
      // ALL batches call:
      this.adapter.subscribe(symbols)  // Same adapter instance
    }
  }
}
```

**Required Flow** (per-connection):
```javascript
// ConnectionManager
this.#adapterPool = adapterPoolFactory(...);  // Factory mode

// SubscriptionEngine
startSubscriptions(batches) {
  for (each batch i) {
    const batchAdapter = this.#adapterPool.getBatchAdapter(i);  // Different instance per batch
    this._subscriptionLoop(batch, batchAdapter) {
      batchAdapter.subscribe(symbols)  // Own connection per batch
    }
  }
}
```

**Implementation Strategy**:

1. **Refactor AdapterPool**: Instead of health-only wrapper, make it a true adapter pool
   - Change constructor to accept `adapterFactory` that CREATES NEW instances
   - `getBatchAdapter(batchId)`: Create new CCXTAdapter for each batch
   - Each adapter has own CCXT exchange instance, own websocket connections
   - Result: N adapters with N connections for N batches

2. **Update SubscriptionEngine**:
   - Accept `adapterPoolFactory` instead of single adapter
   - In `startSubscriptions()`, get per-batch adapter: `adapter = adapterPool.getBatchAdapter(batchId)`
   - Pass batch-specific adapter to each subscription loop

3. **Update ConnectionManager**:
   - Create AdapterPool with factory function to create CCXTAdapters
   - Pass AdapterPool (not single adapter) to SubscriptionEngine

4. **Update CCXTAdapter**:
   - No changes needed; already creates one exchange instance per adapter
   - Multiple adapters = multiple exchange instances

**Benefits**:
- ✅ True per-connection isolation (not health-only)
- ✅ Batch-1 network failure doesn't affect Batch-2 connection
- ✅ Independent retry/recovery per batch connection
- ✅ Health metrics now reflect real connection states

---

### Fix 6: Add Real Behavior Tests for BatchWatchTickersStrategy

**File**: `tests/integration/stage-2-subscription-engine-redesign-complete.test.js` (new tests)  
**Location**: Add after line 1835 (end of current file)  

**Current Problem**: Tests use mock configuration but don't execute real `async *execute()` generator

**New Tests Required** (~300-400 lines, 12+ test cases):

```javascript
describe('Stage 2F Extended - BatchWatchTickersStrategy Real Behavior Tests', () => {
  // Group 1: Batch execution (3 tests)
  test('should emit all N tickers from N-symbol batch payload'),
  test('should continue re-subscribing after each batch resolve'),
  test('should handle batch error isolation independently'),
  
  // Group 2: Data loss prevention (2 tests)
  test('should emit all symbols in batch, not just first'),
  test('should yield complete tickers before re-subscribe'),
  
  // Group 3: Re-subscription correctness (3 tests)
  test('should use stable batch index, not string join'),
  test('should recover batch-specific state after error'),
  test('should not corrupt sibling batch state on batch failure'),
  
  // Group 4: Recursive safety (2 tests)
  test('should not infinite-recurse on empty payload'),
  test('should use loop-based retry not recursive call'),
  
  // Group 5: Multi-batch coordination (2 tests)
  test('should run all batches concurrently via Promise.race'),
  test('should isolate one batch error from other batches'),
})
```

**Test Implementation Approach**:
- Use real async generator execution (for-await loop)
- Create mock exchange with configurable batch responses
- Track yield counts to verify all symbols emitted
- Verify numeric batch index usage
- Use jest.fn() call tracking to prove loop-based retry

---

### Fix 7: Upgrade Integration Tests to Runtime Execution

**File**: `tests/integration/stage-2-subscription-engine-redesign-complete.test.js`  
**Lines**: ~1000-1197 (Stage 2D/2E/2F sections)  
**Problem**: Tests use "logic simulation" - plain variable assertions, no real component execution

**Current Problem Example**:
```javascript
// This is simulation - just checking mock existence, not real behavior
test('per-batch isolation', () => {
  const mockAdapterPool = { getBatchAdapter: jest.fn() };
  expect(mockAdapterPool.getBatchAdapter).toBeDefined();
});
```

**Fix Strategy - Replace with Real Runtime Execution**:
```javascript
// This is real - executes actual SubscriptionEngine code
test('per-batch isolation', async () => {
  const engine = new SubscriptionEngine(mockAdapter, mockRegistry, mockWriter);
  await engine.startSubscriptions();
  
  // Wait for actual batches to start
  await new Promise(r => setTimeout(r, 100));
  
  // Verify real health state was created
  const health = engine.adapterPool.getAllBatchHealth();
  expect(health.length).toBeGreaterThan(0);
  expect(health[0].state).toBeDefined();
  
  await engine.stopSubscriptions();
});
```

**Cases to Convert** (~15 tests):
- 2D (AdapterPool): Health tracking → real health state mutations, not mock existence checks
- 2E (Lifecycle): Lifecycle respect → real startSubscriptions/stopSubscriptions calls
- 2F (Comprehensive): Comprehensive proof → real component execution, not pseudo-logic

---

### Fix 8: Add Anti-Regression Tests for Core Stage 2 Requirements

**File**: `tests/integration/stage-2-subscription-engine-redesign-complete.test.js` (new tests)  
**Location**: Add new describe block after all other tests

**Required Anti-Regression Tests** (~250-350 lines, 8+ tests):

```javascript
describe('Stage 2 Anti-Regression Tests - Core Requirements', () => {
  // 1. Selector Precedence (override > default > capability)
  test('selector precedence: explicit override wins over default'),
  test('selector precedence: exchange default if no override'),
  test('selector precedence: capability fallback if default fails'),
  
  // 2. One Long-Lived Loop Behavior
  test('subscription loop is single per-batch, not sequential starvation'),
  test('batch completion does not block other batches (concurrent)'),
  
  // 3. No Promise.all Anti-Pattern
  test('per-symbol strategy uses Promise.race not Promise.all'),
  test('one symbol failure does not cascade to other symbols'),
  
  // 4. Staggered Startup Timing
  test('batches start with configured staggered delays'),
  test('first batch starts before last batch (timing proof)'),
})
```

**Test Implementation**:
- Layer 1: StrategySelector with strategy mode override/default/fallback
- Layer 2: SubscriptionEngine batch startup timing (jest.useFakeTimers)
- Layer 3: PerSymbolStrategy Promise.race execution (jest.fn call tracking)
- Layer 4: Staggered startup timer sequence verification
- Each test proves from failing on unfixed code to passing with fixes

---

## Implementation Plan - Per-Connection Isolation

### Phase 1: Refactor AdapterPool (2-3 hours)

**Goal**: Transform AdapterPool from health-tracking wrapper to true adapter pool

**Step 1.1: Update AdapterPool Constructor & Initialization**
- File: `src/core/adapter.pool.js` (lines 1-100)
- Change: Accept `adapterFactory` function (creates CCXTAdapters), not single adapter
- Implementation:
  ```javascript
  class AdapterPool {
    constructor(adapterFactory, config = {}) {
      this.adapterFactory = adapterFactory;  // Function that creates new adapters
      this.adapters = new Map();  // batchId → { adapter, health, state }
      this.config = config;
    }
    
    async initialize() {
      // Pool is ready - adapters created on-demand, not upfront
    }
    
    async getBatchAdapter(batchId) {
      if (!this.adapters.has(batchId)) {
        const adapter = await this.adapterFactory();  // NEW instance per batch
        this.adapters.set(batchId, {
          id: batchId,
          adapter: adapter,  // OWN connection
          state: 'idle',
          health: { ... }
        });
      }
      return this.adapters.get(batchId);
    }
  }
  ```

**Step 1.2: Update SubscriptionEngine to Use Per-Batch Adapters**
- File: `src/core/subscription.engine.js` (lines 32-322)
- Changes:
  - Constructor: Accept `adapterPool` (factory-based) instead of single `adapter`
  - Lines 130-180: In `startSubscriptions()`, get per-batch adapter for each loop
  - Lines 216-322: In `_subscriptionLoop()`, use your batch's adapter, not global
- Implementation:
  ```javascript
  // Line ~150
  const batchAdapter = await this.adapterPool.getBatchAdapter(batchId);
  
  // Line ~239
  for await (const { symbol, ticker } of batchAdapter.subscribe(activeSymbols)) {
    // Use batch-specific adapter
  }
  ```

**Step 1.3: Update ConnectionManager**
- File: `src/core/connection.manager.js` (lines 133-160)
- Changes:
  - Don't create single adapter; create adapter factory instead
  - Pass factory to AdapterPool
  - Pass AdapterPool to SubscriptionEngine
- Implementation:
  ```javascript
  // Line ~140: Create factory function
  const adapterFactory = async () => {
    return this.config.adapterFactory({
      exchange: this.config.exchange,
      marketType: this.config.marketType,
      strategyMode: this.config.strategyMode,
      logger: this.config.logger,
      proxyProvider: proxyProvider,
    });
  };
  
  // Line ~155: Pass factory to pool
  this.adapterPool = new AdapterPool(adapterFactory, config);
  
  // Line ~160: Pass pool (not adapter) to engine
  this.subscriptionEngine = new SubscriptionEngine(this.adapterPool, ...);
  ```

**Step 1.4: Testing & Validation**
- Run `npm test` - all 376+ tests must pass
- Verify per-batch adapters are created (not shared connection)
- Check no regressions in existing tests

---

### Phase 2: Update Tests for Per-Batch Adapter Visibility (1-2 hours)

**Goal**: Add tests that prove per-connection isolation works

**Step 2.1: Add Per-Batch Adapter Isolation Test**
- File: `tests/integration/stage-2-subscription-engine-redesign-complete.test.js`
- New test: "Per-batch adapter isolation: one batch connection failure doesn't affect others"
  ```javascript
  test('Per-batch adapter isolation: batch connection failure isolated', async () => {
    const adapterFactory = jest.fn(async () => ({
      subscribe: jest.fn(async function* (symbols) {
        // Some adapters fail, others succeed
        if (symbols[0] === 'ERROR-BATCH') {
          throw new Error('Connection failed');
        }
        yield { symbol: symbols[0], ticker: { last: 100 } };
      }),
    }));
    
    const adapterPool = new AdapterPool(adapterFactory);
    await adapterPool.initialize();
    
    // Batch 0 (success), Batch 1 (fail), Batch 2 (success)
    const adapter0 = await adapterPool.getBatchAdapter('batch-0');
    const adapter1 = await adapterPool.getBatchAdapter('batch-1');
    const adapter2 = await adapterPool.getBatchAdapter('batch-2');
    
    // Verify: 3 different adapter instances
    expect(adapterFactory.mock.calls.length).toBe(3);  // 3 calls = 3 instances
    expect(adapter0.adapter).not.toBe(adapter1.adapter);  // Different instances
    expect(adapter1.adapter).not.toBe(adapter2.adapter);
  });
  ```

**Step 2.2: Add SubscriptionEngine Per-Batch Usage Test**
- New test: "SubscriptionEngine uses per-batch adapters"
  ```javascript
  test('SubscriptionEngine distributes adapters per-batch', async () => {
    const adapterFactory = jest.fn(async () => ({ subscribe: jest.fn(async function* () {} ) }));
    const adapterPool = new AdapterPool(adapterFactory);
    
    const engine = new SubscriptionEngine(adapterPool, registry, writer, config);
    await engine.startSubscriptions([['BTC'], ['ETH'], ['SOL']]);  // 3 batches
    
    // After startup with 3 batches, should call factory 3 times
    await new Promise(r => setTimeout(r, 50));  // Let staggered startup progress
    expect(adapterFactory.mock.calls.length).toBe(3);
  });
  ```

**Step 2.3: Validate Existing Tests Still Pass**
- Run full test suite
- All 376+ tests passing
- Zero regressions

---

### Phase 3: Documentation Update (30 min - 1 hour)

**File**: `docs/code review and refinement/stage 2 - Subscription engine redesign/PHASES_OVERVIEW.md`

**Update Phase 2D Section**:
```markdown
## Phase 2D: Per-Batch Connection Isolation (✅ COMPLETE)

**Architecture**: 
- BEFORE: One CCXTAdapter with one CCXT exchange instance shared by all batches
- AFTER: AdapterPool creates N exchange instances (one per batch) via factory

**Implementation**:
- AdapterPool now uses factory pattern: `adapterFactory()` called per batch
- Each batch gets own adapter instance → own WebSocket connection
- ConnectionManager passes factory to AdapterPool, AdapterPool to SubscriptionEngine
- SubscriptionEngine._subscriptionLoop() uses batch-specific adapter

**Benefit**: TRUE per-connection isolation
- Batch-1 network failure ONLY affects Batch-1
- Batch-2 and Batch-3 continue on separate connections
- Real resilience, not just health metrics
```

---

## Critical Files Modified

**src/core/adapter.pool.js** (100-150 lines changed)
- Constructor: Add adapterFactory parameter
- getBatchAdapter(): Create new adapters per batch instead of wrapping single one
- Remove "all batches share one" pattern

**src/core/subscription.engine.js** (200-250 lines changed)
- Constructor: Accept adapterPool instead of adapter
- startSubscriptions(): Call adapterPool.getBatchAdapter(batchId) for each batch
- _subscriptionLoop(): Use batchAdapter instead of this.adapter

**src/core/connection.manager.js** (50-100 lines changed)
- Line ~140: Create adapterFactory function
- Line ~150-160: Initialize AdapterPool with factory
- Line ~170: Pass AdapterPool to SubscriptionEngine

**tests/integration/stage-2-subscription-engine-redesign-complete.test.js** (100-150 lines added)
- Add per-batch adapter isolation tests
- Add SubscriptionEngine per-batch adapter verification
- Existing 376+ tests must still pass

**docs/code review and refinement/stage 2 - Subscription engine redesign/PHASES_OVERVIEW.md**
- Update Phase 2D description to reflect per-connection architecture

---

## File Modifications Summary

**Code Fixes** (Phase A):
1. `src/adapters/strategies/batch-watch-tickers.strategy.js`:
   - Lines 40-87: Fix batchIndex flow (numeric instead of string)
   - Lines 93-113: Replace recursion with loop-based retry
   - Lines 100-103: Yield all tickers not just first

2. `src/adapters/ccxt.adapter.js`:
   - Line 265: Fix strategy type check (use mode string)
   - Top: Ensure minimal imports

3. `src/core/adapter.pool.js`:
   - Lines 1-19: Update documentation to clarify health isolation

4. `docs/code review and refinement/stage 2 - Subscription engine redesign/PHASES_OVERVIEW.md`:
   - Phase 2D section: Update to match architecture reality

**Test Additions** (Phase B+C):
- `tests/integration/stage-2-subscription-engine-redesign-complete.test.js`:
  - ~300 lines: Fix 6 real batch behavior tests
  - ~300 lines: Fix 7 upgraded integration tests
  - ~300 lines: Fix 8 anti-regression tests
  - Total additions: ~900 lines

---

## Success Criteria for Strict Stage 2 Approval

✅ **Per-Connection Isolation** (CRITICAL - Currently Blocked)
- AdapterPool creates new CCXTAdapter per batch, not wrapper-only
- Each adapter instance has own CCXT exchange/WebSocket
- Batch-1 connection failure doesn't affect Batch-2+ (proven by test)
- Test: Different adapter instances for different batches

✅ **SubscriptionEngine Uses Per-Batch Adapters** (CRITICAL)
- _subscriptionLoop() uses `batchAdapter.subscribe()` not global adapter
- Per-batch adapter obtained via `adapterPool.getBatchAdapter(batchId)`
- Test shows 3 batches = 3 adapter instances

✅ **All Existing Tests Still Pass** (REGRESSION CHECK)
- 376+ tests passing
- No regressions from refactor
- Performance unaffected

✅ **Documentation Updated**
- PHASES_OVERVIEW.md reflects per-connection architecture
- Comments explain factory pattern vs shared instance
- Stage 2 vs Stage 3 future direction clear

---

## Estimated Total Effort

**Phase 1 - Per-Batch Adapter Pool Refactor**: 2-3 hours
- Step 1.1 (AdapterPool): 1 hour
- Step 1.2 (SubscriptionEngine): 1 hour
- Step 1.3 (ConnectionManager): 30 min
- Step 1.4 (Testing): 30 min

**Phase 2 - Per-Batch Isolation Tests**: 1-1.5 hours
- Step 2.1 (AdapterPool test): 30 min
- Step 2.2 (SubscriptionEngine test): 30 min
- Step 2.3 (Regression validation): 30 min

**Phase 3 - Documentation**: 30 min - 1 hour

**Total: 4-5.5 hours**

---

## Verification & Sign-off Flow

1. **After Phase 1 (Refactor)**:
   - All 376+ tests passing
   - No ReferenceErrors or regressions
   - Verify different adapter instances created per batch

2. **After Phase 2 (Tests)**:
   - New per-batch isolation tests passing
   - SubscriptionEngine adapter distribution proven
   - 376+ + 5-10 new tests = 380+ total passing

3. **After Phase 3 (Docs)**:
   - PHASES_OVERVIEW.md updated
   - Architecture clearly documents factory pattern
   - Stage 2 ready for senior developer review

4. **Senior Developer Review**:
   - Code diffs for ConnectionManager, SubscriptionEngine, AdapterPool
   - Test excerpts proving per-batch adapters
   - Architecture docs showing true per-connection isolation
   - **READY FOR STRICT STAGE 2 APPROVAL**

---

## Implementation Sequence

Phase 1 → Refactor AdapterPool to use factory pattern (per-batch instances)  
                           ↓  
                    Run tests (376+ pass)  
                           ↓  
Phase 2 → Add per-batch isolation tests  
                           ↓  
                    Verify per-adapter instances  
                           ↓  
Phase 3 → Update documentation  
                           ↓  
              Ready for strict Stage 2 approval
