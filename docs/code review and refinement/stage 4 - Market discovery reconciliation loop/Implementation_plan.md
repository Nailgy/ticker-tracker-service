# Stage 4: Market Discovery Reconciliation Loop - Implementation Plan

**Date**: 2026-04-17  
**Status**: ❌ NOT APPROVED - 6 Critical Requirements to Implement  
**Senior Developer Verdict**: "Still restart-based, not true reconciliation"

---

## Problem Statement

Current implementation treats market discovery as a **full restart event**:
- `refreshMarkets()` calls `stopSubscriptions()` + `startSubscriptions()`
- Kills all active connections and rebuilds from scratch
- Batch topology completely rebuilt each refresh (unnecessary reindexing)
- No atomic guarantees: partial state left if updates fail
- No protection against overlapping refresh cycles
- CCXT markets may be cached (missing new listings)

**What Stage 4 Requires**: True reconciliation without restart
- Add new symbols to running batches (zero downtime)
- Remove stale symbols from running batches (zero downtime)
- Rebuild only affected batches (minimal churn)
- Atomically apply all changes (rollback on failure)
- Prevent overlapping refresh cycles (single-flight + coalescing)
- Always fetch fresh market list from exchange (reload: true)

---

## The 6 Requirements from Senior Review

### 4A: Forced Fresh Discovery with reload: true

**Current Problem** (`src/adapters/ccxt.adapter.js:163`):
```javascript
// BROKEN: May use cached markets
const markets = await this.exchange.loadMarkets();
```

**Why It Fails**:
- CCXT caches market list to avoid repeated API calls
- New listings missed until cache expires or service restarts
- Can't detect newly tradable symbols in real-time

**Requirement**:
```javascript
// FIXED: Always get fresh market list
const markets = await this.exchange.loadMarkets({ reload: true });
```

**Impact**: Ensures TickerWatcher detects new symbols on every refresh cycle.

---

### 4B: Incremental Reconcile API

**Current Problem** (`src/core/subscription.engine.js`):
- No way to add/remove symbols without stopping subscriptions
- Force users to do full restart via `stopSubscriptions()` + `startSubscriptions()`

**Requirement**: Add `reconcileBatches(nextPlan)` method to SubscriptionEngine
```javascript
/**
 * Reconciles batch allocations without full restart
 * @param {Array} nextPlan - New batch allocation plan [{ batchId, symbols }, ...]
 * @returns {Promise<{ added: [], removed: [], unchanged: [] }>}
 * 
 * - Adds new symbols to existing batches
 * - Removes stale symbols (keeps batch loop alive)
 * - Rebalances only if necessary
 * - Preserves per-batch state/timers/health
 */
async reconcileBatches(nextPlan) {
  // See implementation section below
}
```

