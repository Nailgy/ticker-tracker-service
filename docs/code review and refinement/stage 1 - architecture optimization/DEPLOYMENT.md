# Deployment Guide

**Status**: ✅ Phase 1 Ready  
**Last Updated**: 2026-04-14  

---

## Quick Start (Docker Compose)

```bash
# 1. Clone and setup
git clone <repo> && cd ticker-tracker-service
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your exchange, market type, batch size

# 3. Start Redis (Docker required)
docker-compose up -d redis

# 4. Start service
npm start

# 5. Verify
redis-cli HGETALL ticker:binance:spot
redis-cli SUBSCRIBE ticker:binance:spot:BTC/USDT
```

---

## Environment Configuration

| Variable | Default | Purpose | Production Recommendation |
|----------|---------|---------|---|
| EXCHANGE | binance | Exchange to track | binance or bybit |
| MARKET_TYPE | spot | Market type | spot or swap |
| BATCH_SIZE | 10 | Symbols per batch | 50-100 (fewer batches = fewer connections) |
| SUBSCRIPTION_INTERVAL_MS | 100 | Delay between batch starts (ms) | 500 (avoid thundering herd) |
| HEALTH_CHECK_INTERVAL_MS | 15000 | Health check interval (ms) | 30000 |
| HEALTH_CHECK_TIMEOUT_MS | 30000 | Stale connection timeout (ms) | 60000 |
| MARKET_REFRESH_INTERVAL_MS | 300000 | Market refresh interval (ms) | 3600000 (1 hour) |
| REDIS_HOST | localhost | Redis hostname | your-redis-cluster-ip |
| REDIS_PORT | 6379 | Redis port | 6379 |
| REDIS_BATCHING | true | Enable write batching | true (reduces writes) |
| REDIS_MAX_BATCH | 5 | Max batch size before flush | 100 |
| REDIS_FLUSH_INTERVAL_MS | 100 | Batch flush interval (ms) | 1000 |
| REDIS_MIN_INTERVAL_MS | 1000 | Min time between writes per symbol (ms) | 5000 (dedup rate limit) |
| RETRY_BASE_DELAY_MS | 1000 | Initial retry delay (ms) | 2000 |
| RETRY_MAX_DELAY_MS | 30000 | Max retry delay (ms) | 60000 |
| MAX_RETRIES | 3 | Max retry attempts per symbol | 5 |
| LOG_LEVEL | info | Logging level | warn (production) |

---

## Port Management

- **Redis**: 6379 (default) - configure via REDIS_HOST:REDIS_PORT
- **Application**: No listening ports (push model to Redis)

---

## Health Checks

**Direct Redis**:
```bash
redis-cli ping                                    # Should return: PONG
redis-cli INFO stats                             # Current stats
redis-cli PUBSUB CHANNELS ticker:*               # Active channels
redis-cli LLEN ticker:binance:spot               # Approx queue size
```

**Application Status** (via logs):
```
[ConnectionManager:INFO] Initialized { symbols: 1420, batches: 143 }
[SubscriptionEngine:INFO] Subscriptions started { batches: 143, connections: 143 }
[SubscriptionEngine:INFO] Health check { stale: 0, active: 143 }
```

**Monitoring Queries**:
```bash
# Watch real-time updates
redis-cli SUBSCRIBE 'ticker:binance:spot:*' | head -20

# Count updates per minute
while true; do redis-cli DBSIZE; sleep 60; done

# Check batch process
ps aux | grep node
```

---

## Logging

**Output**: Structured logs to stdout  
**Format**: `[Component:LEVEL] Message {context}`  
**Levels**: DEBUG, INFO, WARN, ERROR

**Aggregation** (for production):
```bash
# Pipe to ELK, Splunk, CloudWatch, etc.
npm start 2>&1 | logstash-agent
```

**Filtering errors**:
```bash
npm start 2>&1 | grep -E "ERROR|WARN|stale"
```

---

## Monitoring Key Metrics

Via `ConnectionManager.getStatus()`:

```javascript
{
  isRunning: true,                           // Is service active
  symbolCount: 1420,                         // Symbols being tracked
  batches: 143,                              // Number of subscription batches
  
  // Per-component metrics
  adapter: {
    subscriptionStatus: "initialized",       // "initialized" or "closed"
    totalYields: 451203,                    // Tickers received
    errorCount: 3                           // Errors encountered
  },
  
  registry: {
    desiredCount: 1420,                     // Available symbols
    activeCount: 1410,                      // Actively tracked
    nonRetryableCount: 10                   // Failed/delisted
  },
  
  engine: {
    isRunning: true,
    activeConnections: 143,                 // Active subscription loops
    failedBatches: 0,                       // Failed batches (alert if > 0)
    staleDetections: 0,                     // Stale connections detected
    totalTickers: 1255430                   // Total tickers processed
  },
  
  writer: {
    totalWrites: 1000000,                   // Redis writes sent
    dedupedWrites: 800000,                  // Skipped (deduplicated)
    failedWrites: 50,                       // Failed writes (minor)
    flushedBatches: 12505                   // Batch flushes to Redis
  }
}
```

