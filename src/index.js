#!/usr/bin/env node

/**
 * Ticker Tracker Service - CLI Entry Point
 *
 * This is the main entry point. Phase 1 sets up configuration parsing.
 * Phase 2 will implement the TickerWatcher orchestrator.
 *
 * Usage:
 *   node src/index.js watch binance --type spot --batch-size 200 --debug
 *   node src/index.js watch bybit --type swap --limit 1000
 */

const { Command } = require('commander');
const { buildConfig, getConfigSummary } = require('./config');

const program = new Command();

program
  .name('ticker-tracker')
  .description('Real-time Exchange Ticker Tracker Service with Redis persistence')
  .version('1.0.0');

// Watch command - tracks tickers for an exchange
program
  .command('watch <exchange>')
  .description('Start tracking tickers for an exchange')
  .option('--type <type>', 'Market type (spot or swap)', 'spot')
  .option('--limit <limit>', 'Maximum symbols to track', '5000')
  .option('--batch-size <size>', 'Symbols per connection', '100')
  .option('--subscription-delay <ms>', 'Delay between subscriptions (ms)', '100')
  .option('--market-refresh-interval <ms>', 'Market refresh interval (ms)', '300000')
  .option('--memory-limit <mb>', 'Memory limit alert threshold (MB)', '1024')
  .option('--redis-url <url>', 'Redis connection URL', 'localhost:6379')
  .option('--debug', 'Enable debug logging', false)
  .option('--no-proxy', 'Disable all proxy usage', false)
  .option('--watch-tickers', 'Prefer watchTickers mode', false)
  .option('--proxy-provider <provider>', 'Proxy provider name')
  .option('--proxy-key <key>', 'Proxy seller key')
  .option('--proxy-username <user>', 'Proxy username (Oxylabs)')
  .option('--proxy-password <pass>', 'Proxy password (Oxylabs)')
  .option('--local-ips <ips>', 'Comma-separated local IPs to bind')
  .action(async (exchange, options) => {
    try {
      // Build and validate configuration
      const config = buildConfig({
        exchange,
        ...options,
      });

      // Log configuration summary
      console.log('\n=== Ticker Tracker Service - Starting ===');
      console.log('Configuration Summary:');
      console.log(JSON.stringify(getConfigSummary(config), null, 2));
      console.log('');

      // Phase 2: Instantiate and start TickerWatcher
      console.log('⏳ Phase 2 implementation pending: TickerWatcher initialization');
      console.log('   - ConnectionManager setup');
      console.log('   - RedisService connection');
      console.log('   - ExchangeFactory market loading');
      console.log('   - Ticker subscription launch');

      process.exit(0);
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
  process.exit(0);
}
