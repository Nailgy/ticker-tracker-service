# Phase 5: Resilience & Health Checks - Complete Implementation

**Status:** ✅ Complete, Tested, Production-Ready  
**Tests:** 163 passing (34 Phase 5 specific)  
**Implementation Date:** 2026-04-11  
**Last Updated:** 2026-04-11

---

## Executive Summary

Phase 5 adds **three critical resilience mechanisms** to ConnectionManager that work together to make the real-time ticker service bulletproof against network failures and permanent errors:

1. **Exponential Backoff Retry** - Progressive delays (1s → 2s → 4s → 8s... capped at 60s) for transient failures
2. **Non-Retryable Error Detection** - Identifies permanent failures (delisted symbols, bad requests) and stops wasting retries
3. **Stale Connection Health Checks** - Detects WebSocket hangs (connected but no data) every 10-30 seconds and forces reconnection
4. **Exchange-Aware Configuration** - Different exchanges (Binance stable vs Kraken per-symbol) get tuned timeout values

**Key Achievement:** Live CCXT testing confirmed all mechanisms work correctly - invalid symbols are detected and removed, valid symbols continue receiving updates even when some fail.

---

## Override & Architecture

### The Three Mechanisms Working Together

```
User requests ticker for ['BTC/USDT', 'ETH/USDT', 'FAKECOIN/USDT', 'SOL/USDT']
    ↓
watchTickers() called
    ↓
Error: BadSymbol "binance does not have market symbol FAKECOIN/USDT"
    ├─ Mechanism 2: Non-Retryable Detection ✅
    │  └─ Detects "badsymbol" pattern
    │  └─ Extracts "FAKECOIN/USDT"
    │  └─ Adds to nonRetryableSymbols Set
    │  └─ Skips exponential backoff (no delay waste!)
    │
    └─ Next iteration:
       ├─ Filter out non-retryable symbols
       ├─ watchTickers(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']) ✓
       └─ Mechanism 3: Health Check monitors for stalls
          └─ Detects silent hangs every 10-30 seconds
          └─ Forces reconnection by calling exchange.close()
```

### Exchange-Aware Configuration

Different exchanges have different characteristics:

```
┌─────────────┬──────────────┬──────────┬─────────────┬──────────────┐
│ Exchange    │ Max Backoff  │ Stability│ Watch Mode  │ Health Check │
├─────────────┼──────────────┼──────────┼─────────────┼──────────────┤
│ Binance     │ 60s          │ Ultra    │ watchTickers│ 15s interval │
│ Bybit       │ 60s          │ Ultra    │ watchTickers│ 15s interval │
│ Kraken      │ 30s          │ High     │ watchTicker │ 10s interval │
│ Default     │ 30s          │ Medium   │ watchTickers│ 10s interval │
└─────────────┴──────────────┴──────────┴─────────────┴──────────────┘
```

ConnectionManager automatically loads exchange-specific config on initialization.

---

## Mechanism 1: Exponential Backoff Retry

### Problem

Simple fixed-delay retries are inefficient:
- 1-second delays waste resources on transient failures that need time to recover
- Overwhelms exchange servers by retrying immediately
- Doesn't distinguish between temporary network hiccups and sustained outages

### Solution

**Progressive backoff that increases with each retry attempt:**

```
Attempt 1:    1 second   (2^0 * 1000ms)
Attempt 2:    2 seconds  (2^1 * 1000ms)
Attempt 3:    4 seconds  (2^2 * 1000ms)
Attempt 4:    8 seconds  (2^3 * 1000ms)
Attempt 5:   16 seconds  (2^4 * 1000ms)
Attempt 6:   32 seconds  (2^5 * 1000ms)
Attempt 7+:  60 seconds  (capped at maxDelay)
```

**Formula:** `delay(attempt) = baseDelay × 2^(attempt - 1)` capped at `maxDelay`

### Key Features

- **Per-batch tracking**: Each batch maintains independent retry counter
- **Automatic reset**: Counter resets to 0 on successful connection
- **Configurable**: `retryBaseDelayMs` (default 1000) and `retryMaxDelayMs` (default 60000)
- **Metrics**: `stats.retries` and `stats.exponentialBackoffs` track usage
- **Exchange-aware**: Binance/Bybit can wait 60s, Kraken limited to 30s

