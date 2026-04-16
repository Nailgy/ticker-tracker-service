const RedisWriter = require('./src/services/redis.writer'); 

async function runBackpressureTest() {
  console.log('--- UC2: Redis Backpressure (Імітація завислої БД) ---');
  
  // ОНОВЛЕНИЙ МОК: Додано isReady: () => true, бо ваш Writer грамотно перевіряє з'єднання!
  const mockRedisService = {
    isReady: () => true, // <--- Виправлення тут
    pipeline: () => ({
      hset: () => ({ publish: () => ({}) }),
      exec: async () => {
        console.log('🗄️ [REDIS] Спроба записати pipeline (зависання на 5 сек)...');
        return new Promise(res => setTimeout(res, 5000)); 
      }
    })
  };

  const writer = new RedisWriter(mockRedisService, { 
    redisBatching: true, 
    redisFlushMs: 10000, // Штучно довгий інтервал
    logger: () => {}
  });

  console.log('🌊 Заливаємо 10,000 тікерів в пам\'ять (для 3-х монет)...');
  for (let i = 0; i < 10000; i++) {
    // Пишемо по колу лише 3 монети (не чекаючи await, щоб забити чергу миттєво)
    writer.writeTicker('binance', 'spot', 'BTC/USDT', { last: 70000 + i }).catch(()=>{});
    writer.writeTicker('binance', 'spot', 'ETH/USDT', { last: 3000 + i }).catch(()=>{});
    writer.writeTicker('binance', 'spot', 'SOL/USDT', { last: 150 + i }).catch(()=>{});
  }

  // Заглядаємо в метрики
  const metrics = writer.getMetrics();
  console.log(`\n📦 Метрики RedisWriter:`, metrics);

  // Використовуємо правильне поле queuedUpdates
  if (metrics.queuedUpdates > 10) {
    console.log('❌ БАГ: Пам\'ять переповнена! Дедуплікація не працює. Це призведе до Out Of Memory (OOM).');
  } else {
    console.log(`✅ УСПІХ: Дедуплікація працює ідеально. У черзі лише ${metrics.queuedUpdates} об'єкти. Пам'ять захищена.`);
  }

  console.log('\n🛑 Імітуємо SIGINT. Примусовий flush()...');
  const start = Date.now();
  await writer.flush();
  console.log(`✅ Залишки успішно збережено за ${Date.now() - start}мс.`);
}
runBackpressureTest();