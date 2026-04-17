/**
 * UC1: Promise.race() Poison Bug Test
 *
 * Regression test for Stage 2 per-symbol error isolation.
 * Verifies that fast-failing symbols don't starve healthy symbols in Promise.race() loop.
 *
 * The "poison" scenario:
 * - SCAM/USDT fails immediately (API Glitch - always throws)
 * - BTC/USDT succeeds after 100ms delay
 * - ETH/USDT succeeds after 100ms delay
 *
 * Without fairness mechanism:
 * ❌ SCAM wins Promise.race() every time (fastest to fail)
 * ❌ BTC/ETH never get tickers (starved)
 * ❌ Test hangs or times out
 *
 * With fairness mechanism:
 * ✅ SCAM removed from pending on failure
 * ✅ BTC/ETH win race, produce tickers
 * ✅ SCAM re-added after fairness cycle
 * ✅ All symbols isolated, healthy ones continue
 */

const PerSymbolStrategy = require('./src/adapters/strategies/per-symbol.strategy');

console.log('--- UC1: Отруєний Promise (PER_SYMBOL Strategy) ---\n');

async function runTest() {
  // Mock exchange with one failing symbol
  const mockExchange = {
    watchTicker: async (symbol) => {
      if (symbol === 'SCAM/USDT') {
        throw new Error('API Glitch on SCAM/USDT');
      }
      // Healthy symbols have 100ms latency to act slowly
      await new Promise(r => setTimeout(r, 100));
      return {
        symbol,
        last: 100 + Math.random() * 10,
        bid: 99 + Math.random() * 10,
        ask: 101 + Math.random() * 10,
        timestamp: Date.now(),
      };
    },
  };

  const strategy = new PerSymbolStrategy({
    exchange: 'binance',
    logger: (level, msg, meta) => {
      if (level === 'warn' && msg.includes('Symbol subscription failed')) {
        console.log(`[${level.toUpperCase()}] PerSymbolStrategy: Symbol subscription failed`);
      }
    },
  });

  const output = [];
  const startTime = Date.now();

  try {
    // Run strategy for 2 seconds or until loop completes
    for await (const { symbol, ticker } of strategy.execute(mockExchange, ['BTC/USDT', 'ETH/USDT', 'SCAM/USDT'])) {
      output.push({ symbol, ticker });

      // Stop after 2 seconds
      if (Date.now() - startTime > 2000) {
        break;
      }
    }
  } catch (error) {
    console.error('Strategy error:', error.message);
  }

  // Stop the strategy
  await strategy.close();

  console.log('\n📊 Результати тесту:');
  console.log(`   totalTickers: ${output.length}`);

  // SUCCESS CRITERIA: Healthy symbols produce tickers despite SCAM failure
  if (output.length > 0) {
    const uniqueSymbols = [...new Set(output.map(t => t.symbol))];
    console.log(`   symbols: ${uniqueSymbols.join(', ')}`);
    console.log(`✅ УСПІХ: Цикл не впав! Хороші тікери (${uniqueSymbols.filter(s => s !== 'SCAM/USDT').join(', ')}) обходять SCAM/USDT помилку.`);
  } else {
    console.log('❌ БАГ: Цикл завис або хороші монети не проходять.');
  }

  process.exit(output.length > 0 ? 0 : 1);
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

// Timeout safety
setTimeout(() => {
  console.error('Test timed out after 15 seconds');
  process.exit(1);
}, 15000);