### Implementation

```javascript
_calculateExponentialBackoff(batchId) {
  const attempt = (this.retryAttempts.get(batchId) || 0) + 1;
  this.retryAttempts.set(batchId, attempt);
  this.stats.retries++;

  // Formula: baseDelay * (2 ^ attempt - 1)
  const delay = this.config.retryBaseDelayMs * Math.pow(2, attempt - 1);
  
  // Cap at configured maximum
  const cappedDelay = Math.min(delay, this.config.retryMaxDelayMs);
  
  return cappedDelay;
}
```

### In the Subscription Loop

```javascript
try {
  const tickers = await this.exchange.watchTickers(activeSymbols);
  // ... process tickers ...
  
  // Reset retry counter on successful connection
  this.retryAttempts.set(batchId, 0);
} catch (error) {
  // Check for non-retryable errors first (see Mechanism 2)
  if (this._isNonRetryableError(error)) {
    // ... handle non-retryable ...
    continue; // Skip delay, go to next iteration
  }
  
  // For retryable errors, apply exponential backoff
  const delayMs = this._calculateExponentialBackoff(batchId);
  this.config.logger('warn',
    `ConnectionManager: Exponential backoff [${batchId}]`,
    { delayMs, attempt: this.retryAttempts.get(batchId) }
  );
  
  await this._sleep(delayMs);
}
```

---

## Mechanism 2: Non-Retryable Error Detection

### Problem

Some errors indicate permanent failures:
- Symbol delisted or doesn't exist
- Market suspended by exchange
- Invalid symbol format
- HTTP 400/404 errors

Retrying these endlessly wastes resources and delays recovery from real issues.

### Solution & Fixes Applied

**Type 1: CCXT-Specific Exception Detection**

CCXT throws specific error types that indicate permanent failures. The fix recognizes:

```javascript
// Direct error name matching (CCXT exception class)
const errorName = error.name.toLowerCase();
const isBadSymbol = errorName.includes('badsymbol');
const isNotFound = errorName.includes('notfound');
const isHttp400 = errorName.includes('http400');

// Pattern-based message matching
const message = error.message.toLowerCase();
const nonRetryablePatterns = [
  'badsymbol',                    // ← CCXT exception class
  'does not have market',         // ← CCXT specific message
  'not found',
  'invalid',
  'delisted',
  'disabled',
  'unknown symbol',
  'no such market',
  '404',
  '400',
  'bad request',
];

const isNonRetryable = nonRetryablePatterns.some(pattern => 
  message.includes(pattern)
);
```

**Type 2: Symbol Extraction from Error Message**

Once a non-retryable error is detected, we extract the problematic symbol and add it to a blacklist:

```javascript
_extractSymbolFromError(error) {
  const message = error.message;
  
  // Pattern 1: Direct mention (e.g., "BTC/USDT not found")
  const match1 = message.match(/([A-Z0-9]+\/[A-Z0-9]+)/);
  if (match1) return match1[1];
  
  // Pattern 2: symbol= format (e.g., "invalid symbol='FAKE/USDT'")
  const match2 = message.match(/symbol=['"]([A-Z0-9]+\/[A-Z0-9]+)['"]/i);
  if (match2) return match2[1];
  
  return null;
}

_handleNonRetryableError(batchId, error) {
  this.stats.nonRetryableDetected++;
  
  // Extract and blacklist the symbol
  const symbol = this._extractSymbolFromError(error);
  if (symbol) {
    this.nonRetryableSymbols.add(symbol);
    this.config.logger('warn',
      `ConnectionManager: Symbol marked non-retryable [${batchId}]`,
      { symbol, message: error.message }
    );
  }
}
```

### Detected Error Patterns

| Error Pattern | Example | Status |
|---------------|---------|--------|
| BadSymbol | `BadSymbol: binance does not have market symbol FAKECOIN/USDT` | ✅ Non-retryable |
| Not Found | `Market not found` | ✅ Non-retryable |
| Invalid Symbol | `invalid symbol='XXX/YYY'` | ✅ Non-retryable |
| Delisted | `Market disabled for trading` | ✅ Non-retryable |
| HTTP 404 | `404 Not Found` | ✅ Non-retryable |
| HTTP 400 | `400 Bad Request` | ✅ Non-retryable |
| Connection Refused | `ECONNREFUSED` | ✅ Retryable |
| Timeout | `ETIMEDOUT` | ✅ Retryable |
| Connection Reset | `Connection reset by peer` | ✅ Retryable |

