# Phase 4: ConnectionManager - WebSocket Subscription Coordination

**Status:** ✅ Complete & Tested  
**Tests:** 27 passing  
**Lines of Code:** 270 (implementation) + 400 (tests)  
**Last Updated:** 2026-04-11

---

## Overview

**ConnectionManager** is the core orchestrator for managing WebSocket subscriptions to cryptocurrency exchange ticker streams. It coordinates symbol batching, subscription lifecycle, real-time ticker updates, and graceful shutdown.

### Core Responsibility

Transform raw market data from CCXT Pro into normalized, deduplicated updates persisted to Redis, with proper error handling and connection management.

---

## Architecture

### High-Level Flow

```
1. Initialize
   ├─ Create CCXT exchange instance (via ExchangeFactory)
   ├─ Load available markets
   ├─ Filter by marketType and active status
   └─ Chunk symbols into configurable batches

2. Subscribe
   ├─ Start subscription loop for each batch
   ├─ Stagger batch startup (100ms between starts)
   └─ Poll exchange continuously via watchTickers()

3. Update
   ├─ For each ticker update:
   │  ├─ Normalize via ExchangeFactory
   │  ├─ Persist to Redis (batched)
   │  └─ Track metrics
   └─ Continuous polling while isRunning

4. Shutdown
   ├─ Set isRunning = false
   ├─ Clear subscription timers
   ├─ Flush Redis batch
   ├─ Close exchange connection
   └─ Report final metrics
```

### Component Interactions

```
ConnectionManager
├─ ExchangeFactory
│  ├─ loadMarkets() → array of symbols
│  ├─ createExchange() → CCXT instance
│  └─ normalizeTicker(symbol, raw) → normalized object
├─ RedisService
│  ├─ updateTicker(...) → queued for batch
│  └─ flush() → write to Redis
└─ Internal State
   ├─ symbols[] - All loaded symbols
   ├─ batches[][] - Chunked symbols
   ├─ subscriptionTimers[] - Active timers
   └─ stats{} - Metrics
```

---

## API Reference

### Constructor

```javascript
new ConnectionManager(config)
```

**Config Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| exchangeFactory | ExchangeFactory | ✅ | - | Exchange factory instance |
| redisService | RedisService | ✅ | - | Redis service instance |
| batchSize | number | ❌ | 100 | Symbols per batch |
| logger | Function | ❌ | no-op | Logger function(level, message, data) |

**Throws:**
- `Error: exchangeFactory is required`
- `Error: redisService is required`

**Example:**
```javascript
const manager = new ConnectionManager({
  exchangeFactory: factory,
  redisService: redis,
  batchSize: 100,
  logger: console.log
});
```

---

### Methods

#### `initialize()` → Promise<void>

Load markets and prepare batches for subscription.

**What it does:**
1. Creates CCXT exchange instance
2. Loads all available markets from exchange
3. Filters by marketType (spot/swap) and active status
4. Sorts symbols alphabetically
5. Chunks into batches based on batchSize
6. Logs market statistics

**Throws:** `Error` if exchange creation or market loading fails

**Example:**
```javascript
await manager.initialize();
// → Markets loaded: 1420 symbols
// → Batches created: 29 batches of 50 symbols
```

---

#### `startSubscriptions()` → Promise<void>

Start WebSocket subscription loops for all batches.

**What it does:**
1. Validates manager is initialized
2. Sets `isRunning = true`
3. Schedules subscription loop for each batch
4. Stagger batch starts by 100ms to avoid thundering herd
5. Returns immediately (loops run in background)

**Throws:** `Error: Not initialized` if initialize() not called

**Important:** This method returns immediately. Subscription loops run asynchronously in the background.

**Example:**
```javascript
await manager.startSubscriptions();
// → Subscription loop started [batch-0] with 50 symbols
// → Subscription loop started [batch-1] with 50 symbols
```

---

#### `stop()` → Promise<void>

Stop all subscription loops and cleanup resources.

**What it does:**
1. Sets `isRunning = false` (terminates all while loops)
2. Clears all subscription timers
3. Flushes pending Redis batch
4. Closes CCXT exchange connection
5. Logs final metrics

