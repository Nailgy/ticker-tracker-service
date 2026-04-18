# Stage 5 Redis Write-Path Optimization - Implementation Plan

## Overview

**Status**: BLOCKING - 6 Critical Issues Prevent Senior Developer Approval

Senior backend developer identified 6 blocking issues in Stage 5 implementation that prevent moving to Stage 6. This plan systematizes fixes to all 6 issues with minimal risk and maximum proof.

---

## Issue Summary

| # | Issue | Impact | Blocking |
|---|-------|--------|----------|
| 5A | Silent Redis failure path | Redis outage drops persistence silently | YES |
| 5B | Pipeline partial errors treated as success | Partial write failures silently acknowledged | YES |
| 5C | No flush concurrency guard | Overlapping flushes duplicate writes under load | YES |
| 5D | Dedup cache cleanup missing | Unbounded memory growth from symbol churn | YES |
| 5E | Duplicated write authority | Architectural drift, bypass risk | YES |
| 5F | Missing acceptance evidence | No tests proving failure modes work | YES |

---

## Issue 5A: Silent Redis Failure Path (BLOCKING)

**Problem**
- `RedisWriter.writeTicker()` returns `{written: false, reason: 'redis-not-connected'}` (line 64-69)
- `SubscriptionEngine` ignores return value when calling it (line 329-334)
- Redis outage can drop persistence with zero error escalation

**Current Code**
```javascript
// redis.writer.js line 64-69
if (!this.redisService.isReady()) {
  return { written: false, reason: 'redis-not-connected' };  // ← Silently ignored
}

// subscription.engine.js line 329-334
await this.writer.writeTicker(this.exchangeId, this.marketType, symbol, ticker);
// ↑ Return value discarded, only exception caught in outer try-catch
```

**Fix Strategy**
1. Create typed error classes (RedisWriteError, RedisFlushError)
2. Make `writeTicker()` throw typed errors instead of returning status
3. Let SubscriptionEngine catch and propagate to error callbacks

**Code Changes**

```javascript
// Add to redis.writer.js (top of class)
class RedisWriteError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'RedisWriteError';
    this.reason = reason;
  }
}

// Update writeTicker() method
async writeTicker(exchange, marketType, symbol, tickerData) {
  if (!this.redisService.isReady()) {
    this.metrics.failedWrites++;
    throw new RedisWriteError('Redis not connected', 'redis-not-connected');
  }
  // ... rest of logic unchanged
}

// Update _writeUpdate() to throw
async _writeUpdate(update) {
  try {
    const pipeline = this.redisService.createPipeline();
    pipeline.hset(update.key, update.field, update.value);
    pipeline.publish(update.pubsubChannel, update.value);
    await this.redisService.execPipeline(pipeline);
    // ...
  } catch (error) {
    this.metrics.failedWrites++;
    throw new RedisWriteError(error.message, 'write-error');
  }
}
```

**Files Modified**: `src/services/redis.writer.js`  
**Lines**: ~15  
**Risk**: Low (catching exceptions already works in engine)

---

## Issue 5B: Pipeline Partial Errors Treated as Success (BLOCKING)

**Problem**
- `flush()` checks only `result && result.length > 0` (line 187)
- ioredis pipeline can return mixed `[[err, res], [null, res], ...]` format
- Each tuple is `[error, result]`, needs validation
- Partial failures are silently acknowledged and cleared from queue

**Current Code**
```javascript
// redis.writer.js line 185-201
const result = await this.redisService.execPipeline(pipeline);
if (result && result.length > 0) {  // ← Only checks length, not errors!
  this.metrics.flushedBatches++;
  this.batch.clear();  // ← Cleared even if some failed!
}
```

**Fix Strategy**
1. Validate each pipeline result tuple: `[err, res]`
2. On any errors found: requeue updates back to batch, throw error
3. Fail atomically: all-or-nothing semantics

**Code Changes**

```javascript
// Add error class (after RedisWriteError)
class RedisFlushError extends Error {
  constructor(message, failedCount) {
    super(message);
    this.name = 'RedisFlushError';
    this.failedCount = failedCount;
  }
}

// Update flush() method validation
const result = await this.redisService.execPipeline(pipeline);

// Validate each result tuple
const failed = result.filter(([err]) => err != null);
if (failed.length > 0) {
  // Requeue: put updates back in batch for retry
  for (const u of updates) {
    this.batch.set(u.field, u);
  }
  this.metrics.failedWrites++;
  throw new RedisFlushError(
    `Redis pipeline partial failure: ${failed.length}/${result.length} commands failed`,
    failed.length
  );
}

// Only clear batch if ALL succeeded
this.metrics.flushedBatches++;
this.metrics.queuedUpdates = 0;
this.batch.clear();
```