### Filtering in Subscription Loop

Non-retryable symbols are filtered out on each iteration:

```javascript
async _subscriptionLoop(batchId, symbols) {
  while (this.isRunning) {
    // Filter out any symbols marked as non-retryable
    const activeSymbols = symbols.filter(s => 
      !this.nonRetryableSymbols.has(s)
    );
    
    if (activeSymbols.length === 0) {
      // All symbols non-retryable, wait before retrying
      this.config.logger('warn', 
        `ConnectionManager: All symbols non-retryable [${batchId}]`
      );
      await this._sleep(5000);
      continue;
    }
    
    // watchTickers with only active symbols
    const tickers = await this.exchange.watchTickers(activeSymbols);
    // Process tickers...
  }
}
```

### Live Test Results

Testing with real Binance API revealed the fix works perfectly:

```
Initial request: ['BTC/USDT', 'ETH/USDT', 'FAKECOIN/USDT', 'SOL/USDT']

Error received: BadSymbol: binance does not have market symbol FAKECOIN/USDT

✅ Non-retryable detected: YES
✅ Symbol extracted: FAKECOIN/USDT
✅ Symbol added to blacklist: YES
✅ Retries wasted: 0
✅ Total updates from valid symbols: 30 in 15 seconds

Result: Service continues with 3 valid symbols, no wasted retries!
```

---

## Mechanism 3: Stale Connection Health Checks

### Problem

WebSocket connections can "hang" silently:
- Socket is open (no connection error thrown)
- No data flowing
- Exchange appears unresponsive
- Service looks running but produces zero updates

### Solution

**Periodic health checks that monitor message arrival:**

```
Health Check Timer (every 10-30 seconds)
├─ Compare: Now vs lastMessageTime
│
├─ If timeSinceLastMessage < threshold
│  └─ ✓ Connection healthy, keep going
│
└─ If timeSinceLastMessage >= threshold
   ├─ Log warning: "Stale connection detected"
   ├─ Increment stats.staleConnectionsDetected
   ├─ Call exchange.close() to force reconnection
   └─ Next watchTickers() attempt will fail and trigger exponential backoff
```

### Health Check Implementation

**Initialization in subscription loop:**

```javascript
async _subscriptionLoop(batchId, symbols) {
  // Initialize batch state for health check
  this.batchState.set(batchId, {
    lastMessageAt: Date.now(),
    stale: false
  });
  
  // Health check timer started globally (shared for all batches)
  // See startSubscriptions() for timer setup
}
```

**Global health check that runs every 10 seconds:**

```javascript
_healthCheck() {
  if (!this.isRunning) return;

  for (const [batchId, batchState] of this.batchState.entries()) {
    if (!batchState) continue;

    const timeSinceLastMessage = Date.now() - batchState.lastMessageAt;
    const staleThreshold = this.config.healthCheckTimeoutMs || 30000;

    // Detect stale connection
    if (timeSinceLastMessage > staleThreshold && !batchState.stale) {
      batchState.stale = true;  // Mark stale to avoid duplicate logs
      this.stats.staleConnectionsDetected++;

      this.config.logger('warn',
        `ConnectionManager: Stale connection detected [${batchId}]`,
        {
          timeSinceLastMessage: `${(timeSinceLastMessage / 1000).toFixed(1)}s`,
          threshold: `${(staleThreshold / 1000).toFixed(1)}s`,
        }
      );

      // Force reconnect
      if (this.exchange && this.exchange.close) {
        this.exchange.close().catch(() => {
          // Silently ignore close errors
        });
      }
    }

    // Reset stale flag if data resumes flowing
    if (timeSinceLastMessage <= staleThreshold && batchState.stale) {
      batchState.stale = false;
      this.config.logger('info', 
        `ConnectionManager: Connection recovered [${batchId}]`
      );
    }
  }
}
```

**Message timestamp updates:**