**What It Does**:
1. Compute diff between current batches and nextPlan
2. For each batch:
   - If symbols added: call `batchAdapter.addSymbols(newSymbols)`
   - If symbols removed: call `batchAdapter.removeSymbols(removedSymbols)`
   - If empty: pause (keep batch alive, don't kill)
3. If topology changed: rebalance affected batches only (not all)
4. Keep all connections alive + health state intact
5. Return diff info for logging/monitoring

**Impact**: Enables zero-downtime market changes.

---

### 4C: Stable Batch Identity with Minimal Diff

**Current Problem** (`src/core/market.registry.js` - createBatches):
- Batches rebuilt from scratch each refresh
- Batch IDs may change (array index based)
- Identical symbols scattered to different batches unnecessarily
- Example: Batch 0 had [BTC/USDT, ETH/USDT], refresh creates Batch 0 with [BTC/USDT] + Batch 1 with [ETH/USDT]

**Requirement**: Preserve batch IDs + minimize symbol churn
```javascript
/**
 * Rebalance plan: only move symbols if necessary
 * 
 * Before (old plan):   { batch-0: [BTC, ETH], batch-1: [XRP, ADA] }
 * After (new markets): { batch-0: [BTC, ETH, LTC], batch-1: [XRP] }
 * 
 * Minimal diff:
 *   - batch-0: add [LTC]
 *   - batch-1: remove [ADA]
 * 
 * NOT:
 *   - batch-0: remove [BTC, ETH], add [BTC, ETH, LTC]
 *   - batch-1: remove [XRP, ADA], add [XRP]
 */
```

**Implementation Approach**:
1. Keep batch IDs stable (e.g., "batch-0", "batch-1", etc.)
2. For each existing batch: keep symbols that are still tradable
3. Fit new symbols into existing batches (up to batchSize limit)
4. Only create new batches if existing ones are full
5. Mark empty-but-active batches as "paused" (don't delete)

**Impact**: Reduces connection churn and improves state machine stability.

---

### 4D: Atomic Apply with Rollback

**Current Problem**:
- Registry state mutated before subscription rewire completes
- If subscription update fails, registry is in inconsistent state
- Failed batch left with wrong symbol set but engine thinks it's updated

**Requirement**: Transactional pattern
```javascript
async reconcileBatches(nextPlan) {
  // Step 1: COMPUTE PLAN (no mutations)
  const diff = computeDiff(currentBatches, nextPlan);
  
  // Step 2: APPLY TO ENGINE (can fail, needs rollback)
  const rollbackPlan = [];
  try {
    for (const change of diff.changes) {
      const checkpoint = await this.applyChange(change);
      rollbackPlan.push(checkpoint);
    }
  } catch (error) {
    // ROLLBACK: reverse all changes
    for (const checkpoint of rollbackPlan.reverse()) {
      await this.reverseChange(checkpoint);
    }
    throw error;
  }
  
  // Step 3: COMMIT (registry update - now safe)
  this.registry.updateBatches(nextPlan);
  
  return diff;
}
```

**Impact**: Guarantees consistency even if updates fail mid-cycle.

---

### 4E: Refresh Concurrency Guard

**Current Problem** (`src/core/ticker.watcher.js` - _refreshMarkets loop):
- Periodic refresh interval can fire while previous refresh still running
- Overlapping refresh cycles race: both try to reconcile, thrash batches
- Example: Refresh-A adds LTC to batch-0 while Refresh-B removes LTC from batch-0

**Requirement**: Single-flight mutex + request coalescing
```javascript
class TickerWatcher {
  #refreshMutex = new Mutex();
  #pendingRefresh = false;
  
  async _refreshMarkets() {
    // Acquire lock or skip if already running
    if (!await this.#refreshMutex.tryLock()) {
      // Already running: mark "pending" so it runs again after current finishes
      this.#pendingRefresh = true;
      return;
    }
    
    try {
      const shouldRunAgain = true;
      while (shouldRunAgain) {
        this.#pendingRefresh = false;
        
        // Do refresh...
        const newMarkets = await this.loadMarkets();
        const nextPlan = this.createAllocationPlan(newMarkets);
        await this.connectionManager.reconcileMarkets(nextPlan);
        
        // If refresh was requested while we were running, run again
        shouldRunAgain = this.#pendingRefresh;
      }
    } finally {
      this.#refreshMutex.release();
    }
  }
}
```

**Implementation**: Use a simple mutex (semaphore) or async queue library
- Prevents concurrent reconcile calls
- Coalesces requests: if multiple refreshes queued, run once after current completes

**Impact**: Prevents batch thrashing and state inconsistency from overlapping cycles.

---

### 4F: Stage 4 Proof Tests

**Current Problem** (e.g., `tests/unit/connection.manager.test.js:578`):
- Tests still expect restart behavior (asserting `stopSubscriptions()` called)
- Tests opposite of Stage 4 goal (no restart on refresh)

**Requirement**: Assert reconciliation without restart

**Test Cases to Add/Fix**:

1. **Assert no restart on normal diff** ✅
   ```javascript
   test('refreshMarkets adds new symbols without restarting batches', async () => {
     // Setup: batch-0 has [BTC/USDT, ETH/USDT]
     const before = engine.getBatchState('batch-0');
     
     // New market refresh: adds LTC/USDT
     await engine.reconcileBatches([
       { batchId: 'batch-0', symbols: ['BTC/USDT', 'ETH/USDT', 'LTC/USDT'] }
     ]);
     
     // Assert: same loop/connection, just symbols added
     const after = engine.getBatchState('batch-0');
     expect(after.connectionId).toBe(before.connectionId);  // SAME batch
     expect(after.symbols).toContain('LTC/USDT');          // NEW symbol added
     expect(after.subscriptionActive).toBe(true);          // Still subscribed
   });
   ```

2. **Assert existing batch loops stay alive** ✅
   ```javascript
   test('reconcileBatches keeps batch loops alive when symbols removed', async () => {
     const before = engine.getActiveBatchLoops();
     
     await engine.reconcileBatches([
       { batchId: 'batch-0', symbols: ['BTC/USDT'] }  // Removed ETH/USDT
     ]);
     
     const after = engine.getActiveBatchLoops();
     expect(after.length).toBe(before.length);  // SAME number of loops
     expect(after).toContainEqual(before[0]);    // batch-0 still active
   });
   ```

3. **Assert added symbols start streaming** ✅
   ```javascript
   test('new symbols in reconcile start streaming to Redis immediately', async () => {
     const publishSpy = jest.spyOn(redis, 'publish');
     
     await engine.reconcileBatches([
       { batchId: 'batch-0', symbols: ['BTC/USDT', 'ETH/USDT', 'LTC/USDT'] }
     ]);
     
     // Simulate exchange sending tickers
     exchange.emit('ticker', { symbol: 'LTC/USDT', last: 50000 });
     
     // Assert LTC tickers published
     await waitFor(() => {
       expect(publishSpy).toHaveBeenCalledWith(
         expect.stringContaining('LTC/USDT'),
         expect.any(String)
       );
     });
   });
   ```

4. **Assert removed symbols stop streaming** ✅
   ```javascript
   test('removed symbols stop streaming to Redis', async () => {
     const publishSpy = jest.spyOn(redis, 'publish');
     
     await engine.reconcileBatches([
       { batchId: 'batch-0', symbols: ['BTC/USDT'] }  // Removed ETH
     ]);
     
     // Simulate exchange sending tickers
     exchange.emit('ticker', { symbol: 'ETH/USDT', last: 3000 });
     
     // Assert ETH tickers NOT published
     await waitFor(() => {
       expect(publishSpy).not.toHaveBeenCalledWith(
         expect.stringContaining('ETH/USDT'),
         expect.any(String)
       );
     });
   });
   ```

5. **Assert refresh overlap is safe** ✅
   ```javascript
   test('overlapping refreshMarkets calls are serialized (no thrashing)', async () => {
     const reconcileSpy = jest.spyOn(engine, 'reconcileBatches');
     
     // Trigger two overlapping refreshes
     const refresh1 = engine._refreshMarkets();
     const refresh2 = engine._refreshMarkets();
     
     await Promise.all([refresh1, refresh2]);
     
     // Assert reconcileBatches called exactly once (coalesced), not twice
     expect(reconcileSpy).toHaveBeenCalledTimes(1);
   });
   ```

6. **Assert reload: true is used** ✅
   ```javascript
   test('loadMarkets always uses reload: true in refresh path', async () => {
     const loadMarketsSpy = jest.spyOn(exchange, 'loadMarkets');
     
     await watcherRefreshMarkets();
     
     expect(loadMarketsSpy).toHaveBeenCalledWith(
       expect.objectContaining({ reload: true })
     );
   });
   ```

---

## Implementation Phases

### Phase 1: Forced Fresh Discovery (4A)
**Files**: `src/adapters/ccxt.adapter.js`  
**Effort**: 5 minutes

```javascript
// Line 163 in loadMarkets()
// Before:
const markets = await this.exchange.loadMarkets();

// After:
const markets = await this.exchange.loadMarkets({ reload: true });
```

**Verification**: 
- Add test asserting `reload: true` passed

---

### Phase 2: Stable Batch Identity + Minimal Diff (4C)
**Files**: `src/core/market.registry.js`  
**Effort**: 45-60 minutes

**Current Code** (createBatches):
```javascript
createBatches(symbols, batchSize) {
  const batches = {};
  let batchIndex = 0;
  
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batchId = `batch-${batchIndex++}`;
    batches[batchId] = symbols.slice(i, i + batchSize);
  }
  
  return batches;  // ← Problem: rebuilt from scratch each time
}
```

**Required Approach**:
```javascript
/**
 * Rebalance: add new symbols, remove stale ones, keep batch IDs stable
 * Only create new batches if existing ones full
 */
rebalance(currentBatches, newSymbols, batchSize) {
  const nextBatches = { ...currentBatches };
  
  // Step 1: Remove stale symbols from existing batches
  const tradableSymbols = new Set(newSymbols);
  for (const [batchId, symbols] of Object.entries(nextBatches)) {
    nextBatches[batchId] = symbols.filter(s => tradableSymbols.has(s));
  }
  
  // Step 2: Find symbols not yet allocated
  const allocatedSymbols = new Set();
  for (const symbols of Object.values(nextBatches)) {
    symbols.forEach(s => allocatedSymbols.add(s));
  }
  const unallocatedSymbols = newSymbols.filter(s => !allocatedSymbols.has(s));
  
  // Step 3: Fit new symbols into existing batches (if space available)
  for (const batchId of Object.keys(nextBatches)) {
    while (nextBatches[batchId].length < batchSize && unallocatedSymbols.length > 0) {
      nextBatches[batchId].push(unallocatedSymbols.shift());
    }
  }
  
  // Step 4: Create new batches only if needed
  let newBatchIndex = Object.keys(nextBatches).length;
  while (unallocatedSymbols.length > 0) {
    const batchId = `batch-${newBatchIndex++}`;
    nextBatches[batchId] = unallocatedSymbols.splice(0, batchSize);
  }
  
  return nextBatches;
}
```

**Verification**:
- Test: same batch IDs preserved when possible
- Test: symbols only moved if necessary
- Test: new batches only created when existing full

---

### Phase 3: Incremental Reconcile API (4B)
**Files**: `src/core/subscription.engine.js`, `src/core/adapter.pool.js`  
**Effort**: 90-120 minutes

**New Method in SubscriptionEngine**:
```javascript
async reconcileBatches(nextPlan) {
  this.logger('info', 'SubscriptionEngine.reconcileBatches starting', {
    currentBatches: Object.keys(this.activeBatches),
    nextBatches: nextPlan.map(p => p.batchId)
  });
  
  const diff = {
    added: [],
    removed: [],
    modified: [],
    unchanged: []
  };
  
  const nextPlanMap = new Map(nextPlan.map(p => [p.batchId, p.symbols]));
  
  // For each current batch
  for (const [batchId, batchState] of Object.entries(this.activeBatches)) {
    if (!nextPlanMap.has(batchId)) {
      // Batch being removed
      diff.removed.push(batchId);
      // Pause (don't kill - may come back later)
      await this.adapterPool.pauseBatch(batchId);
    } else {
      const nextSymbols = nextPlanMap.get(batchId);
      const currentSymbols = batchState.symbols;
      
      const added = nextSymbols.filter(s => !currentSymbols.includes(s));
      const removed = currentSymbols.filter(s => !nextSymbols.includes(s));
      
      if (added.length > 0 || removed.length > 0) {
        diff.modified.push({
          batchId,
          added,
          removed
        });
        
        // Apply changes
        if (added.length > 0) {
          await this.adapterPool.addSymbolsToBatch(batchId, added);
        }
        if (removed.length > 0) {
          await this.adapterPool.removeSymbolsFromBatch(batchId, removed);
        }
      } else {
        diff.unchanged.push(batchId);
      }
    }
  }
  
  // For new batches
  for (const [batchId, symbols] of nextPlanMap) {
    if (!this.activeBatches[batchId]) {
      diff.added.push(batchId);
      // Start new batch subscription loop
      await this.adapterPool.startBatch(batchId, symbols);
    }
  }
  
  this.logger('info', 'SubscriptionEngine.reconcileBatches complete', diff);
  return diff;
}
```

**Required Methods in AdapterPool**:
```javascript
async addSymbolsToBatch(batchId, symbols) { }     // Add symbols to running batch
async removeSymbolsFromBatch(batchId, symbols) { } // Remove symbols from running batch
async pauseBatch(batchId) { }                       // Pause batch (no new data, keep state)
async startBatch(batchId, symbols) { }             // Start new batch loop
```

**Verification**:
- Test: add symbols while batch running
- Test: remove symbols while batch running
- Test: connection stays alive

---

### Phase 4: Atomic Apply with Rollback (4D)
**Files**: `src/core/subscription.engine.js`  
**Effort**: 60 minutes

**Wrap reconcileBatches in try/catch with checkpoint system**:
```javascript
async reconcileBatches(nextPlan) {
  const snapshot = this.captureSnapshot();  // Save current state
  const checkpoints = [];
  
  try {
    // Same reconcile logic as Phase 3, but capture checkpoints
    for (const change of computedChanges) {
      const checkpoint = { change, before: this.capturePartialSnapshot(change) };
      await this.applyChange(change);
      checkpoints.push(checkpoint);
    }
  } catch (error) {
    this.logger('error', 'Reconcile failed, rolling back', { error });
    // Reverse in order
    for (const checkpoint of checkpoints.reverse()) {
      await this.revertChange(checkpoint);
    }
    throw error;
  }
  
  return diff;
}
```

**Verification**:
- Test: simulate failure mid-reconcile, verify rollback successful

---

### Phase 5: Refresh Concurrency Guard (4E)
**Files**: `src/core/ticker.watcher.js`  
**Effort**: 30-45 minutes

**Add Mutex Pattern**:
```javascript
class TickerWatcher {
  constructor(config) {
    // ... existing code
    this.#refreshInProgress = false;
    this.#refreshPending = false;
  }
  
  async _refreshMarkets() {
    // Acquire lock
    if (this.#refreshInProgress) {
      this.#refreshPending = true;
      return;
    }
    
    this.#refreshInProgress = true;
    try {
      let runAgain = true;
      while (runAgain) {
        this.#refreshPending = false;
        
        const newMarkets = await this.loadMarkets();
        const nextPlan = this.createAllocationPlan(newMarkets);
        await this.connectionManager.reconcileMarkets(nextPlan);
        
        runAgain = this.#refreshPending;
      }
    } catch (error) {
      this.logger('error', 'Market refresh failed', { error });
    } finally {
      this.#refreshInProgress = false;
    }
  }
}
```

**Verification**:
- Test: trigger overlapping refreshes, verify only runs once + one more
- Test: verify no thrashing

---

### Phase 6: Stage 4 Proof Tests (4F)
**Files**: `tests/unit/connection.manager.test.js`, `tests/integration/stage-4-reconciliation.test.js`  
**Effort**: 90-120 minutes

**Create new test file** `tests/integration/stage-4-reconciliation.test.js`:
- Test 1: No restart on normal diff ✅
- Test 2: Batch loops stay alive ✅
- Test 3: New symbols stream immediately ✅
- Test 4: Removed symbols stop streaming ✅
- Test 5: Overlap is serialized ✅
- Test 6: reload: true is used ✅

**Update existing test** `tests/unit/connection.manager.test.js:578`:
- Remove assertion expecting `stopSubscriptions()` on refresh
- Change to asserting `reconcileBatches()` called instead

---

## Integration Points

### TickerWatcher → ConnectionManager
```javascript
// In TickerWatcher._refreshMarkets()
const newMarkets = await this.loadMarkets();  // reload: true (Phase 1)
const nextPlan = this.createAllocationPlan(newMarkets);
await this.connectionManager.reconcileMarkets(nextPlan);  // Phase 5 guard applies here
```

### ConnectionManager → SubscriptionEngine
```javascript
// In ConnectionManager.reconcileMarkets()
async reconcileMarkets(nextPlan) {
  for (const exchange of this.connections.keys()) {
    const engine = this.connections.get(exchange);
    await engine.reconcileBatches(nextPlan[exchange]);  // Phase 3 & 4
  }
}
```

### SubscriptionEngine → AdapterPool
```javascript
// In SubscriptionEngine.reconcileBatches()
await this.adapterPool.addSymbolsToBatch(batchId, added);     // Phase 3
await this.adapterPool.removeSymbolsFromBatch(batchId, removed);
await this.adapterPool.pauseBatch(batchId);
```

---

## Success Criteria

- ✅ `loadMarkets({ reload: true })` always called in refresh path
- ✅ `reconcileBatches()` can add symbols without restart
- ✅ `reconcileBatches()` can remove symbols without restart
- ✅ Batch IDs stable across refreshes (minimal diff)
- ✅ All changes atomic + rollback on failure
- ✅ Overlapping refreshes serialized (no concurrent reconcile)
- ✅ All 6 proof tests passing
- ✅ No `stopSubscriptions()` called on normal market diffs
- ✅ Existing batch loops stay alive
- ✅ Zero downtime during market changes

---

## Files to Modify

| Phase | File | Changes | Complexity |
|-------|------|---------|------------|
| 1 | src/adapters/ccxt.adapter.js | Add reload: true | 🟢 Low |
| 2 | src/core/market.registry.js | Rebalance with stable IDs | 🟡 Medium |
| 3 | src/core/subscription.engine.js | reconcileBatches() + integration | 🔴 High |
| 3 | src/core/adapter.pool.js | addSymbolsToBatch, etc | 🔴 High |
| 4 | src/core/subscription.engine.js | Checkpoint/rollback wrapper | 🟡 Medium |
| 5 | src/core/ticker.watcher.js | Refresh mutex + coalesce | 🟡 Medium |
| 6 | tests/integration/ | 6 new proof tests | 🟡 Medium |

---

## Execution Order (Recommended)

1. **Phase 1** (5m): Force reload: true - quick win, no dependencies
2. **Phase 2** (60m): Stable batch IDs - foundation for reconcile
3. **Phase 5** (45m): Refresh guard - enables safe testing
4. **Phase 3** (120m): Reconcile API - core feature
5. **Phase 4** (60m): Atomic apply - safety wrapper
6. **Phase 6** (120m): Tests - proof of correctness

**Total Effort**: ~410 minutes (6-7 hours)  
**Risk Level**: Medium (core runtime changes, well-defined requirements)  
**Testing**: Integration tests required before approval

---

## Approval Gate

Senior developer will approve Stage 4 once:
- ✅ All 6 proof tests pass
- ✅ No `stopSubscriptions()` on normal diffs (verified via test)
- ✅ Zero downtime demonstrated with concurrent symbol add/remove
- ✅ Atomic apply verified with failure scenario tests
- ✅ Refresh coalescing verified with overlap tests
- ✅ `reload: true` verified in market load