**Files Modified**: `src/services/redis.writer.js`  
**Lines**: ~20  
**Risk**: Low (properly validates errors, requeues on failure)

---

## Issue 5C: No Flush Concurrency Guard (BLOCKING)

**Problem**
- `flush()` has no mutex/promise guard (line 160+)
- Can be called concurrently from: batch timer, max-batch path, shutdown
- ioredis pipeline isn't atomic across separate calls
- Overlapping flushes can duplicate writes and produce inconsistent queue state under load

**Current Code**
```javascript
// redis.writer.js (NO concurrency guard!)
async flush() {
  if (this.batch.size === 0) return { flushed: true, count: 0 };
  
  // What if called again while first flush is executing?
  const updates = Array.from(this.batch.values());
  this.batch.clear();  // ← Cleared even if first flush still executing
  
  const result = await this.redisService.execPipeline(pipeline);
  // If second flush arrives here, it clears the same batch twice
}
```

**Fix Strategy**
1. Add single-flight mutex using Promise: `this.flushPromise`
2. Use copy-swap semantics: copy batch, clear it, then execute
3. Concurrent calls coalesce into one execution
4. Pattern from senior developer + proven in RedisService

**Code Changes**

```javascript
// Add to constructor
this.flushPromise = null;

// Rewrite flush() with single-flight pattern
async flush() {
  // Early return if already flushing (coalesce)
  if (this.flushPromise) {
    return this.flushPromise;
  }

  if (this.batch.size === 0) {
    return { flushed: true, count: 0 };
  }

  // Single-flight: set promise BEFORE executing
  this.flushPromise = (async () => {
    // Copy-swap: copy then clear immediately
    const updates = Array.from(this.batch.values());
    this.batch.clear();

    try {
      const pipeline = this.redisService.createPipeline();

      for (const update of updates) {
        pipeline.hset(update.key, update.field, update.value);
        pipeline.publish(update.pubsubChannel, update.value);
      }

      const result = await this.redisService.execPipeline(pipeline);

      // Validate each result tuple
      const failed = result.filter(([err]) => err != null);
      if (failed.length > 0) {
        // Requeue failed updates
        for (const u of updates) {
          this.batch.set(u.field, u);
        }
        throw new RedisFlushError(
          `Redis pipeline partial failure: ${failed.length}/${result.length}`,
          failed.length
        );
      }

      this.metrics.flushedBatches++;
      this.metrics.queuedUpdates = 0;
      this.metrics.lastFlushAt = Date.now();

      return { flushed: true, count: updates.length };
    } catch (error) {
      this.metrics.failedWrites++;
      throw error;  // Propagate to caller
    }
  })().finally(() => {
    // Release lock after either success or failure
    this.flushPromise = null;
  });

  return this.flushPromise;
}
```

**Files Modified**: `src/services/redis.writer.js`  
**Lines**: ~80  
**Risk**: Medium (timing-sensitive, but proven pattern)

---

## Issue 5D: Dedup Cache Cleanup Missing (BLOCKING)

**Problem**
- When symbols are delisted/removed, they're deleted from registry
- But dedup cache is NEVER pruned: `dedupCache.set(symbol, {hash, lastWriteTime})`
- Pending batch entries for removed symbols stay queued
- Under Stage 4 symbol churn (new/removed markets detected frequently), cache grows unbounded → memory leak

**Current Code**
```javascript
// market.registry.js - symbol removal
removeSymbols(symbols) {
  for (const sym of symbols) {
    this.activeSymbols.delete(sym);  // ← Removed from tracking
    this.batchAllocations.forEach(batch => batch.delete(sym));
  }
}
// ↑ NO call to RedisWriter or RedisService to clean cache!
```

**Fix Strategy**
1. Add `removeSymbols(symbols)` method to RedisWriter
2. Removes symbol from dedupCache AND pending batch
3. Call it from ConnectionManager when symbols are removed

**Code Changes**