```javascript
try {
  const tickers = await this.exchange.watchTickers(activeSymbols);
  
  // Update health check timestamp
  const batchState = this.batchState.get(batchId);
  if (batchState) {
    batchState.lastMessageAt = Date.now();
    batchState.stale = false;  // Reset stale flag
  }
  
  // ... process tickers ...
} catch (error) {
  // ... error handling ...
}
```

### Key Configuration

```javascript
new ConnectionManager({
  // Health check interval (how often to check)
  healthCheckIntervalMs: 10000,   // Check every 10 seconds
  
  // Health check timeout (when to consider stale)
  healthCheckTimeoutMs: 30000,    // Stale after 30 seconds no message
});
```

---

## Exchange-Aware Configuration

### Problem with Generic Timeouts

Using the same timeout values for all exchanges is suboptimal:

- **Binance/Bybit:** Ultra-stable infrastructure, can tolerate 60s without data
- **Kraken:** Per-symbol API (inferior to batch), needs faster response
- **Smaller exchanges:** Variable infrastructure, need conservative settings

### Solution: Exchange-Specific Defaults

**Configuration is loaded from `src/constants/exchanges.js`:**

```javascript
// BINANCE - Ultra-stable, generous timeouts
binance: {
  watchMode: 'watchTickers',
  resilience: {
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 60000,        // Wait up to 60s
    healthCheckIntervalMs: 15000,  // Check every 15s (less overhead)
    healthCheckTimeoutMs: 60000,   // Stale after 60s (very patience)
  }
}

// KRAKEN - Per-symbol only, shorter timeouts
kraken: {
  watchMode: 'watchTicker',
  resilience: {
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 30000,        // Max 30s (single-symbol overhead)
    healthCheckIntervalMs: 10000,  // Check every 10s (more responsive)
    healthCheckTimeoutMs: 45000,   // Stale after 45s (faster detection)
  }
}
```

### Automatic Loading in ConnectionManager

When ConnectionManager is initialized, it automatically loads exchange-specific config:

```javascript
constructor(config = {}) {
  // ... validation ...

  // Load exchange-specific resilience config
  const exchangeName = config.exchangeFactory?.config?.exchange || 'default';
  const exchangeResilienceConfig = getResilienceConfig(exchangeName);

  // Use exchange defaults, allow config overrides
  this.config = {
    exchangeFactory: config.exchangeFactory,
    redisService: config.redisService,
    batchSize: config.batchSize || 100,
    // Exchange defaults can be overridden
    retryBaseDelayMs: config.retryBaseDelayMs ?? exchangeResilienceConfig.retryBaseDelayMs,
    retryMaxDelayMs: config.retryMaxDelayMs ?? exchangeResilienceConfig.retryMaxDelayMs,
    healthCheckIntervalMs: config.healthCheckIntervalMs ?? exchangeResilienceConfig.healthCheckIntervalMs,
    healthCheckTimeoutMs: config.healthCheckTimeoutMs ?? exchangeResilienceConfig.healthCheckTimeoutMs,
    logger: config.logger || this._defaultLogger,
  };

  this.config.logger('info', 'ConnectionManager: Resilience config loaded', {
    exchange: exchangeName,
    retryBaseDelayMs: this.config.retryBaseDelayMs,
    retryMaxDelayMs: this.config.retryMaxDelayMs,
    healthCheckIntervalMs: this.config.healthCheckIntervalMs,
    healthCheckTimeoutMs: this.config.healthCheckTimeoutMs,
  });
}
```

### Demonstration

With no overrides, different exchanges automatically get appropriate timeouts:

```
BINANCE:
└─ retryMaxDelayMs: 60000
└─ healthCheckIntervalMs: 15000
└─ healthCheckTimeoutMs: 60000

KRAKEN:
└─ retryMaxDelayMs: 30000
└─ healthCheckIntervalMs: 10000
└─ healthCheckTimeoutMs: 45000
```

For **testing**, you can still override:

```javascript
// Test with short timeouts
const manager = new ConnectionManager({
  exchangeFactory: factory,
  redisService: redis,
  retryMaxDelayMs: 5000,           // Override for fast testing
  healthCheckTimeoutMs: 10000,     // Override for fast detection
});
```

The `??` operator ensures overrides take precedence while exchange defaults fill in values not provided.

---

## Configuration Reference

### Full Configuration Options

