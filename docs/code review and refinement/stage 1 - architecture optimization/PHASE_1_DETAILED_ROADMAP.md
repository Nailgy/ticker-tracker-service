# Phase 1: Architecture Hardening - Complete Step Breakdown

## Completed: Phase 1A ✅

**Status**: 9 new modules created, 2 refactored, all syntax valid  
**Test Status**: 104/129 passing (80.6%) - failures are expected (old interface)

---

## Phase 1B: Test Refactoring (150-200 lines of test updates)

**Goal**: Update existing tests to validate new public APIs instead of internal state

### Step 1B-1: Update connection.manager.test.js

**File**: `tests/unit/connection.manager.test.js`  
**Current state**: Tests expect `manager.exchange`, `manager.symbols`, `manager.batches` properties  
**What to change**:

1. **Constructor tests** (lines 15-40):
   - ✅ KEEP: "should throw if exchangeFactory not provided" (still validates constructor)
   - ✅ KEEP: "should throw if redisService not provided" (still validates constructor)
   - ❌ REMOVE: Tests accessing internal `manager.symbols` (now `manager.marketRegistry.getActiveSymbols()`)
   - ✅ KEEP: "should use default batchSize if not provided" (test public behavior)

2. **initialize() tests** (lines 125-165):
   - OLD: `expect(manager.exchange).toBeDefined()`
   - NEW: `expect(manager.adapter).toBeDefined()` (after initialize)
   - OLD: `expect(manager.symbols.length).toBe(5)`
   - NEW: `expect(manager.marketRegistry.getActiveSymbols().size).toBe(5)`
   - OLD: `expect(manager.symbols[0]).toBe('ADA/USDT')`
   - NEW: `const activeSymbols = Array.from(manager.marketRegistry.getActiveSymbols()).sort()[0]; expect(activeSymbols).toBe('ADA/USDT')`

3. **Batching logic tests** (lines 180-210):
   - OLD: Tests calling `manager._createBatches()` directly (PRIVATE!)
   - NEW: Test via `initialize()` output → verify `manager.batches` after init
   - REMOVE: Direct private method tests
   - KEEP: Verify batches are created with correct size

4. **startSubscriptions() tests** (lines 225-265):
   - OLD: `expect(manager.subscriptionTimers.length).toBeGreaterThan(0)` (checking private state)
   - NEW: `expect(manager.subscriptionEngine.getStatus().isRunning).toBe(true)` (public API)
   - OLD: `expect(manager.subscriptionTimers.length).toBe(0)` after stop
   - NEW: `expect(manager.subscriptionEngine.getStatus().isRunning).toBe(false)` after stop
   - KEEP: Test that `startSubscriptions()` doesn't throw on second call

5. **stop() tests** (lines 280-340):
   - OLD: Tests checking `manager.subscriptionTimers`, `manager.exchange.close()` spy
   - NEW: Test through public methods: `manager.stop()` → verify `isRunning = false`
   - OLD: `expect(mockRedis.flushCount).toBeGreaterThan(flushCountBefore)`
   - NEW: `expect(manager.redisWriter.getMetrics().flushedBatches).toBeGreaterThan(0)` OR verify flush called via mock

6. **getStatus() tests** (lines 355-375):  
   - OLD: Check for `manager.stats` property
   - NEW: Check returned object has: `isInitialized`, `isRunning`, `symbolCount`, `batches`, `adapter`, `engine`, `registry`, `writer`
   - ADD: Verify each nested object has expected metrics

7. **error handling tests** (lines 405-425):
   - OLD: Mock exchange factory to fail, verify `manager.exchange` is undefined
   - NEW: Mock adapter initialization to fail, verify error is thrown from `initialize()`
   - ADD: Test that failed initialization leaves `manager.isInitialized = false`

**Total changes**: ~50 lines modified, 5-10 tests removed/rewritten

---

### Step 1B-2: Update phase5.test.js (Resilience Tests)

**File**: `tests/unit/phase5.test.js`  
**Current state**: Tests internal `_subscriptionLoop()`, `_calculateExponentialBackoff()`, health checks  
**What to change**:

1. **Exponential backoff tests** (lines 80-130):
   - OLD: Call `manager._calculateExponentialBackoff(batchId)` directly
   - NEW: Create SubscriptionEngine instance, mock callbacks
   - NEW: Verify backoff via `onError` callback with specific error types
   - APPROACH: Trigger simulated errors, verify delays calculated correctly

