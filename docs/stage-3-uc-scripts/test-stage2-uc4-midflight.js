const ConnectionManager = require('./src/core/connection.manager');

async function runMidFlightTest() {
  console.log('--- UC4: Смерть у повітрі (Mid-Flight Self-Healing) ---');

  const mockAdapterFactory = (config) => ({
    id: 'binance', marketType: 'spot',
    initialize: async () => {},
    loadMarkets: async () => [{symbol: 'BTC/USDT'}, {symbol: 'ETH/USDT'}, {symbol: 'DOOMED/USDT'}],
    
    subscribe: async function*(symbols) {
      let iteration = 0;
      while (true) {
        iteration++;
        await new Promise(r => setTimeout(r, 100));

        if (iteration === 3 && symbols.includes('DOOMED/USDT')) {
          console.log('\n💥 [ХАОС] Біржа делістить DOOMED/USDT прямо під час стріму!');
          const err = new Error('binance does not have market symbol DOOMED/USDT');
          err.name = 'BadSymbol'; 
          throw err;
        }

        for (const sym of symbols) {
          yield { symbol: sym, ticker: { last: 100 } };
        }
      }
    },
    hasCapability: () => true,
    close: async () => {}
  });

  const manager = new ConnectionManager({
    batchSize: 5,
    strategyMode: 'BATCH_WATCH_TICKERS',
    redisService: { isReady: () => true, pipeline: () => ({ hset: () => ({ publish: () => ({}) }), exec: async () => [] }) },
    adapterFactory: mockAdapterFactory,
    logger: (lvl, msg) => { 
      if(msg.includes('Marking symbol non-retryable')) console.log(`[ENGINE] ${msg}`); 
    }
  });

  await manager.initialize();
  await manager.startSubscriptions();

  setTimeout(async () => {
    // ВИПРАВЛЕННЯ: Додав .metrics
    const metrics = manager.getStatus().engine.metrics;
    
    console.log('\n📊 Перевірка статусу після аварії:', metrics);
    if (metrics.staleDetections === 0 && metrics.failedBatches === 0) {
      console.log('✅ УСПІХ: Двигун вижив після "смерті у повітрі". Батч не впав.');
    } else {
      console.log('❌ БАГ: Двигун не зміг відновитися після втрати монети.');
    }

    await manager.stop();
    process.exit(0);
  }, 1000);
}
runMidFlightTest();