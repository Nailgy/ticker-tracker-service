const ConnectionManager = require('./src/core/connection.manager');

async function runLifecycleTest() {
  console.log('--- UC3: Безпека Життєвого Циклу (refreshMarkets) ---');

  let loadMarketsCalls = 0;
  const mockAdapterFactory = (config) => ({
    id: 'binance', marketType: 'spot',
    initialize: async () => {},
    loadMarkets: async () => {
      loadMarketsCalls++;
      if (loadMarketsCalls > 1) return [{symbol: 'BTC/USDT'}, {symbol: 'ETH/USDT'}, {symbol: 'NEW_COIN/USDT'}];
      return [{symbol: 'BTC/USDT'}, {symbol: 'ETH/USDT'}];
    },
    hasCapability: () => true,
    close: async () => {}
  });

  const manager = new ConnectionManager({
    batchSize: 10,
    redisService: { isReady: () => true },
    adapterFactory: mockAdapterFactory,
    logger: () => {}
  });

  await manager.initialize();
  
  // УВАГА: МИ НЕ РОБИМО manager.startSubscriptions()
  console.log('1. Менеджер ініціалізовано, але НЕ запущено. isRunning =', manager.isRunning);
  
  console.log('2. Викликаємо refreshMarkets()... Біржа поверне нову монету.');
  await manager.refreshMarkets();

  console.log('3. Перевіряємо статус після оновлення ринків:');
  console.log('   isRunning =', manager.isRunning);
  
  const stats = manager.getStatus();
  
  if (manager.isRunning === false && stats.engine.isRunning === false) {
    console.log('✅ УСПІХ: Стейт збережено. Оркестратор сам вирішить, коли запускати підписки.');
  } else {
    console.log('❌ БАГ: Менеджер самовільно запустив підписки (isRunning = true)! Це порушення життєвого циклу.');
  }

  process.exit(0);
}
runLifecycleTest();