```javascript
// Add to redis.writer.js
removeSymbols(symbols) {
  const removed = [];
  for (const symbol of symbols) {
    if (this.dedupCache.delete(symbol)) {
      removed.push(symbol);
    }
    // Also remove from pending batch (state-collapsing queue)
    if (this.batch.delete(symbol)) {
      removed.push(symbol);
    }
  }
  
  if (removed.length > 0) {
    this.metrics.queuedUpdates = this.batch.size;
    this.config.logger('info', `RedisWriter: Cleaned ${removed.length} symbols from cache/batch`, {
      cacheSize: this.dedupCache.size,
      batchSize: this.batch.size,
    });
  }
  
  return {
    removed,
    cacheSize: this.dedupCache.size,
    batchSize: this.batch.size,
  };
}

// Update connection.manager.js (in refreshMarkets, after removeSymbols)
if (removed.length > 0 && this.#redisWriter) {
  this.#redisWriter.removeSymbols(removed);
}
```

**Files Modified**: 
- `src/services/redis.writer.js`
- `src/core/connection.manager.js`

**Lines**: ~30 total  
**Risk**: Low (additive, called from well-defined location)

---

## Issue 5E: Duplicated Write Authority (MAJOR)

**Problem**
- Both `RedisService` and `RedisWriter` contain full write/dedup/batch logic
- RedisService has: `updateTicker()`, `flush()`, `_writeUpdate()`, `dedupCache`, `batch`, `batchTimer`, `isFlushing`
- RedisWriter has identical logic
- Architectural drift: which is the "single authority"?
- Risk of bypass: code might call RedisService directly instead of RedisWriter

**Current Code**
```javascript
// RedisService (duplicated)
async updateTicker() { /* dedup, batch, rate limit */ }
async flush() { /* pipeline, no error validation */ }
_hashTicker() { /* hash calculation */ }

// RedisWriter (same logic)
async writeTicker() { /* dedup, batch, rate limit */ }
async flush() { /* pipeline, no error validation */ }
_hashData() { /* hash calculation */ }
```

**Fix Strategy**
1. Make RedisService **transport-only**: just connection & pipeline
2. Keep: `connect()`, `disconnect()`, `createPipeline()`, `execPipeline()`, `getTicker()`, `getAllTickers()`, `deleteTicker()`, `subscribe()`
3. Remove: `updateTicker()`, `flush()`, `_writeUpdate()`, all batching/dedup fields
4. RedisWriter becomes single authority for all write semantics
5. Pass RedisWriter (not RedisService) to SubscriptionEngine

**Code Changes**

```javascript
// RedisService - REMOVE these methods and fields:
// Remove methods:
// - updateTicker(exchange, marketType, symbol, tickerData)
// - _writeUpdate(update)
// - flush()
// - _hashTicker(data)
// - _startBatchTimer()
// - _stopBatchTimer()

// Remove fields:
// - this.batch (array)
// - this.batchTimer
// - this.isFlushing
// - this.dedupCache (Map)
// - Remove stats: totalUpdates, dedupedUpdates, batchedUpdates, flushedBatches, failedWrites

// Keep: connect, disconnect, createPipeline, execPipeline, getTicker, getAllTickers, deleteTicker, subscribe, isReady

// Update getStatus() to remove write stats
getStatus() {
  return {
    isConnected: this.isConnected,
    isConnecting: this.isConnecting,
    // Remove: batchSize, dedupCacheSize
    // Keep only connection-level stats
  };
}
```

```javascript
// ConnectionManager - instantiate and pass RedisWriter
const RedisWriter = require('./services/redis.writer');

constructor(config) {
  this.#redisService = new RedisService(config);
  this.#redisWriter = new RedisWriter(this.#redisService, config);  // ← NEW
}

async startSubscriptions() {
  this.#subscriptionEngine = new SubscriptionEngine(
    adapterFactory,
    this.#marketRegistry,
    this.#redisWriter,  // ← Pass RedisWriter, not RedisService
    config
  );
}
```

**Files Modified**:
- `src/services/redis.service.js` (major refactor - remove ~80 lines)
- `src/core/connection.manager.js` (add RedisWriter creation)
- `src/core/subscription.engine.js` (already uses writer field correctly)
- Any test files using `redisService.updateTicker()` → use RedisWriter

**Lines**: ~150 total  
**Risk**: HIGH (removal risk - must update all callers first)

---

## Issue 5F: Acceptance Evidence Gap (MAJOR)

**Problem**
- No Stage 5 integration tests proving failure modes work correctly
- Can't validate: Redis-down error handling, pipeline partial failures, concurrent flush coalescing, cache cleanup
- Senior developer can't approve without evidence

