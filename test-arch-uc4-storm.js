const ConnectionManager = require('./src/core/connection.manager');

async function runStormTest() {
  console.log('--- UC4: Шторм Реконектів (Перевірка Jitter) ---');
  
  const mockRedisService = { pipeline: () => ({ hset: () => ({ publish: () => ({}) }), exec: async () => [] }) };

  const mockAdapterFactory = () => ({
    initialize: async () => {},
    // Завантажуємо 10 монет
    loadMarkets: async () => Array.from({length: 10}, (_, i) => ({ symbol: `COIN${i}/USDT` })),
    // ІМІТАЦІЯ ПАДІННЯ МЕРЕЖІ: Одразу кидаємо помилку підключення
    subscribe: async function* (symbols) {
      throw new Error('ECONNRESET: Network Drop');
    },
    close: async () => {}, getExchangeId: () => 'binance', getMarketType: () => 'spot', getMetrics: () => ({})
  });

  const backoffDelays = [];
  
  const manager = new ConnectionManager({
    batchSize: 2, // 10 монет / 2 = 5 батчів
    retryBaseDelayMs: 1000,
    redisService: mockRedisService,
    adapterFactory: mockAdapterFactory,
    logger: (lvl, msg, data) => {
      // Збираємо час затримки з логів бекоффу
      if (msg.includes('Exponential backoff') && data && data.delayMs) {
        backoffDelays.push(data.delayMs);
      }
    }
  });

  await manager.initialize();
  await manager.startSubscriptions();

  setTimeout(async () => {
    console.log('\n⏱️ Затримки бекоффу для 5 батчів (спроба 1):', backoffDelays.slice(0, 5));

    const uniqueDelays = new Set(backoffDelays.slice(0, 5));
    
    if (uniqueDelays.size === 1) {
      console.log('❌ БАГ: Усі батчі чекають однаково! Це Thundering Herd (DDoS біржі). Додайте Math.random() до RetryScheduler!');
    } else if (uniqueDelays.size > 1) {
      console.log('✅ УСПІХ: Затримки рандомізовані (Jitter працює). Реконекти розмазані в часі.');
    } else {
      console.log('⚠️ Бекоффи не зафіксовано.');
    }
    
    await manager.stop();
    process.exit(0);
  }, 2000);
}
runStormTest();