**Alerting Thresholds**:
- `failedBatches > 0`: Check exchange/network
- `staleDetections > 5 in 5min`: Network issues or adapter problem
- `totalTickers drop 50%`: Exchange may be down
- `nonRetryableCount growing`: Many delisted symbols (normal over time)

---

## Graceful Shutdown

**Manual**:
```bash
# Method 1: Ctrl+C in terminal
Ctrl+C

# Method 2: Send signal to process
kill -TERM <pid>

# Method 3: Docker
docker stop <container>
```

**Sequence**:
1. SIGTERM received
2. Stop accepting new tickers
3. Flush pending Redis batch
4. Close all adapters (WebSockets)
5. Disconnect Redis
6. Exit with code 0

**Timing**: Usually completes in <5 seconds

---

## Docker Compose Template

```yaml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

  ticker-tracker:
    build: ./ticker-tracker-service
    depends_on:
      - redis
    environment:
      EXCHANGE: binance
      MARKET_TYPE: spot
      BATCH_SIZE: 50
      REDIS_HOST: redis
      LOG_LEVEL: info
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  redis_data:
```

---

## Kubernetes Template

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ticker-tracker-config
data:
  EXCHANGE: "binance"
  MARKET_TYPE: "spot"
  BATCH_SIZE: "50"
  REDIS_HOST: "redis-service"

---

apiVersion: apps/v1
kind: Deployment
metadata:
  name: ticker-tracker
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ticker-tracker
  template:
    metadata:
      labels:
        app: ticker-tracker
    spec:
      containers:
      - name: ticker-tracker
        image: ticker-tracker:latest
        envFrom:
        - configMapRef:
            name: ticker-tracker-config
        resources:
          requests:
            memory: "256Mi"
            cpu: "500m"
          limits:
            memory: "512Mi"
            cpu: "1000m"
        livenessProbe:
          exec:
            command:
            - sh
            - -c
            - "redis-cli -h redis-service ping"
          initialDelaySeconds: 30
          periodSeconds: 30
```

---

## Performance Tuning

**High Volume Setup** (10,000+ symbols):
```bash
BATCH_SIZE=100            # Reduce batches
SUBSCRIPTION_INTERVAL_MS=50  # Stagger starts
REDIS_MAX_BATCH=200       # Larger batches
REDIS_FLUSH_INTERVAL_MS=500  # Flush less often
HEALTH_CHECK_INTERVAL_MS=60000  # Less frequent checks
```

**Low Latency Setup** (critical data):
```bash
BATCH_SIZE=10             # More batches (more WebSockets)
SUBSCRIPTION_INTERVAL_MS=500  # Slower starts (avoid thundering herd)
REDIS_MAX_BATCH=1         # Write immediately
REDIS_FLUSH_INTERVAL_MS=10   # Flush frequently
REDIS_MIN_INTERVAL_MS=100    # Allow more writes per symbol
```

---

## Troubleshooting Deployment

| Issue | Check | Solution |
|-------|-------|----------|
| "Connection refused" | redis-cli ping | Start Redis, check REDIS_HOST |
| High memory | redis memory usage | Reduce batch size, increase flush interval |
| Slow updates | totalTickers in metrics | Check batch size, health checks |
| Redis fills with old data | Write rate vs flush rate | Increase flush frequency or batch size |
| Frequent stale detections | Network/firewall issues | Increase HEALTH_CHECK_TIMEOUT_MS |

---

## Monitoring Tools Integration

**Prometheus**:
```javascript
// Export metrics endpoint
app.get('/metrics', (req, res) => {
  const status = watcher.getStatus();
  res.send(`
ticker_tracker_symbols{exchange="binance"} ${status.symbolCount}
ticker_tracker_failed_batches{exchange="binance"} ${status.engine.failedBatches}
ticker_tracker_total_tickers{exchange="binance"} ${status.engine.totalTickers}
  `);
});
```

**Grafana**: Query Prometheus and visualize metrics

**Datadog/New Relic**: Forward logs and use built-in monitoring

---

## Security Considerations

- **Redis**: Use password authentication (REDIS_PASSWORD env var)
- **Network**: Run behind VPN or in private network
- **CCXT API Keys**: Not used in this v1 (data-only)
- **Logging**: Ensure logs don't expose sensitive data
- **Signal Handling**: Process handles SIGTERM gracefully

---

**Phase 1 Status**: ✅ Ready for production deployment with proper monitoring
