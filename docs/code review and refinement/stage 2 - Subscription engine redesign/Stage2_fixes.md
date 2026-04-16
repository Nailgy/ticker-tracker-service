# Stage 2: 8 Critical Fixes Reference

**Context**: Senior developer code review identified 8 blocking issues. All fixed & tested ✅

---

## Fix 1: Batch Identity Bug

**File**: `src/adapters/strategies/batch-watch-tickers.strategy.js`  
**Issue**: String key (`batchSymbols.join(',')`) instead of numeric index  
**Fix**: Pass numeric `batchIndex` throughout execute() → `return { ..., batchIndex }`  
**Test**: "should use stable batch index, not string join" ✅

---

## Fix 2: Data Loss Bug

**File**: `src/adapters/strategies/batch-watch-tickers.strategy.js`  
**Issue**: Only returned first ticker from batch payload  
**Fix**: Return all tickers: `const tickerArray = Object.entries(tickers).map(...)`  
**Test**: "should emit all N tickers from N-symbol batch payload" ✅

---

## Fix 3: Recursive Retry Pattern

**File**: `src/adapters/strategies/batch-watch-tickers.strategy.js`  
**Issue**: Self-recursive call causes unbounded recursion  
**Fix**: Loop-based retry with `maxAttempts = 10` counter  
**Test**: "should not infinite-recurse on empty payload" ✅

---

## Fix 4: Missing Import

**File**: `src/adapters/ccxt.adapter.js`  
**Issue**: Reference undefined `AllTickersStrategy` class  
**Fix**: Import `STRATEGY_MODES` enum, use mode string check  
**Test**: No ReferenceError at runtime ✅

---

## Fix 5: Architecture Claims

**Files**: `src/core/adapter.pool.js` + `PHASES_OVERVIEW.md`  
**Issue**: Claimed "connection isolation" (misleading)  
**Fix**: Clarified "health state isolation" (accurate) + future multi-adapter note  
**Test**: Documentation consistent with implementation ✅

---

## Fix 6: Real Behavior Tests (8 tests)

Execute actual `async *execute()` generator, not simulation  
- All N tickers emitted
- Stable batch index used
- No infinite recursion
- Re-subscription continues
- All symbols before next call
- Promise.race concurrency
- Batch error isolation
- Multi-batch coordination

---

## Fix 7: Runtime Component Tests (5 tests + 1 batch rejection)

Upgrade: Mock assertions → Real component state mutations  
- startSubscriptions: real batch execution
- AdapterPool: per-batch health isolation (real state)
- Batch rejection isolation: one error doesn't propagate
- State machine: real transitions
- Lifecycle: stopped state prevents refresh

---

## Fix 8: Anti-Regression Tests (8 tests)

Core requirement regression protection  
- Selector precedence: override > default > capability
- Long-lived loop: batch completion doesn't block others
- Promise.race: no anti-pattern
- State isolation: one batch error isolated
- No data loss: all batch tickers emitted
- Numeric batch index: not string
- Recursion safe: max attempts enforced
- Staggered timing: sequential batch startup

---

## Summary

| Fix | Status | Test Count |
|-----|--------|-----------|
| 1-3 | Code fixed | Behavior tests (8) |
| 4 | Import fixed | Runtime tests (6) |
| 5 | Docs clarified | N/A |
| 6 | Tests added | 8 behavior tests |
| 7 | Tests upgraded | 6 runtime tests |
| 8 | Tests added | 8 anti-regression |
| **Total** | **✅ Complete** | **+24 new tests** |

**All 410+ tests passing ✅**