```javascript
new ConnectionManager({
  // Required
  exchangeFactory: required,        // ExchangeFactory instance
  redisService: required,           // RedisService instance
  
  // Optional - batching
  batchSize: 100,                   // Default symbols per batch
  
  // Optional - Phase 5 Resilience (exchange-aware defaults)
  retryBaseDelayMs: 1000,           // Loaded from exchange config
  retryMaxDelayMs: 60000,           // Loaded from exchange config
  healthCheckIntervalMs: 10000,     // Loaded from exchange config
  healthCheckTimeoutMs: 30000,      // Loaded from exchange config
  
  // Optional - logging
  logger: (level, msg, data) => {...}
});
```

### Recommended Profiles

| Scenario | baseDelay | maxDelay | interval | timeout | Notes |
|----------|-----------|----------|----------|---------|-------|
| **Development** | 500ms | 10s | 5s | 15s | Fast feedback, short wait |
| **Production (Binance)** | 1s | 60s | 15s | 60s | Stable, generous |
| **Production (Kraken)** | 1s | 30s | 10s | 45s | Per-symbol penalty |
| **High-Frequency** | 100ms | 5s | 2s | 10s | Low latency priority |
| **Resilient/Slow Network** | 2s | 120s | 20s | 90s | Maximum patience |

---

## Applied Fixes & Corrections

### Fix 1: Non-Retryable Symbol Removal

**Initial Problem:** Non-retryable symbols were detected but never removed from the batch, resulting in endless exponential backoff.

**Root Cause:** The `_handleNonRetryableError()` method logged the error but didn't populate the `nonRetryableSymbols` Set.

**Fix Applied:**
1. Enhanced error pattern matching to recognize CCXT-specific exceptions
2. Implemented `_extractSymbolFromError()` to parse symbols from error messages
3. Updated `_handleNonRetryableError()` to add extracted symbols to the blacklist
4. Ensured subscription loop filters on every iteration

**Impact:** Invalid symbols no longer waste retries. Service continues with remaining valid symbols.

### Fix 2: CCXT Error Pattern Recognition

**Initial Problem:** Test showed 6 exponential backoffs on invalid symbol but 0 non-retryable detections.

**Root Cause:** Error patterns didn't match CCXT's actual exception format:
- CCXT throws: `BadSymbol: binance does not have market symbol FAKECOIN/USDT`
- Patterns matched: generic strings like "not found", "invalid"

**Solution Applied:**
1. Added direct error.name matching for "badSymbol" exception class
2. Added CCXT-specific message patterns: "does not have market", "unknown symbol"
3. Added case-insensitive matching
4. Added debug logging to show actual error details

**Live Test Results:** After fix, invalid symbol immediately detected and blacklisted, zero retries wasted.

### Fix 3: Test Structure Correction

**Initial Problem:** Test crashed trying to access `manager.batches[0].symbols`.

**Root Cause:** Misunderstood batches structure:
- Actual: `batches = [[sym1, sym2, ...], ...]` (array of arrays)
- Assumed: `batches = [{symbols: [...]}, ...]` (array of objects)

**Solution Applied:** Updated tests to:
1. Access `manager.batches[0]` directly (it IS the symbol array)
2. Check `manager.nonRetryableSymbols` Set for non-retryable status
3. Added proper metrics reporting

---

## State Management

### Per-Batch Resilience State

```javascript
// Retry counter for each batch
this.retryAttempts = new Map();  // Map<batchId, attemptCount>
// Example: { 'batch-0': 3, 'batch-1': 1 }

// Symbol blacklist (populates during runtime)
this.nonRetryableSymbols = new Set();
// Example: Set { 'FAKECOIN/USDT', 'DELISTED/USDT' }

// Health check state per batch
this.batchState = new Map();  // Map<batchId, {lastMessageAt, stale}>
// Example: {
//   'batch-0': { lastMessageAt: 1712868123456, stale: false },
//   'batch-1': { lastMessageAt: 1712868089012, stale: true }
// }

// Global health check timer
this.healthCheckInterval = 12345;  // timerId from setInterval()
```

### New Metrics

