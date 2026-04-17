const ConnectionManager = require('./src/core/connection.manager');

async function runAccordionTest() {
  console.log('--- UC5: Ефект Гармошки (Memory Leak Check) ---');

  let createdAdapters = 0;
  let closedAdapters = 0;

  // Динамічний стейт біржі
  let currentMarkets = Array.from({length: 10}, (_, i) => ({symbol: `COIN${i}/USDT`}));

  const mockAdapterFactory = () => {
    createdAdapters++;
    return {
      id: 'binance', marketType: 'spot',
      initialize: async () => {},
      loadMarkets: async () => currentMarkets,
      subscribe: async function*(symbols) {
        while(true) { await new Promise(r => setTimeout(r, 1000)); yield {symbol: symbols[0], ticker: {}}; }
      },
      hasCapability: () => true,
      close: async () => { closedAdapters++; } // Рахуємо скільки адаптерів було знищено
    };
  };

  const manager = new ConnectionManager({
    batchSize: 2, // 10 монет = 5 батчів
    strategyMode: 'BATCH_WATCH_TICKERS',
    redisService: { isReady: () => true },
    adapterFactory: mockAdapterFactory,
    logger: () => {}
  });

  console.log('1. Ініціалізація (10 монет -> 5 батчів)');
  await manager.initialize();
  await manager.startSubscriptions();
  
  // Даємо піднятися підписках
  await new Promise(r => setTimeout(r, 200));

  console.log('2. Ринок падає (2 монети -> 1 батч)');
  currentMarkets = [{symbol: 'COIN1/USDT'}, {symbol: 'COIN2/USDT'}];
  await manager.refreshMarkets();
  
  // Знову чекаємо
  await new Promise(r => setTimeout(r, 200));

  console.log('3. Ринок росте (8 монет -> 4 батчі)');
  currentMarkets = Array.from({length: 8}, (_, i) => ({symbol: `COIN${i}/USDT`}));
  await manager.refreshMarkets();

  await new Promise(r => setTimeout(r, 200));

  console.log('\n📊 Метрики використання пам\'яті (AdapterPool):');
  console.log(`   Створено інстансів CCXT: ${createdAdapters}`);
  console.log(`   Знищено інстансів CCXT (close): ${closedAdapters}`);
  
  // Математика витоку пам'яті:
  // Якщо ми створили N адаптерів, а зараз активних 4 батчі, то закритих має бути N - 4 (плюс-мінус 1 на REST адаптер)
  const activeExpected = 4;
  const unaccounted = createdAdapters - closedAdapters - activeExpected;

  // Даємо запас в 1-2 адаптери для loadMarkets або технічних потреб
  if (unaccounted <= 2) {
    console.log(`✅ УСПІХ: Витоку пам'яті немає. Неактивні адаптери коректно знищуються і видаляються з пулу.`);
  } else {
    console.log(`❌ БАГ (Memory Leak): В пам'яті "зависло" ${unaccounted} неактивних адаптерів, які не були закриті/видалені!`);
  }

  await manager.stop();
  process.exit(0);
}
runAccordionTest();