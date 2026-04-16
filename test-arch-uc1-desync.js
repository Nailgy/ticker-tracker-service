const ConnectionManager = require('./src/core/connection.manager');

async function runDesyncTest() {
  console.log('--- UC1: Тест розсинхронізації (Strict Encapsulation) ---');
  
  // 1. Фейковий Redis (щоб не підключати реальну БД для тесту)
  const mockRedisService = {
    pipeline: () => ({ hset: () => ({ publish: () => ({}) }), exec: async () => [] })
  };

  // 2. Стейт нашої фейкової біржі
  let currentExchangeMarkets = [
    { symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' },
    { symbol: 'SOL/USDT' }, { symbol: 'ADA/USDT' }
  ];

  // 3. Створюємо мок-адаптер, який імітує CCXT
  const mockAdapterFactory = () => ({
    initialize: async () => {},
    loadMarkets: async () => currentExchangeMarkets, // Повертає поточний стейт
    subscribe: async function* (symbols) {
       // Імітація нескінченного вебсокет-стріму
       while(true) await new Promise(r => setTimeout(r, 10000));
    },
    close: async () => {},
    getExchangeId: () => 'binance',
    getMarketType: () => 'spot',
    getMetrics: () => ({})
  });

  // 4. Ініціалізуємо твій ConnectionManager
  const manager = new ConnectionManager({
    batchSize: 2,
    redisService: mockRedisService,
    adapterFactory: mockAdapterFactory, // Впроваджуємо нашу фейкову біржу!
    logger: (lvl, msg) => { 
      if(lvl === 'info' || lvl === 'warn') console.log(`[LOG] ${msg}`);
    }
  });

  try {
    await manager.initialize();
    await manager.startSubscriptions();

    // manager.batches - це твій публічний геттер, який повертає копію (безпечно)
    let activeInManager = manager.batches.flat();
    console.log(`\n📡 Початкові батчі:`, activeInManager);

    // 5. Симулюємо делістинг через 3 секунди
    setTimeout(async () => {
      console.log('\n💥 [БІРЖА] Binance видаляє SOL та ADA!');
      // Змінюємо відповідь нашого API
      currentExchangeMarkets = [
        { symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }
      ];

      console.log('🔄 [ОРКЕСТРАТОР] Викликає manager.refreshMarkets()...');
      
      // ВИКЛИКАЄМО ТВІЙ РЕАЛЬНИЙ МЕТОД:
      await manager.refreshMarkets();

      activeInManager = manager.batches.flat();
      console.log(`🧠 В пам'яті ConnectionManager залишилось:`, activeInManager);

      if (activeInManager.includes('SOL/USDT') || activeInManager.includes('ADA/USDT')) {
        console.log('❌ БАГ: Менеджер досі тримає видалені монети! State Desync.');
      } else {
        console.log('✅ УСПІХ: Оркестратор ідеально синхронізував стейт. Підписки оновлено!');
      }
      
      await manager.stop();
      process.exit(0);
    }, 3000);

  } catch (err) {
    console.error('Критична помилка тесту:', err);
  }
}

runDesyncTest();