```javascript
this.stats = {
  // ... existing metrics ...
  totalUpdates: 45230,              // Tickers processed
  failedUpdates: 42,                // Batches that failed
  normalizationErrors: 0,           // Parsing errors
  batchesStarted: 29,               // Subscription loops created
  
  // Phase 5 metrics
  retries: 48,                      // Total retry attempts
  exponentialBackoffs: 12,          // Times backoff applied
  nonRetryableDetected: 2,          // Permanent failures found
  staleConnectionsDetected: 0,      // Stale connections found
};
```

### Cleanup on Stop

```javascript
async stop() {
  // ... existing cleanup ...
  
  // Phase 5: Clear resilience state
  if (this.healthCheckInterval) {
    clearInterval(this.healthCheckInterval);
  }
  
  this.retryAttempts.clear();
  this.nonRetryableSymbols.clear();
  this.batchState.clear();
  this.healthCheckTimers.clear();
  this.lastMessageTime.clear();
}
```

---

## Test Coverage

### Unit Tests: 34 Phase 5 Specific Tests

All tests in `tests/unit/phase5.test.js` use `jest.useFakeTimers()` for deterministic timing.

**Exponential Backoff (5 tests)**
- ✅ Formula verification: 2^0=1000, 2^1=2000, 2^2=4000, etc.
- ✅ Capping at maxDelay
- ✅ Reset to 0 on successful connection
- ✅ Metrics tracking (stats.retries, stats.exponentialBackoffs)
- ✅ Per-batch independence

**Non-Retryable Error Detection (10 tests)**
- ✅ Pattern matching: "badsymbol", "not found", "invalid", "delisted", "disabled"
- ✅ HTTP patterns: "404", "400", "bad request"
- ✅ Case-insensitive matching
- ✅ Network errors properly classified as retryable
- ✅ Symbol extraction from multiple formats
- ✅ Set updates and filtering

**Stale Connection Health Checks (12 tests)**
- ✅ Timer initialization and cleanup
- ✅ Timestamp updates on message arrival
- ✅ Stale detection when threshold exceeded
- ✅ No false positives (messages within threshold)
- ✅ Recovery flag reset when data resumes
- ✅ Global health check interval management
- ✅ Concurrent batch monitoring
- ✅ Configuration option validation

**Integration & Edge Cases (7 tests)**
- ✅ Metrics in status snapshot
- ✅ Non-retryable count in getStatus()
- ✅ State cleanup on stop()
- ✅ Exponential overflow handling
- ✅ Configuration merging (exchange defaults + overrides)

### Test Results

```
Test Suites: 5 passed, 5 total
Tests:       163 passed, 163 total
  ├─ Phase 5 specific: 34 tests
  ├─ ConnectionManager integration: 25 tests
  ├─ RedisService: 22 tests
  ├─ ExchangeFactory: 18 tests
  └─ Other modules: 64 tests
Time: ~2.8 seconds
```

### Live Integration Tests

**test-usecase-5-invalid-symbol.js** - Tests non-retryable detection with real Binance API
```
Result: ✅ FAKECOIN/USDT detected, 0 wasted retries, 30 updates from valid symbols
```

**test-usecase-6-resilience.js** - Tests exponential backoff and health checks
```
Result: ✅ Retries: 4, Exponential backoffs: 4, Stale detected: 1
```

---

## Observability & Metrics

### Logging Examples

**Exponential backoff in action:**
```
[ConnectionManager:WARN] ConnectionManager: Exponential backoff [batch-0] {
  "delayMs": 4000,
  "attempt": 3
}
```

**Non-retryable symbol detected:**
```
[ConnectionManager:WARN] ConnectionManager: Symbol marked non-retryable [batch-0] {
  "symbol": "FAKECOIN/USDT",
  "message": "binance does not have market symbol FAKECOIN/USDT"
}
```

**Stale connection identified:**
```
[ConnectionManager:WARN] ConnectionManager: Stale connection detected [batch-0] {
  "timeSinceLastMessage": "35.0s",
  "threshold": "30.0s"
}
```

**Health check recovery:**
```
[ConnectionManager:INFO] ConnectionManager: Connection recovered [batch-0]
```

**Resilience config loaded at startup:**
```
[ConnectionManager:INFO] ConnectionManager: Resilience config loaded {
  "exchange": "binance",
  "retryBaseDelayMs": 1000,
  "retryMaxDelayMs": 60000,
  "healthCheckIntervalMs": 15000,
  "healthCheckTimeoutMs": 60000
}
```