**Fix Strategy**
Add 5 integration tests to validate:
1. Redis connection failure → throws typed error
2. Pipeline partial failure → requeues updates
3. Concurrent flush calls → only one executes (coalesced)
4. Symbol removal → cache cleaned up
5. End-to-end write failure → engine error callback fired

**Code Changes** (new file: `tests/integration/stage-5-redis-failures.test.js`)

```javascript
describe('Stage 5: Redis Write-Path Failures', () => {
  let redisWriter, mockRedis, mockLogger;

  beforeEach(() => {
    mockLogger = jest.fn();
    mockRedis = {
      isReady: jest.fn(() => true),
      createPipeline: jest.fn(() => ({
        hset: jest.fn().mockReturnThis(),
        publish: jest.fn().mockReturnThis(),
      })),
      execPipeline: jest.fn(),
    };
    redisWriter = new RedisWriter(mockRedis, { logger: mockLogger });
  });

  test('5A: writeTicker throws RedisWriteError when Redis not connected', async () => {
    mockRedis.isReady.mockReturnValue(false);
    
    await expect(
      redisWriter.writeTicker('binance', 'spot', 'BTC/USDT', { last: 100 })
    ).rejects.toThrow(expect.objectContaining({
      name: 'RedisWriteError',
      reason: 'redis-not-connected',
    }));
  });

  test('5B: flush throws RedisFlushError and requeues on partial failure', async () => {
    const update = {
      key: 'ticker:binance:spot',
      field: 'BTC/USDT',
      value: '{"last":100}',
      pubsubChannel: 'ticker:binance:spot:BTC/USDT',
    };
    
    redisWriter.batch.set('BTC/USDT', update);
    
    // Mock pipeline partial failure: [error, null] for first cmd
    mockRedis.execPipeline.mockResolvedValue([
      [new Error('Connection refused'), null],
      [null, 1],
    ]);

    await expect(
      redisWriter.flush()
    ).rejects.toThrow(expect.objectContaining({
      name: 'RedisFlushError',
      failedCount: 1,
    }));

    // Verify update was requeued
    expect(redisWriter.batch.has('BTC/USDT')).toBe(true);
  });

  test('5C: Concurrent flush calls coalesce into single execution', async () => {
    const update = {
      key: 'ticker:binance:spot',
      field: 'BTC/USDT',
      value: '{"last":100}',
      pubsubChannel: 'ticker:binance:spot:BTC/USDT',
    };
    
    redisWriter.batch.set('BTC/USDT', update);

    // Mock slow pipeline
    mockRedis.execPipeline.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve([[null, 1], [null, 1]]), 100))
    );

    // Call flush 5 times concurrently
    const promises = Array(5).fill().map(() => redisWriter.flush());
    await Promise.all(promises);

    // Pipeline should be called only ONCE
    expect(mockRedis.execPipeline).toHaveBeenCalledTimes(1);
  });

  test('5D: removeSymbols cleans dedup cache and batch', async () => {
    // Populate cache
    redisWriter.dedupCache.set('BTC/USDT', { hash: 'abc', lastWriteTime: Date.now() });
    redisWriter.dedupCache.set('ETH/USDT', { hash: 'def', lastWriteTime: Date.now() });
    
    redisWriter.batch.set('BTC/USDT', { field: 'BTC/USDT', value: '{}' });
    redisWriter.batch.set('ETH/USDT', { field: 'ETH/USDT', value: '{}' });

    const result = redisWriter.removeSymbols(['BTC/USDT', 'ETH/USDT']);

    expect(result.removed.length).toBeGreaterThan(0);
    expect(redisWriter.dedupCache.size).toBe(0);
    expect(redisWriter.batch.size).toBe(0);
  });

  test('5F: End-to-end - write failure propagates to engine', async () => {
    // This is integration level: ConnectionManager → SubscriptionEngine → RedisWriter
    // Setup mock adapter that yields tickers
    // Setup Redis connection failure
    // Verify error callback is called
    
    // Pseudocode:
    // const manager = new ConnectionManager(config with mock redis)
    // const errors = []
    // engine.onError((batchId, err) => errors.push(err))
    // await engine.startSubscriptions([[BTC/USDT]])
    // await new Promise(...) // wait for tickers
    // expect(errors).toContainEqual(expect.objectContaining({ name: 'RedisWriteError' }))
  });
});
```