**Error Handling:** Gracefully handles errors (doesn't throw)

**Example:**
```javascript
await manager.stop();
// → ConnectionManager: Stopping subscriptions
// → ConnectionManager: Stopped with stats {...}
```

---

#### `getStatus()` → Object

Get current service status snapshot.

**Returns:**
```javascript
{
  isRunning: boolean,           // Are subscriptions active?
  symbols: number,              // Total symbols loaded
  batches: number,              // Total batch groups
  subscriptionTimers: number,   // Active timers
  stats: {
    totalUpdates: number,       // Tickers received
    failedUpdates: number,      // Errors from CCXT
    normalizationErrors: number,// Ticker normalization failures
    batchesStarted: number      // Batches that started
  }
}
```

**Example:**
```javascript
const status = manager.getStatus();
// {
//   isRunning: true,
//   symbols: 1420,
//   batches: 29,
//   subscriptionTimers: 29,
//   stats: {
//     totalUpdates: 45230,
//     failedUpdates: 2,
//     normalizationErrors: 0,
//     batchesStarted: 29
//   }
// }
```

---

## Implementation Details

### Subscription Loop (`_subscriptionLoop`)

Runs asynchronously for each batch. Core logic:

```javascript
while (this.isRunning) {
  try {
    const tickers = await this.exchange.watchTickers(symbols);
    
    for (const [symbol, rawTicker] of Object.entries(tickers)) {
      // 1. Normalize
      const normalized = exchangeFactory.normalizeTicker(symbol, rawTicker);
      
      // 2. Persist to Redis (batched)
      await redisService.updateTicker(exchange, marketType, symbol, normalized);
      
      // 3. Track metric
      stats.totalUpdates++;
    }
  } catch (error) {
    stats.failedUpdates++;
    await sleep(1000);  // Retry after 1 second
  }
}
```

**Key Points:**
- **Continuous polling**: `watchTickers()` is called repeatedly in a loop
- **Not async generator**: Early versions used `for await`, but CCXT's watchTickers returns data on each call, not a generator
- **Batch staggering**: 100ms delay between batch starts prevents connection thundering
- **Error recovery**: 1-second delay on error before retry
- **Fire-and-forget**: Loops run as background async tasks; method returns immediately

### Normalization

Each ticker is normalized via ExchangeFactory:

```javascript
// Raw ticker from Binance mini stream
{ symbol: "BTC/USDT", last: 45000, ... }

// Normalized output
{
  symbol: "BTC/USDT",
  exchange: "binance",
  marketType: "spot",
  last: 45000,
  bid: null,          // Mini stream has no bid/ask
  ask: null,
  baseVolume: null,
  quoteVolume: null,
  timestamp: 1702131600000
}
```

**Schema** (consistent across all exchanges):
- `symbol` - Trading pair (e.g., "BTC/USDT")
- `exchange` - Exchange name (e.g., "binance")
- `marketType` - Market type (e.g., "spot")
- `last` - Last trade price (or null)
- `bid` - Best bid price (or null)
- `ask` - Best ask price (or null)
- `baseVolume` - Volume in base asset (or null)
- `quoteVolume` - Volume in quote asset (or null)
- `timestamp` - Unix timestamp in milliseconds

### Redis Persistence

All updates are batched for efficiency:

```javascript
// Inside ConnectionManager._subscriptionLoop()
await redisService.updateTicker(exchange, marketType, symbol, normalized);

// Inside RedisService (handled automatically)
// 1. Check deduplication cache (MD5 hash)
// 2. If changed: Add to batch array
// 3. When batch full OR timeout: Flush to Redis via pipeline
```

**Redis Keys:**
- **Hash key:** `ticker:<exchange>:<marketType>`
- **Pub/sub:** `ticker:<exchange>:<marketType>:<symbol>`

---

## Batching Strategy

### Problem
Can't subscribe to 1000+ symbols on single connection (rate limiting).

### Solution
Chunk symbols into configurable batches:

**Example with 1420 Binance symbols, batchSize=50:**
```
Batch 0: [BTC/USDT, ETH/USDT, ..., GLMR/USDT]    (50 symbols)
Batch 1: [GLYPH/USDT, GME/USDT, ..., GNS/USDT]   (50 symbols)
...
Batch 29: [ZZZ/USDT]                              (20 symbols)
```

**Staggered Startup:**
```
t=0ms:   Start batch 0 subscription loop
t=100ms: Start batch 1 subscription loop
t=200ms: Start batch 2 subscription loop
...
```

This prevents:
- ✅ Connection thundering
- ✅ Rate limit breaches
- ✅ Memory spikes

---

## Test Coverage

**27 unit tests** covering:

### Constructor & Config (4 tests)
- ✅ Validates required parameters
- ✅ Uses default batchSize
- ✅ Throws on missing exchangeFactory/redisService

### Market Loading & Initialization (4 tests)
- ✅ Loads markets from exchange
- ✅ Creates batches correctly
- ✅ Handles single batch (symbols < batchSize)
- ✅ Throws on exchange creation failure

### Batching Logic (2 tests)
- ✅ Splits symbols into correct batch count
- ✅ Handles empty symbol list

### Subscription Lifecycle (4 tests)
- ✅ Sets isRunning to true
- ✅ Schedules timers (one per batch)
- ✅ Prevents duplicate starts
- ✅ Throws if not initialized

### Shutdown & Cleanup (6 tests)
- ✅ Sets isRunning to false
- ✅ Clears all timers
- ✅ Flushes Redis batch
- ✅ Closes exchange connection
- ✅ Handles Redis flush errors gracefully
- ✅ Handles exchange close errors gracefully

### Status & Metrics (2 tests)
- ✅ Returns status snapshot
- ✅ Includes all stat fields

### Integration (5 tests)
- ✅ Ticker normalization integration
- ✅ Error handling and logging
- ✅ Full lifecycle: construct → init → start → stop
- ✅ Multiple stops without errors
- ✅ Stats tracking for failures

**Test Strategy:** All tests use mocked CCXT and Redis. Tests validate interface contracts without executing infinite async loops (prevents memory exhaustion).

---

## Error Handling

### Initialization Errors
```javascript
try {
  await manager.initialize();
} catch (error) {
  // Exchange creation failed, market loading failed, etc.
  console.error('Failed to initialize:', error.message);
}
```

### Watchlist Errors (in subscription loop)
```javascript
while (this.isRunning) {
  try {
    const tickers = await this.exchange.watchTickers(symbols);
    // ... process tickers
  } catch (error) {
    this.stats.failedUpdates++;
    // Log error, wait 1 second, retry
    await this._sleep(1000);
  }
}
```

### Graceful Shutdown Errors
```javascript
await manager.stop();
// Handles errors from Redis flush and exchange close
// Doesn't throw, ensures cleanup completes
```

---

## Performance Characteristics

### Memory Usage
- **Symbols:** 1 KB per symbol (roughly)
- **Batches:** Minimal overhead
- **Subscription timers:** ~50 bytes per batch
- **Total for 1420 symbols:** ~2-3 MB

### CPU Usage
- **Minimal during updates:** JSON normalization is lightweight
- **Deduplication:** MD5 hash computation (negligible)
- **Batching:** Array operations only

### Network
- **Connections:** 1 WebSocket per batch (29 for 1420 symbols with batch size 50)
- **Update rate:** Varies by exchange (100-300 updates/second typical)
- **Redis writes:** Batched, ~10-20 writes/second typical

### Latency
- **Ticker update to Redis:** <100ms (mostly async I/O)
- **Subscription startup:** ~3 seconds (batches staggered by 100ms)

---

## Configuration

### Via Constructor
```javascript
const manager = new ConnectionManager({
  exchangeFactory: factory,
  redisService: redis,
  batchSize: 100,        // Adjust for rate limiting
  logger: myLogger       // Custom logging
});
```

### Via Environment (indirect)
```bash
# .env
BATCH_SIZE=100          # --batch-size CLI option
```

### Typical Configurations

| Scenario | batchSize | Batches | Rationale |
|----------|-----------|---------|-----------|
| Small exchange (100-500 symbols) | 100 | 1-5 | Single connection OK |
| Medium (500-2000 symbols) | 100 | 5-20 | Standard configuration |
| Large (2000+ symbols) | 50 | 40+ | Many connections, controlled |
| Rate limit testing | 25 | Many | Conservative, minimal load |

---

## Known Limitations (Phase 4)

1. **No advanced retry logic** - Uses simple 1-second delay on error
   - Will be improved in Phase 5 with exponential backoff

2. **No market discovery** - Symbols loaded at init, not updated if markets change
   - Will be added in Phase 5

3. **No health monitoring** - No metrics on connection quality
   - Will be added in Phase 5

4. **No proxy rotation** - ProxyService available but not integrated
   - Will be integrated in Phase 5

5. **No rate limiting awareness** - Doesn't detect or respond to rate limit headers
   - May be added in Phase 5

---

## Integration Example

### Full Lifecycle

```javascript
const ExchangeFactory = require('./src/services/exchange.factory');
const RedisService = require('./src/services/redis.service');
const ConnectionManager = require('./src/core/connection.manager');

async function main() {
  // Setup
  const factory = new ExchangeFactory({
    exchange: 'binance',
    marketType: 'spot'
  });

  const redis = new RedisService({
    redisUrl: 'localhost:6379',
    redisBatching: true
  });

  const manager = new ConnectionManager({
    exchangeFactory: factory,
    redisService: redis,
    batchSize: 100
  });

  try {
    // Connect & Initialize
    await redis.connect();
    await manager.initialize();

    // Subscribe
    await manager.startSubscriptions();
    console.log('Subscriptions started');

    // Monitor
    setInterval(() => {
      const status = manager.getStatus();
      console.log(`Updates: ${status.stats.totalUpdates}, Errors: ${status.stats.failedUpdates}`);
    }, 5000);

    // Handle shutdown
    process.on('SIGINT', async () => {
      await manager.stop();
      await redis.disconnect();
      process.exit(0);
    });
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
```

---

## Next Steps (Phase 5)

Phase 5 will add:
1. **RetryScheduler** - Exponential backoff retry logic
2. **MarketCache** - Periodic market discovery for new/delisted symbols
3. **TickerWatcher** - Top-level orchestrator
4. **Non-retryable detection** - Skip permanently failed symbols
5. **Health monitoring** - Detailed service health metrics

---

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/core/connection.manager.js` | 270 | Main implementation |
| `tests/unit/connection.manager.test.js` | 400 | Unit tests (27 tests) |

---

**Status:** ✅ Phase 4 Complete - Ready for Phase 5
