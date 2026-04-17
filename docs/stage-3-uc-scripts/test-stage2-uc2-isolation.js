const ConnectionManager = require('./src/core/connection.manager');

async function runIsolationTest() {
  console.log('--- UC2: Перевірка ізоляції зєднань (Blast Radius) ---');

  let adapterInstancesCount = 0;
  const adapters = [];

  const mockAdapterFactory = (config) => {
    adapterInstancesCount++;
    const adapterId = `Adapter-${adapterInstancesCount}`;
    const adapter = {
      id: 'binance', marketType: 'spot', name: adapterId, isClosed: false,
      initialize: async () => {},
      loadMarkets: async () => [{symbol: 'A/USDT'}, {symbol: 'B/USDT'}, {symbol: 'C/USDT'}, {symbol: 'D/USDT'}],
      
      // Stage 2: Engine expects `subscribe` as an async generator!
      subscribe: async function*(symbols) {
        if (this.isClosed) throw new Error(`${this.name} is Closed!`);
        
        // ІМІТАЦІЯ ПАДІННЯ: Вбиваємо адаптер ТІЛЬКИ якщо він обслуговує батч з 'A/USDT'
        if (symbols.includes('A/USDT') && !this.crashed) {
          console.log(`💥 [ХАОС] Жорстко вбиваємо ${this.name} (Батч 1)...`);
          this.isClosed = true;
          this.crashed = true; // Щоб не спамити
          throw new Error('Fatal Socket Crash');
        }
        
        // Для інших батчів (з C/USDT) все працює добре
        while (!this.isClosed) {
          await new Promise(r => setTimeout(r, 200));
          yield { symbol: symbols[0], ticker: { last: 1 } };
        }
      },
      hasCapability: () => true,
      close: async function() { this.isClosed = true; },
      
      // Службові методи, які потрібні SubscriptionEngine
      getMetrics: () => ({}),
      getExchangeId: () => 'binance',
      getMarketType: () => 'spot'
    };
    adapters.push(adapter);
    return adapter;
  };

  const mockRedis = { isReady: () => true, pipeline: () => ({ hset: () => ({ publish: () => ({}) }), exec: async () => [] }) };

  const manager = new ConnectionManager({
    batchSize: 2, // 4 монети / 2 = 2 БАТЧІ
    strategyMode: 'BATCH_WATCH_TICKERS',
    redisService: mockRedis,
    adapterFactory: mockAdapterFactory,
    retryBaseDelayMs: 5000, // Довгий бекофф, щоб точно побачити, хто впав
    logger: () => {}
  });

  await manager.initialize();
  await manager.startSubscriptions();

  // Даємо системі час (1 секунду)
  setTimeout(async () => {
    console.log(`\n📡 Створено адаптерів: ${adapters.length}`);
    
    adapters.forEach(a => {
      console.log(`   ${a.name} закритий: ${a.isClosed}`);
    });

    const crashedAdapters = adapters.filter(a => a.isClosed);
    const survivingAdapters = adapters.filter(a => !a.isClosed && a.crashed === undefined);

    if (crashedAdapters.length >= 1 && survivingAdapters.length >= 1) {
      console.log('\n✅ УСПІХ: Батчі повністю ізольовані через AdapterPool!');
      console.log('Падіння одного з\'єднання (A/USDT) НЕ вплинуло на інші з\'єднання (C/USDT).');
    } else {
      console.log('\n❌ БАГ: Погана ізоляція або адаптер не впав.');
    }
    
    await manager.stop();
    process.exit(0);
  }, 1000);
}
runIsolationTest();