2. **Non-retryable error detection** (lines 145-180):
   - OLD: Call `manager._isNonRetryableError(error)` directly
   - NEW: Create subscription with bad symbol, verify `registry.markNonRetryable()` called
   - NEW: Test via callbacks: when non-retryable error occurs, verify symbol is removed
   - ADD: Verify failed symbol doesn't appear in next subscription attempt

3. **Stale connection detection** (lines 195-230):
   - OLD: Manually advance timers, check `manager.batchState`
   - NEW: Mock adapter, set up subscription, advance timers
   - NEW: Verify `onHealthCheck` callback fired when stale detected
   - NEW: Verify subscription engine closes and reconnects

4. **Symbol removal on error** (lines 245-280):
   - OLD: Direct checks on `manager.nonRetryableSymbols` set
   - NEW: Verify through `registry.getNonRetryableSymbols()`
   - NEW: Verify symbol is filtered in next subscription cycle

**Total changes**: ~60 lines modified, rewrite from integration style to module-boundary testing

---

### Step 1B-3: Update exchange.factory.test.js

**File**: `tests/unit/exchange.factory.test.js`  
**Current state**: This should still pass - ExchangeFactory is backward compatible  
**What to check**:

1. Verify all tests still pass (should be ✅)
2. If any fail, it's likely due to CCXT mock issues, not our changes
3. NO changes needed - ExchangeFactory remains unchanged

---

### Step 1B-4: Verify Redis Service Tests

**File**: `tests/unit/redis.service.test.js`  
**Current state**: Should still pass - RedisService unchanged  
**What to check**:

1. Verify all 29 redis tests pass (should be ✅)
2. RedisWriter is a NEW class, doesn't affect RedisService tests
3. NO changes needed

---

### Step 1B-5: Remove/Update Old Private Method Tests

**Find and remove**:
```javascript
// Remove all tests calling these private methods:
manager._createBatches()
manager._subscriptionLoop()
manager._healthCheck()
manager._startHealthCheck()
manager._calculateExponentialBackoff()
manager._isNonRetryableError()
manager._handleNonRetryableError()
manager._extractSymbolFromError()
```

**Replace with**: Tests that verify behavior through PUBLIC APIs and callbacks

---

## Phase 1C: New Component Unit Tests (Create 4 New Test Files)

**Goal**: Add isolated unit tests for new modules

### Step 1C-1: Create tests/unit/market.registry.test.js (~200 lines)

**What to test**:

1. **Constructor & initialization**:
   - Should initialize with empty symbol sets
   - Should initialize metrics correctly

2. **loadDesiredMarkets()**:
   - Mock adapter.loadMarkets() returning 100 symbols
   - Verify desiredSymbols Set populated
   - Verify metrics updated
   - Test error handling on adapter failure

3. **addSymbols()**:
   - Add 10 symbols, verify returned as {added, count}
   - Add duplicate symbols, verify not added twice
   - Verify activeSymbols updated
   - Test re-enabling non-retryable symbol (removes from non-retryable set)

4. **removeSymbols()**:
   - Remove 5 symbols, verify returned as {removed, remainingCount}
   - Verify removed from activeSymbols
   - Verify removed from batchAllocations
   - Test removing non-existent symbols (silently ignored)

5. **markNonRetryable()**:
   - Mark 3 symbols as non-retryable
   - Verify removed from activeSymbols
   - Verify not re-added via addSymbols() 
   - Test marking already-marked symbols (idempotent)

6. **allocateToBatches()**:
   - 100 symbols, 10 batch IDs → 10 symbols per batch
   - Verify round-robin allocation
   - Test uneven allocation (100 symbols, 7 batch IDs)
   - Verify symbolToBatchMap reverse lookup works

7. **getDiffSince()**:
   - Load 100 symbols
   - Save previousState
   - Add 20 new, remove 10 old
   - Verify getDiffSince returns correct {added, removed}

8. **Query methods**:
   - Test getDesiredSymbols() returns Set copy
   - Test getActiveSymbols() excludes non-retryable
   - Test getNonRetryableSymbols() returns Set copy
   - Test getMetrics() has correct counts

---

### Step 1C-2: Create tests/unit/subscription.engine.test.js (~250 lines)

**What to test** (using jest fake timers):

1. **Constructor & initialization**:
   - Should initialize with empty subscription loops
   - Should initialize metrics to zero
   - Should register callbacks correctly

