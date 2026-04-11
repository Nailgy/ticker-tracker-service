# Ticker Tracker Service

Real-time exchange ticker tracking service built with Node.js, CCXT Pro, and Redis persistence.

## 📋 Project Status

**Phase 1 (Current):** Foundation & Configuration
- ✅ Project structure
- ✅ CLI argument parsing (commander)
- ✅ Environment variable loading & validation
- ✅ Configuration validation & sanitization
- ⏳ Phase 2: Core modules (TickerWatcher, ConnectionManager, etc.)

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Redis (Docker or local)
- Git

### Installation

```bash
# Clone repository
git clone <repo-url>
cd ticker-tracker-service

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

### Run Tests (Phase 1)

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Watch mode for development
npm run test:watch

# Coverage report
npm run test:coverage
```

### Start Redis (for Phase 2+)

```bash
# Using Docker Compose
docker-compose up redis -d

# Or start local Redis
redis-server
```

### CLI Usage (Phase 2+)

```bash
# Track Binance spot market
npm run watch:binance-spot

# Track Bybit swap market with custom batch size
node src/index.js watch bybit --type swap --batch-size 200

# Track with specific symbol limit and debug logging
node src/index.js watch binance --type spot --limit 1000 --debug

# Track with no proxy
node src/index.js watch binance --type spot --no-proxy
```

## 📁 Project Structure

```
src/
├── config/
│   └── index.js              # CLI/env parser with validation
├── core/                      # (Phase 2+)
│   ├── TickerWatcher.js      # Orchestrator
│   ├── ConnectionManager.js  # Per-connection state
│   └── ...
├── services/                  # (Phase 3+)
│   ├── RedisService.js
│   ├── ProxyService.js
│   └── ...
├── utils/                     # (Phase 2+)
│   ├── logger.js
│   ├── TickerNormalizer.js
│   └── ...
├── adapters/                  # (Phase 3+)
│   └── BaseAdapter.js
└── index.js                   # CLI entry point

tests/
├── unit/
│   └── config.test.js         # Phase 1 config tests
├── integration/               # (Phase 3+)
└── acceptance/                # (Phase 4+)
```

## ⚙️ Configuration

### Environment Variables (`.env` or CLI flags)

**Core Exchange:**
- `MARKET_TYPE` / `--type` - Market type (spot or swap)
- `SYMBOL_LIMIT` / `--limit` - Maximum symbols to track
- `BATCH_SIZE` / `--batch-size` - Symbols per connection

**Redis:**
- `REDIS_URL` - Redis connection URL (default: `localhost:6379`)
- `REDIS_BATCHING` - Enable batched writes (default: true)
- `REDIS_FLUSH_MS` - Batch flush interval in ms (default: 1000)
- `REDIS_MAX_BATCH` - Max batch size before forced flush (default: 1000)
- `REDIS_ONLY_ON_CHANGE` - Skip unchanged updates (default: true)

**Proxy (Optional):**
- `NO_PROXY` - Disable all proxies
- `PROXY_PROVIDER` - Proxy provider name (e.g., oxylabs)
- `OXYLABS_USERNAME` / `OXYLABS_PASSWORD` - Provider credentials
- `LOCAL_IPS` - Comma-separated local IPs to bind

**Debug:**
- `DEBUG` / `--debug` - Enable verbose logging
- `MEMORY_LIMIT` - Memory usage alert threshold

See `.env.example` for all available options.

## 🧪 Testing

### Phase 1 Tests

Config parser validation:
```bash
npm run test:unit
```

### Phase 2+ Tests

Unit tests for all core modules with mocks:
```bash
npm run test:unit
```

Integration tests with MockExchange and mock Redis:
```bash
npm run test:integration
```

## 📊 Redis Schema (Phase 2+)

### Hash Storage
```bash
HGET ticker:binance:spot BTC/USDT    # Returns normalized ticker JSON
HGETALL ticker:binance:spot          # All symbols for exchange/type
```

### Pub/Sub Channels
```bash
SUBSCRIBE ticker:binance:spot:BTC/USDT    # Updates for specific symbol
SUBSCRIBE ticker:binance:spot:all         # All updates for exchange/type
```

### Example Normalized Ticker
```json
{
  "symbol": "BTC/USDT",
  "exchange": "binance",
  "marketType": "spot",
  "last": 68000.30,
  "bid": 67999.50,
  "ask": 68001.00,
  "timestamp": 1710000000000,
  "volume": 1234567.89
}
```

## 🔄 Architecture

### Module Responsibilities (Phase 2+)

- **TickerWatcher** - Top-level orchestrator, startup/shutdown, market discovery
- **ConnectionManager** - Per-connection state, subscription queue, reconnect
- **ExchangeFactory** - CCXT instance creation, market filtering
- **RedisService** - Hash writes, batching, pub/sub emission
- **ProxyService** - Proxy rotation, local IP binding
- **TickerNormalizer** - Schema normalization
- **RetryScheduler** - Exponential backoff logic

## 📝 Next Phases

- **Phase 2:** Core modules (TickerWatcher, ConnectionManager, ExchangeFactory)
- **Phase 3:** Redis & Proxy services
- **Phase 4:** Adapter system for exchange-specific logic
- **Phase 5:** Integration & acceptance tests
- **Phase 6:** Documentation & deployment

## 🐛 Troubleshooting

### Configuration validation failed
Ensure all CLI flags are correct. Run with `--help`:
```bash
node src/index.js watch --help
```

### Invalid Redis URL
Redis URL must be one of:
- `redis://localhost:6379`
- `rediss://secure:6379` (TLS)
- `localhost:6379` (shorthand)

### Invalid local IP
IPs must be valid IPv4 addresses:
- ✅ `192.168.1.1`
- ✅ `10.0.0.1`
- ❌ `256.1.1.1` (out of range)
- ❌ `::1` (IPv6 not supported)

## 📚 Dependencies

- **ccxt** - Exchange API abstraction
- **ioredis** - Redis client with connection pooling
- **commander** - CLI argument parsing
- **dotenv** - Environment variable loading
- **winston** - Structured logging
- **jest** - Testing framework

## 📄 License

MIT

---

**Current Phase:** Phase 1 ✅  
**Last Updated:** 2026-04-11  
**Next Review:** Phase 2 - Core Module Implementation
