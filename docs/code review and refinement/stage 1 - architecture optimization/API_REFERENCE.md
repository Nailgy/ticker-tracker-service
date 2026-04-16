# Stage 1: Public API Reference

**Complete reference for all public modules**

---

## ExchangeAdapter

```javascript
async initialize()          // Select strategy, init CCXT
async loadMarkets()         // Filter by marketType, return symbols
async *subscribe(symbols)   // Yield {symbol, ticker} objects
async close()               // Cleanup CCXT connection
getMetrics()                // Return subscription tracking data
```

---

## MarketRegistry

```javascript
async loadDesiredMarkets(adapter)       // Load all symbols
addSymbols(symbols)                     // Add new symbols
removeSymbols(symbols)                  // Remove symbols
markNonRetryable(symbols)               // Mark as non-retryable
allocateToBatches(batchIds)             // Round-robin allocation
getDiffSince(previousState)             // Add/remove diff
getDesiredSymbols()                     // Return desired set
getActiveSymbols()                      // Return active set
getNonRetryableSymbols()                // Return non-retryable set
getMetrics()                            // Return tracking stats
```

---

## SubscriptionEngine

```javascript
async startSubscriptions(batches)       // Start all loops
async stopSubscriptions()               // Stop all subscriptions
getStatus()                             // Return metrics

// Callbacks
onTicker(exchange, marketType, symbol, ticker)
onError(exchange, marketType, error)
onHealthCheck(batchId, stale, recovered)
```

---

## RedisWriter

```javascript
async writeTicker(exchange, marketType, symbol, ticker)  // Write ticker
async flush()                                             // Flush batch
async disconnect()                                        // Cleanup
getMetrics()                                              // Return stats
```

---

## ConnectionManager

```javascript
async initialize()          // Wire all components
async startSubscriptions()   // Start subscriptions
async refreshMarkets()       // Reload markets
async stop()                 // Shutdown all
getStatus()                  // Return metrics
```

---

## TickerWatcher

```javascript
async start()               // Start all services
async stop()                // Shutdown all
getStatus()                 // Return metrics
```

---

## Key Behaviors

✅ All getters return fresh copies (not references)  
✅ All errors properly isolated (no cascade)  
✅ All modules provide metrics/observability  
✅ Dependency injection throughout  
✅ Zero private method calls across boundaries  

See PHASE_1_VERIFICATION.md for acceptance criteria proof.
