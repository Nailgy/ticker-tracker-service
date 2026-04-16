const ConnectionManager = require('./src/core/connection.manager');

async function runPoisonTest() {
  console.log('--- UC3: Отруєна пігулка (Ізоляція помилок) ---');
  
  let savedTickers = 0;
  const mockRedisService = {
    pipeline: () => ({ hset: () => ({ publish: () => ({}) }), exec: async () => [] }),
    updateTicker: async () => { savedTickers++; } // Якщо використовується прямий запис
  };

  // Фейковий адаптер, який кидає помилку посеред стріму
  const mockAdapterFactory = () => ({
    initialize: async () => {},
    loadMarkets: async () => [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }],
    subscribe: async function* (symbols) {
      // 1. Спочатку віддаємо хороший тікер
      yield { symbol: 'BTC/USDT', ticker: { last: 70000, timestamp: Date.now() } };
      
      // 2. Кидаємо "отруту" (помилку парсингу або обрив)
      throw new Error('API Glitch: Malformed data received');
    },
    close: async () => {},
    getExchangeId: () => 'binance',
    getMarketType: () => 'spot',
    getMetrics: () => ({})
  });

  const manager = new ConnectionManager({
    batchSize: 2,
    redisService: mockRedisService,
    adapterFactory: mockAdapterFactory,
    retryBaseDelayMs: 500, // Швидкий ретрай для тесту
    logger: (lvl, msg, data) => {
      if (lvl === 'error' || lvl === 'warn') {
        console.log(`[${lvl.toUpperCase()}] ${msg}`, data ? data.error || data : '');
      }
    }
  });

  try {
    await manager.initialize();
    await manager.startSubscriptions();

    setTimeout(async () => {
      const stats = manager.getStatus().engine.metrics;
      console.log('\n📊 Статистика Engine:', stats);

      if (stats.totalErrors > 0 && stats.retryQueue > 0) {
        console.log('✅ УСПІХ: "Отруту" відловлено ізольовано! Помилка не поклала Node.js, Engine зробив бекофф.');
      } else {
        console.log('❌ БАГ: Двигун не зафіксував помилку або процес впав до цього етапу.');
      }
      
      await manager.stop();
      process.exit(0);
    }, 2000);

  } catch (err) {
    console.error('❌ КРИТИЧНЕ ПАДІННЯ:', err);
  }
}
runPoisonTest();