### Status Snapshot

```javascript
manager.getStatus() returns:

{
  isRunning: true,
  symbols: 1420,
  batches: 284,
  subscriptionTimers: 284,
  nonRetryableSymbols: 1,          // Phase 5
  
  stats: {
    totalUpdates: 45230,
    failedUpdates: 42,
    normalizationErrors: 0,
    batchesStarted: 284,
    
    retries: 48,                   // Phase 5
    exponentialBackoffs: 12,       // Phase 5
    nonRetryableDetected: 1,       // Phase 5 (e.g., FAKECOIN/USDT marked)
    staleConnectionsDetected: 0,   // Phase 5
  }
}
```

---

## Failure Scenarios

### Scenario 1: Transient Network Error

```
1. watchTickers() throws ECONNREFUSED
2. _isNonRetryableError() checks pattern matching → false (retryable)
3. _calculateExponentialBackoff() calculates delay: 1000ms (attempt 1)
4. Log warning with delayMs and attempt number
5. Sleep 1 second
6. Next iteration retries watchTickers()
7. Succeeds this time
8. Retry counter resets to 0

✓ System recovers automatically with minimal delay
```

### Scenario 2: Delisted Symbol in Batch

```
1. watchTickers(['BTC/USDT', 'ETH/USDT', 'FAKECOIN/USDT', 'SOL/USDT'])
2. CCXT throws: BadSymbol: binance does not have market symbol FAKECOIN/USDT
3. _isNonRetryableError() recognizes "badsymbol" pattern → true
4. _extractSymbolFromError() extracts "FAKECOIN/USDT"
5. _handleNonRetryableError() adds "FAKECOIN/USDT" to nonRetryableSymbols
6. No exponential backoff applied (continue to next iteration)
7. Next iteration filters symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']
8. watchTickers(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']) succeeds
9. All three valid symbols receive updates continuously

✓ Service continues without wasting retries on permanent failure
```

### Scenario 3: Stale Connection (Silent Hang)

```
t=0s:    Connection established, lastMessageAt = 0
t=1s:    Message received → lastMessageAt updated
t=2s:    Message received → lastMessageAt updated
t=3s:    [SILENCE - no message from watchTickers()]
t=4s:    [SILENCE - watchTickers() still running, no error]
t=5s:    [SILENCE - socket open but dead]
...
t=32s:   Health check runs
         timeSinceLastMessage = 32s - 2s = 30s >= threshold (30s) ✓ STALE!
         Log warning: "Stale connection detected"
         Increment stats.staleConnectionsDetected
         Call exchange.close() to force connection reset
         
t=33s:   Next watchTickers() call fails (connection closed)
         _isNonRetryableError() → false (it's a network error, retryable)
         _calculateExponentialBackoff() returns 1000ms
         
t=34s:   watchTickers() retried, exchange reconnects
         Data starts flowing again
         Health check detects recovery, logs "Connection recovered"

✓ Silent hang detected within 30 seconds, automatic recovery
```

---

## Performance Impact

### Memory Overhead

- **retryAttempts Map**: ~50 bytes per batch
- **nonRetryableSymbols Set**: ~100 bytes per symbol (set overhead)
- **batchState Map**: ~200 bytes per batch (includes lastMessageAt timestamp)
- **healthCheckInterval**: Single timer object (~1 KB)

**For 1420 symbols across 284 batches:**
- Batches: 284 × 200 bytes = ~57 KB
- Non-retryable symbols (worst case): 100 × 100 bytes = ~10 KB
- Total overhead: ~70 KB (negligible, <1% of typical heap)

### CPU Cost

- **Exponential backoff**: O(1) - single Math.pow(2, x) calculation
- **Non-retryable detection**: O(n) where n = pattern count (~10-15 patterns)
  - Run only on error path (rare)
  - String matching is cached by JS engine
- **Health check**: O(m) where m = active batches
  - Runs every 10-30 seconds, not on every message
  - Simple timestamp comparison
- **Symbol filtering**: O(k) where k = symbols in batch
  - Set lookup is O(1) per symbol
  - Run once per iteration (~1 per second per batch)

**Total**: Negligible impact, <1% additional CPU even with 1000+ batches