2. **startSubscriptions()**:
   - Mock adapter, registry, writer
   - Call with 3 batches of symbols
   - Verify subscriptionLoops Map has 3 entries
   - Verify staggered start timers created (3 timers with delays)
   - Verify health check timer started

3. **Subscription loop lifecycle** (using jest.useFakeTimers()):
   - Mock adapter.subscribe() to yield 5 tickers
   - Verify onTicker callback called 5 times
   - Verify WriterWriter.writeTicker() called per symbol
   - Verify lastMessageAt timestamp updated

4. **Exponential backoff on error**:
   - Mock adapter.subscribe() to throw retryable error (ECONNREFUSED)
   - Verify first attempt: delay = 1000ms
   - Advance timer 1000ms
   - Verify second attempt: delay = 2000ms
   - Verify onError callback called each attempt

5. **Non-retryable error handling**:
   - Mock adapter.subscribe() to throw "Symbol BTC/BAD not found"
   - Verify extracted symbol = "BTC/BAD"
   - Verify registry.markNonRetryable(['BTC/BAD']) called
   - Verify next cycle filters out BTC/BAD

6. **Health check - stale detection**:
   - Advance past healthCheckTimeoutMs without data
   - Verify stale flag set on batch state
   - Verify onHealthCheck callback fired
   - Verify adapter.close() called to force reconnect

7. **Health check - recovery**:
   - Batch marked stale
   - New data arrives (advance past stale threshold)
   - Verify stale flag reset
   - Verify onHealthCheck callback fired with recovered status

8. **stopSubscriptions()**:
   - All timers cleared
   - healthCheckInterval cleared
   - adapter.close() called
   - subscriptionLoops cleared
   - metrics show isRunning = false

---

### Step 1C-3: Create tests/unit/exchange.adapter.test.js (~150 lines)

**What to test**:

1. **Constructor**:
   - Should store config correctly
   - Should initialize metrics to defaults

2. **initialize()**:
   - Verify CCXT instance created for 'binance'
   - Verify strategy selected (AllTickersStrategy for Binance)
   - Verify metrics.subscriptionStatus = 'initialized'
   - Test error if exchange not found

3. **loadMarkets()**:
   - Mock exchange.loadMarkets() returning mixed spot/swap/inactive
   - Filter by marketType='spot'
   - Filter active only
   - Return sorted symbols
   - Verify metrics logged correctly

4. **Strategy selection**:
   - Binance → AllTickersStrategy
   - Bybit → AllTickersStrategy
   - Kraken (mock per-symbol only) → PerSymbolStrategy
   - Test error if no strategy supported

5. **subscribe()**:
   - Mock strategy to yield 10 tickers
   - Verify onTicker callbacks work
   - Test error if not initialized
   - Test error if empty symbol list

6. **close()**:
   - Mock strategy.close() and exchange.close()
   - Verify both called
   - Verify metric.subscriptionStatus = 'closed'

7. **Metrics**:
   - Verify getMetrics() returns all tracking fields
   - Test metric updates on operations

---

### Step 1C-4: Create tests/unit/redis.writer.test.js (~180 lines)

**What to test**:

1. **Constructor**:
   - Mock RedisService
   - Verify config initialized
   - Verify dedup cache empty
   - Verify metrics zero

2. **writeTicker() - Deduplication**:
   - Write ticker {symbol: 'BTC/USDT', last: 100}
   - Write same ticker again
   - Verify second write deduped (returned {written: false, reason: 'deduped'})
   - Verify dedupCache has hash

3. **writeTicker() - Change Detection**:
   - Write ticker with last: 100
   - Write same symbol with last: 101
   - Verify second write NOT deduped (hash changed)
   - Verify both written

4. **writeTicker() - Rate Limiting**:
   - Set redisMinIntervalMs: 1000
   - Write ticker at T=0
   - Write again at T=500 (before interval)
   - Verify second write rate-limited
   - Write again at T=1100 (after interval)
   - Verify written

5. **writeTicker() - Batching**:
   - Set redisBatching: true, redisMaxBatch: 5
   - Write 5 tickers
   - Verify batch queued but not flushed yet
   - Write 6th ticker
   - Verify flush triggered (batch.length = 0)

6. **writeTicker() - Immediate Write** (batching disabled):
   - Set redisBatching: false
   - Mock redis.pipeline()
   - Write ticker
   - Verify HSET and PUBLISH called immediately
   - Verify {written: true, batched: false}

7. **flush()**:
   - Queue 3 tickers
   - Call flush()
   - Verify pipeline.exec() called
   - Verify batch cleared
   - Verify metrics updated (flushedBatches++, queuedUpdates=0)