**Files Modified**: `tests/integration/stage-5-redis-failures.test.js` (NEW)  
**Lines**: ~200  
**Risk**: Low (test code only)

---

## Implementation Sequence

### Phase 1: Typed Errors + Pipeline Validation (5A + 5B)
- **File**: `src/services/redis.writer.js`
- **Changes**: Add error classes, validate pipeline results, requeue on failure
- **Time**: 30 min
- **Risk**: Low
- **Test**: Existing tests should still pass (exceptions now thrown instead of returned)

### Phase 2: Single-Flight Flush Guard (5C)
- **File**: `src/services/redis.writer.js`
- **Changes**: Add flushPromise field, implement copy-swap pattern
- **Time**: 40 min
- **Risk**: Medium (timing-sensitive)
- **Test**: Should pass concurrent flush test

### Phase 3: Cache Cleanup on Symbol Removal (5D)
- **Files**: `src/services/redis.writer.js`, `src/core/connection.manager.js`
- **Changes**: Add removeSymbols() method, call from manager
- **Time**: 20 min
- **Risk**: Low
- **Test**: Should cleanup cache/batch on symbol removal

### Phase 4: Single Write Authority (5E) - HIGHEST RISK
- **Files**: `src/services/redis.service.js`, `src/core/connection.manager.js`, tests
- **Changes**: Remove write logic from RedisService, create RedisWriter in manager
- **Time**: 60 min
- **Risk**: HIGH (removal changes API)
- **Must do**: Search codebase for all `redisService.updateTicker()` and `redisService.flush()` calls
- **Test**: Update any test calling removed methods

### Phase 5: Integration Tests (5F)
- **File**: `tests/integration/stage-5-redis-failures.test.js` (NEW)
- **Changes**: Add 5 comprehensive integration tests
- **Time**: 90 min
- **Risk**: Low
- **Test**: All new tests should pass

---

## Summary Table

| Phase | Issue | File | Lines | Risk | Time |
|-------|-------|------|-------|------|------|
| 1 | 5A+5B | redis.writer.js | ~50 | Low | 30m |
| 2 | 5C | redis.writer.js | ~80 | Med | 40m |
| 3 | 5D | redis.writer.js + connection.manager.js | ~30 | Low | 20m |
| 4 | 5E | redis.service.js + connection.manager.js + tests | ~150 | HIGH | 60m |
| 5 | 5F | stage-5-redis-failures.test.js | ~200 | Low | 90m |
| **Total** | **All 6** | **4 files** | **~510** | **HIGH** | **240m** |

---

## Success Criteria for Senior Developer Approval

✅ **5A Fixed**: writeTicker() throws RedisWriteError; SubscriptionEngine catches and propagates  
✅ **5B Fixed**: flush() validates each [err, res] tuple; failed updates requeued atomically  
✅ **5C Fixed**: flush() single-flight with Promise; concurrent calls coalesce to one execution  
✅ **5D Fixed**: removeSymbols() prunes dedup cache and batch; memory bounded under churn  
✅ **5E Fixed**: RedisService transport-only; RedisWriter single write authority  
✅ **5F Fixed**: 5 integration tests prove all failure modes handled correctly  

**Final Test**: `npm test` should show 531+ tests (526 Stage 4 + 5 new Stage 5) all passing, zero regressions

---

## Pre-Implementation Checklist

- [ ] Search codebase for all calls to `RedisService.updateTicker()`
- [ ] Search codebase for all calls to `RedisService.flush()`
- [ ] Search codebase for all calls to `RedisService._writeUpdate()`
- [ ] List all test files that use RedisService write methods
- [ ] Verify RedisWriter is correctly passed to SubscriptionEngine
- [ ] Backup current redis.service.js before removal (phase 4)

---

## Notes for Execution

**Phase 1-3**: Low-risk additions. Can be merged incrementally.

**Phase 4**: HIGHEST RISK due to API removal. Must be done carefully:
1. First: Create and pass RedisWriter from ConnectionManager
2. Then: Update all test files to use RedisWriter
3. Finally: Remove write methods from RedisService
4. Verify: No dangling references to removed methods

**Phase 5**: Validation only. Tests can fail initially; fix implementations until all pass.

**Rollback Strategy**: If Phase 4 breaks critical functionality:
1. Revert redis.service.js to re-add write methods
2. Keep RedisWriter changes (not breaking)
3. Continue with Phase 5 (tests)
4. Return to Phase 4 after stabilization

