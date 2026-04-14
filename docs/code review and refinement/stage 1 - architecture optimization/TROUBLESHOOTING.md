# Troubleshooting Guide

**Status**: ✅ Phase 1 Complete  
**Last Updated**: 2026-04-14  

---

## Diagnosis Flow

```
Problem Observed
  ↓
Check Logs: npm start 2>&1 | grep -E "ERROR|WARN"
  ↓
Check Status: Get ConnectionManager.getStatus()
  ↓
Check Redis: redis-cli DBSIZE, redis-cli SUBSCRIBE ticker:*
  ↓
Identify Root Cause
  ↓
Apply Solution
```

---

## Error Matrix

| Error Message | Cause | Diagnosis | Solution |
|---|---|---|---|
| "Connection refused" on start | Redis not running | `redis-cli ping` fails | `docker-compose up redis` |
| "Symbol X not found" in logs | Exchange delisted symbol | Logs show markNonRetryable | Normal - symbol auto-excluded |
| "ECONNREFUSED" in adapter | Network/firewall issue | adapter.errorCount increasing | Check network, increase timeout |
| "Stale connection detected" | No data for 30s+ | Health check fires, batches idle | Adapter reconnecting (expected) |
| "High memory usage" | Large batch/slow flush | Monitor RedisWriter metrics | Reduce batchSize or increase flushInterval |
| "Zero updates" | Subscription not running | engine.totalTickers = 0 | Check logs for init errors |
| "Redis connection lost" | Redis crash/overflow | redis-cli ping fails | Restart Redis, check disk space |

---

## Common Issues & Solutions

### Issue 1: Markets load but no tickers arrive

**Symptoms**:
- logs show "Markets loaded: 1420 symbols"
- But redis-cli HGETALL ticker:binance:spot returns empty
- engine.totalTickers = 0

**Diagnosis Steps**:
1. Check subscription loops started: `engine.isRunning` should be true
2. Check adapter error count: `adapter.errorCount` should be 0
3. Check batch allocation: `batches.length` should > 0

**Common Causes** & **Solutions**:
- **Batch size too large**: If BATCH_SIZE >= available symbols, only 1 batch created, may cause issues. Solution: Reduce BATCH_SIZE to 50-100
- **Exchange doesn't support watchTickers**: Check adapter logs. Solution: May need custom adapter for per-symbol strategy
- **Subscription not started**: Check if initialize() completed. Solution: Check logs for init errors

---

### Issue 2: Redis fills with old/stale data

**Symptoms**:
- redis-cli DBSIZE shows 10,000+ keys
- Old ticker prices (from minutes ago)
- Writers seem slow

**Diagnosis**:
1. Check RedisWriter metrics: `writer.dedupedWrites` should be high
2. Check flush rate: `writer.flushedBatches` should increase every second
3. Check if readers are consuming: `redis-cli PUBSUB CHANNELS` should show subscribers

**Solutions**:
- **Increase flush frequency**: Set REDIS_FLUSH_INTERVAL_MS=500 (flush faster)
- **Increase batch size**: Set REDIS_MAX_BATCH=100 (allow larger batches before flush)
- **Deduplication not working**: Check if ticker data changing every update (should be deduplicated if unchanged)
- **Readers not consuming**: If pub/sub not read, data backs up. Add consumers on ticker:* channels

---

### Issue 3: Memory keeps growing

**Symptoms**:
- Process memory increasing over time
- Eventually crashes or becomes slow
- No obvious logs about errors

**Diagnosis**:
1. Check symbol count: `registry.activeCount` should be stable
2. Check batch queue: `writer.queuedUpdates` should be small
3. Check if non-retryable symbols accumulating: `registry.nonRetryableCount` growing

**Common Causes** & **Solutions**:
- **Symbol set never stabilizes**: New symbols added faster than removed. Solution: May need market filtering or caps
- **Batch queue backing up**: Redis becoming slow, writes accumulating. Solution: Check Redis performance, increase batch flush
- **Retry attempts accumulating**: Symbols retrying forever. Solution: Check if non-retryable symbols marked correctly