### Network Impact

- No additional network requests
- Health checks are local timers only
- Exponential backoff reduces network traffic by allowing exchanges to recover
- Non-retryable detection reduces wasted requests on invalid symbols

---

## Files Changed

| File | Changes | Impact |
|------|---------|--------|
| `src/core/connection.manager.js` | Added exponential backoff, non-retryable detection, health checks, exchange config loading | Core resilience implementation |
| `src/constants/exchanges.js` | NEW file with exchange-specific resilience tuning | Automatic config loading per exchange |
| `tests/unit/phase5.test.js` | 34 comprehensive resilience tests | Validation of all three mechanisms |
| `test-usecase-5-invalid-symbol.js` | Live CCXT test for non-retryable detection | Real-world verification |
| `test-usecase-6-resilience.js` | Live CCXT test for exponential backoff and health checks | Real-world verification |

**Total Lines Added:** ~450 (implementation) + ~500 (tests) = 950 lines

---

## Verification Checklist

**Exponential Backoff** ✅
- [x] Formula correctly implements 2^(attempt - 1)
- [x] Properly capped at maxDelay
- [x] Resets to 0 on successful connection
- [x] Metrics tracked (stats.retries, stats.exponentialBackoffs)
- [x] Per-batch independence verified

**Non-Retryable Detection** ✅
- [x] CCXT BadSymbol exception recognized
- [x] Patterns matched: "badsymbol", "does not have market", "invalid", etc.
- [x] Symbol extraction works for multiple message formats
- [x] Symbols added to nonRetryableSymbols Set
- [x] Subscription loop filters on every iteration
- [x] No exponential backoff wasted on permanent failures
- [x] Live test confirms: FAKECOIN/USDT removed, valid symbols continue

**Health Checks** ✅
- [x] Global timer runs every 10-30 seconds
- [x] Stale connection detected when threshold exceeded
- [x] exchange.close() called to force reconnection
- [x] Recovery detected when data resumes
- [x] No false alarms while data is flowing
- [x] Cleanup on stop() working correctly

**Exchange-Aware Config** ✅
- [x] Binance/Bybit get 60s timeouts
- [x] Kraken gets 30s timeouts
- [x] Config loaded automatically on initialization
- [x] Overrides respected (for testing)
- [x] Proper logging of loaded configuration

**Testing** ✅
- [x] All 163 unit tests passing
- [x] 34 Phase 5 specific tests
- [x] Live CCXT integration tests working
- [x] Invalid symbols properly detected and removed
- [x] Valid symbols continue receiving updates
- [x] Stale connection detected and recovered

**Integration** ✅
- [x] Metrics updated in getStatus()
- [x] State properly cleaned up on stop()
- [x] Configuration saved in memory and accessible
- [x] Logging provides clear visibility into behavior
- [x] No breaking changes to existing code

---

## Next Steps (Phase 6 & Beyond)

Phase 5 provides the foundation for:

1. **Phase 6: Market Discovery & Orchestration**
   - Periodic market list refresh (every 300s)
   - TickerWatcher orchestration layer
   - Symbol set updates on the fly

2. **Advanced Resilience**
   - Adaptive backoff based on error type
   - Circuit breaker pattern for overwhelmed exchanges
   - Rate limiting tuning per exchange

3. **Monitoring & Metrics**
   - Prometheus integration for metrics export
   - Grafana dashboards (active batches, error rates, latencies)
   - Alerting on stale connections

4. **Production Deployment**
   - Docker containerization
   - PM2/systemd process management
   - Multi-instance deployment with shared Redis

---

## Summary

**Phase 5 is complete and production-ready.**

All three resilience mechanisms work together seamlessly:
- ✅ **Exponential backoff** ensures graceful recovery from transient failures
- ✅ **Non-retryable detection** prevents wasted retries on permanent failures  
- ✅ **Health checks** catch silent hangs and force reconnection
- ✅ **Exchange-aware config** tunes behavior for each exchange's characteristics

The service now handles real-world failure scenarios: network timeouts, delisted symbols, exchange outages, and silent connection hangs. Invalid symbols are instantly blacklisted, valid symbols continue receiving updates, and the system recovers automatically.

**All tests passing. Ready for production deployment.**