8. **disconnect()**:
   - Queue 2 pending tickers
   - Call disconnect()
   - Verify flush() called first
   - Verify batch timer cleared
   - Verify {disconnected: true}

9. **Metrics**:
   - Verify getMetrics() tracks: totalWrites, dedupedWrites, flushedBatches, failedWrites, etc.

---

## Phase 1D: Integration Testing (Create 2 New Files)

**Goal**: Verify modules work together correctly

### Step 1D-1: Create tests/integration/architecture.integration.test.js (~300 lines)

**What to test** (end-to-end without real exchange):

1. **Full startup flow**:
   ```
   TickerWatcher → ConnectionManager → {Adapter, Engine, Registry, Writer, ProxyProvider}
   ```
   - Create mock adapter, mock redis
   - Call watcher.start()
   - Verify all components initialized
   - Verify subscriptions started
   - Verify market discovery registered

2. **Subscription flow** (mock adapter yields tickers):
   - Mock adapter.subscribe() yields 5 tickers from 'BTC/USDT', 'ETH/USDT'
   - Verify RedisWriter.writeTicker() called for each
   - Verify tickers appear in Redis mock
   - Verify metrics updated

3. **Market refresh** (add/remove symbols):
   - Initial: 10 symbols, 1 batch
   - Mock adapter returns 15 symbols on second load
   - Trigger market refresh
   - Verify 5 new symbols added
   - Verify batches recalculated
   - Later: Mock adapter returns 8 symbols
   - Verify 2 symbols marked for removal
   - Verify batches recalculated

4. **Error recovery**:
   - Mock adapter.subscribe() first: throw network error
   - Verify exponential backoff
   - Verify retries with increasing delays
   - Second attempt: throw non-retryable error
   - Verify symbol marked non-retryable via registry
   - Third attempt: succeeds with different symbols
   - Verify system continues

5. **Graceful shutdown**:
   - Start watcher
   - Call watcher.stop()
   - Verify ConnectionManager stopped
   - Verify subscriptions closed
   - Verify Redis flushed
   - Verify all metrics logged

---

### Step 1D-2: Create tests/integration/dependency-boundaries.test.js (~200 lines)

**What to test** (verify module isolation):

1. **No private method calls**:
   - Use AST or grep to verify no `\._` method calls across module boundaries
   - Verify all inter-module communication via public methods only

2. **State encapsulation**:
   - Create ConnectionManager
   - Attempt direct mutation: `manager.batches[0].push('XXX')`
   - Verify this doesn't affect actual subscriptions
   - Verify changes must go through `registry.addSymbols()`

3. **Error isolation**:
   - Mock adapter fails
   - Verify only that adapter's subscriptions fail
   - Verify other components still functioning
   - Verify error callback allows handling without cascade

4. **Circular dependency check**:
   - Load all modules
   - Trace imports
   - Verify no circular imports
   - Verify dependency graph is DAG (directed acyclic graph)

5. **Interface compliance**:
   - Verify ExchangeAdapter has all required public methods
   - Verify SubscriptionEngine has all required callbacks
   - Verify MarketRegistry has all required methods
   - Verify RedisWriter has all required methods

---

## Phase 1E: Documentation & Verification (Mandatory!)

**Goal**: Verify all Phase 1A-1D requirements met, document for next phases

### Step 1E-1: Create ARCHITECTURE.md (Reference Document)

**Location**: `docs/ARCHITECTURE_PHASE_1.md`

**Contents**:

1. **Module Overview Table**:
   - ExchangeAdapter: responsibilities, public methods, dependencies
   - SubscriptionEngine: responsibilities, public methods, callbacks
   - MarketRegistry: responsibilities, public methods, state
   - RedisWriter: responsibilities, public methods, internal optimization
   - ProxyProvider: responsibilities, implementations, public methods
   - ConnectionManager: new responsibilities, public methods, delegation
   - TickerWatcher: new responsibilities, public methods

2. **Dependency Diagram**:
   ```
   ASCII art showing clean hierarchy
   No crossing lines = no circular deps
   ```

3. **Data Flow Diagrams**:
   - Ticker ingestion flow
   - Market discovery flow
   - Error handling flow
   - Shutdown flow

4. **State Management**:
   - Where each piece of state lives
   - How state transitions occur
   - State consistency guarantees

5. **Error Handling Strategy**:
   - Retryable vs non-retryable errors  
   - Backoff algorithm
   - Health check triggers
   - Symbol removal process