---

### Issue 4: Frequent stale connection detections

**Symptoms**:
- engine.staleDetections incrementing frequently (> once per minute)
- Logs show "Stale connection detected for batch-X"
- Connections reconnecting constantly

**Diagnosis**:
1. Check network latency: Network timeouts?
2. Check batch size: Large batches may take longer to generate tickers
3. Check health check timeout: Currently HEALTH_CHECK_TIMEOUT_MS

**Solutions**:
- **Increase timeout**: Set HEALTH_CHECK_TIMEOUT_MS=60000 (60s instead of 30s)
- **Reduce batch size**: Each batch takes time to produce tickers. Use BATCH_SIZE=20
- **Check network**: Packet loss, latency issues? Test with `ping exchange_api_host`
- **Check exchange**: May be slow or have rate limits

---

### Issue 5: "Symbol not found" errors after market refresh

**Symptoms**:
- Market refresh logs new symbols
- But "Symbol X not found" errors after
- Symbol marked non-retryable

**Diagnosis**:
1. Check if symbol really exists on exchange
2. Check if adapter strategies support the symbol format

**Solutions**:
- **Normal**: Some symbols may be invalid or delisted. They're auto-excluded.
- **Check format**: Symbol should be "BTC/USDT" (with slash), not "BTCUSDT"
- **Exchange changed**: Market refresh may detect symbols exchange removed

---

## Performance Tuning

### For 1,000-5,000 symbols
```bash
BATCH_SIZE=50               # 100-200 batches max
SUBSCRIPTION_INTERVAL_MS=100  # Stagger starts
HEALTH_CHECK_INTERVAL_MS=30000
REDIS_FLUSH_INTERVAL_MS=500
```

### For 10,000+ symbols
```bash
BATCH_SIZE=100              # 200-300 batches
SUBSCRIPTION_INTERVAL_MS=50   # Slow start
REDIS_MAX_BATCH=200         # Large batches
REDIS_FLUSH_INTERVAL_MS=1000  # Flush less often
```

### For low-latency (few symbols)
```bash
BATCH_SIZE=10               # Many small batches
SUBSCRIPTION_INTERVAL_MS=500  # Controlled start
REDIS_MAX_BATCH=1           # Write immediately
REDIS_FLUSH_INTERVAL_MS=10  # Flush very frequently
```

---

## Debug Mode

**Enable detailed logging**:
```bash
LOG_LEVEL=debug npm start
```

**Monitor specific component**:
```bash
npm start 2>&1 | grep "SubscriptionEngine"
npm start 2>&1 | grep "RedisWriter"
npm start 2>&1 | grep "MarketRegistry"
```

---

## Health Check Script

```bash
#!/bin/bash
# health-check.sh - Monitor service health

while true; do
  echo "=== $(date) ==="
  
  # Redis
  echo -n "Redis: "
  redis-cli ping 2>&1 | head -1
  
  # Database size
  echo -n "Redis DB size: "
  redis-cli DBSIZE 2>&1
  
  # Subscriber count
  echo -n "Active subscribers: "
  redis-cli PUBSUB CHANNELS ticker:* 2>&1 | wc -l
  
  # Sample ticker
  echo -n "Latest ticker: "
  redis-cli XREAD STREAMS ticker:binance:spot 0 COUNT 1 2>&1 | tail -1 | head -c 50
  
  echo
  sleep 60
done
```

---

## When to Escalate

Contact support/developers if:
1. Error persists after applying solutions above
2. Multiple batches failing (failedBatches > 5)
3. Adapter errors but market refresh finds symbols (race condition?)
4. Memory leak confirmed (growing without new symbols)

With:
- Last 50 lines of logs
- Output of `getStatus()`
- Redis state (`DBSIZE`, `INFO stats`)
- Configuration used