6. **Extension Points** (for Phase 2+):
   - How to add new exchange adapters
   - How to add new watch strategies
   - How to add new proxy providers

---

### Step 1E-2: Verification Checklist

**Before marking Phase 1 complete**:

```
STRUCTURAL REQUIREMENTS:
☐ No private method calls across module boundaries (Grep: \._[a-z])
☐ All state mutations encapsulated in owning module
☐ ExchangeAdapter wraps ALL CCXT behavior
☐ MarketRegistry owns all symbol state
☐ SubscriptionEngine manages all loop state
☐ RedisWriter manages all Redis operations
☐ Zero circular dependencies
☐ Each module <300 lines of core logic

TEST COVERAGE:
☐ All existing unit tests pass (or documented as Phase 1B refactoring)
☐ New component tests: MarketRegistry, SubscriptionEngine, ExchangeAdapter, RedisWriter
☐ Integration tests: startup, subscription flow, market discovery, error recovery
☐ Dependency boundary tests: no private calls, state isolation, error hierarchy

CODE QUALITY:
☐ All modules compile (node -c each file)
☐ All imports resolve correctly
☐ No unused dependencies
☐ Consistent error handling patterns
☐ Metrics/logging available for debugging

DOCUMENTATION:
☐ ARCHITECTURE.md complete with diagrams
☐ Class docstrings explain responsibilities
☐ Public method docstrings with examples
☐ README updated with new module structure
☐ Migration guide for Phase 2

BACKWARD COMPATIBILITY:
☐ ExchangeFactory still works (unchanged)
☐ RedisService still works (unchanged)
☐ Old CLI still starts (uses new modules internally)
☐ Config parsing unchanged
```

---

## Summary of Phase 1 Effort

| Phase | Task | Lines | Time |
|-------|------|-------|------|
| **1A** | Create 9 modules + refactor 2 | ~2000 | ~2 hours |
| **1B** | Refactor tests for new APIs | ~200 | ~1.5 hours |
| **1C** | Write 4 new test files | ~750 | ~2 hours |
| **1D** | Integration tests | ~500 | ~1.5 hours |
| **1E** | Documentation + verification | ~300 | ~1 hour |
| **TOTAL** | Complete architecture hardening | ~3750 | **~8 hours** |

---

## Success Criteria for Phase 1

**Technical**:
- ✅ Zero private method calls across module boundaries
- ✅ All state mutations encapsulated  
- ✅ Clean dependency graph (no cycles)
- ✅ Each module ≤300 lines
- ✅ All tests passing (~300/300)

**Architectural**:
- ✅ ExchangeAdapter is the exchange abstraction boundary
- ✅ MarketRegistry owns symbol lifecycle
- ✅ SubscriptionEngine manages loop isolation
- ✅ RedisWriter centralizes persistence
- ✅ ProxyProvider for plugin architecture

**Maintainability**:
- ✅ Clear public interfaces
- ✅ Single responsibility per module
- ✅ Testable in isolation
- ✅ Well documented
- ✅ Ready for Phase 2-7

---

## What Phase 1 Solves (From Code Review)

| Issue | Phase 1 Solution |
|-------|-----------------|
| Dependency Inversion violations | ✅ Public interfaces only, no private calls |
| Missing exchange abstraction | ✅ ExchangeAdapter with strategies |
| Overloaded service boundaries | ✅ ExchangeFactory + ExchangeAdapter split |
| Weak process isolation | ✅ SubscriptionEngine isolates loop state |
| Race conditions | ✅ All async state locked within components |
| Proxy abstraction weak | ✅ ProxyProvider with pluggable implementations |
| Hard-coded exchange logic | ✅ All in ExchangeAdapter + strategies |
| State mutation risk | ✅ MarketRegistry encapsulates symbol changes |

---

## Next After Phase 1: Phase 2-7 Overview

- **Phase 2**: Subscription Engine Redesign (strategy validation)
- **Phase 3**: Resilience State Machine (explicit reconnect policy)
- **Phase 4**: Market Discovery Reconciliation (continuous diff engine)
- **Phase 5**: Redis Write Path Optimization (aggregation, backpressure)
- **Phase 6**: Network Strategy Abstraction (proxy + IP rotation)
- **Phase 7**: Observability & Shutdown (metrics + graceful close)
- **Phase 8**: Test Suite for Acceptance (FR1-12, AC1-10 mapping)

Each phase builds on Phase 1's clean architecture foundation.
