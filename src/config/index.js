/**
 * Configuration Parser
 *
 * Loads and validates CLI arguments and environment variables.
 * Provides a single validated config object for the entire application.
 *
 * Usage:
 *   const config = require('./src/config');
 *   // OR via CLI:
 *   node src/index.js watch binance --type spot --batch-size 200
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse and validate environment variables from .env file
 * @returns {Object} Parsed environment variables
 */
function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  const envExample = path.resolve(process.cwd(), '.env.example');

  const env = {};

  // Load .env if it exists
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    parseEnvContent(content, env);
  }

  // If no .env, log location of .env.example for reference
  if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
    // Just reference existence, don't require it
  }

  return env;
}

/**
 * Parse environment file content
 * @param {string} content - File content
 * @param {Object} env - Target object to populate
 */
function parseEnvContent(content, env) {
  content.split('\n').forEach(line => {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2].trim();

      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      env[key] = value;
    }
  });
}

/**
 * Validate and sanitize config values
 * @param {Object} config - Raw config object
 * @returns {Object} Validated config
 * @throws {Error} If validation fails
 */
function validateConfig(config) {
  const errors = [];

  // Exchange validation
  if (!config.exchange) {
    errors.push('exchange is required (e.g., binance, bybit)');
  } else {
    config.exchange = config.exchange.toLowerCase();
  }

  // Market type validation
  if (!config.type) {
    errors.push('--type is required (spot or swap)');
  } else {
    config.type = config.type.toLowerCase();
    if (!['spot', 'swap'].includes(config.type)) {
      errors.push(`--type must be 'spot' or 'swap', got '${config.type}'`);
    }
  }

  // Batch size validation
  if (config.batchSize !== undefined) {
    const bs = parseInt(config.batchSize, 10);
    if (isNaN(bs) || bs < 1) {
      errors.push(`--batch-size must be a positive integer, got ${config.batchSize}`);
    } else {
      config.batchSize = bs;
    }
  }

  // Symbol limit validation
  if (config.limit !== undefined) {
    const limit = parseInt(config.limit, 10);
    if (isNaN(limit) || limit < 1) {
      errors.push(`--limit must be a positive integer, got ${config.limit}`);
    } else {
      config.limit = limit;
    }
  }

  // Subscription delay validation
  if (config.subscriptionDelay !== undefined) {
    const delay = parseInt(config.subscriptionDelay, 10);
    if (isNaN(delay) || delay < 0) {
      errors.push(`--subscription-delay must be a non-negative integer (ms), got ${config.subscriptionDelay}`);
    } else {
      config.subscriptionDelay = delay;
    }
  }

  // Market refresh interval validation
  if (config.marketRefreshInterval !== undefined) {
    const interval = parseInt(config.marketRefreshInterval, 10);
    if (isNaN(interval) || interval < 10000) {
      errors.push(`--market-refresh-interval must be >= 10000 ms, got ${config.marketRefreshInterval}`);
    } else {
      config.marketRefreshInterval = interval;
    }
  }

  // Memory limit validation
  if (config.memoryLimit !== undefined) {
    const limit = parseInt(config.memoryLimit, 10);
    if (isNaN(limit) || limit < 1) {
      errors.push(`--memory-limit must be a positive integer (MB), got ${config.memoryLimit}`);
    } else {
      config.memoryLimit = limit;
    }
  }

  // Redis URL validation
  if (config.redisUrl && !isValidRedisUrl(config.redisUrl)) {
    errors.push(`REDIS_URL format invalid: ${config.redisUrl}`);
  }

  // Redis batching config validation
  if (config.redisBatching !== undefined) {
    config.redisBatching = config.redisBatching === 'true' || config.redisBatching === '1';
  }

  if (config.redisFlushMs !== undefined) {
    const flushMs = parseInt(config.redisFlushMs, 10);
    if (isNaN(flushMs) || flushMs < 1) {
      errors.push(`REDIS_FLUSH_MS must be a positive integer, got ${config.redisFlushMs}`);
    } else {
      config.redisFlushMs = flushMs;
    }
  }

  if (config.redisMaxBatch !== undefined) {
    const maxBatch = parseInt(config.redisMaxBatch, 10);
    if (isNaN(maxBatch) || maxBatch < 1) {
      errors.push(`REDIS_MAX_BATCH must be a positive integer, got ${config.redisMaxBatch}`);
    } else {
      config.redisMaxBatch = maxBatch;
    }
  }

  if (config.redisOnlyOnChange !== undefined) {
    config.redisOnlyOnChange = config.redisOnlyOnChange === 'true' || config.redisOnlyOnChange === '1';
  }

  if (config.redisMinIntervalMs !== undefined) {
    const minInterval = parseInt(config.redisMinIntervalMs, 10);
    if (isNaN(minInterval) || minInterval < 0) {
      errors.push(`REDIS_MIN_INTERVAL_MS must be non-negative, got ${config.redisMinIntervalMs}`);
    } else {
      config.redisMinIntervalMs = minInterval;
    }
  }

  // Debug flag
  if (config.debug !== undefined) {
    config.debug = config.debug === 'true' || config.debug === '1' || config.debug === true;
  }

  // No proxy flag
  if (config.noProxy !== undefined) {
    config.noProxy = config.noProxy === 'true' || config.noProxy === '1' || config.noProxy === true;
  }

  // WatchTickers mode flag
  if (config.watchTickers !== undefined) {
    config.watchTickers = config.watchTickers === 'true' || config.watchTickers === '1' || config.watchTickers === true;
  }

  // Local IPs parsing
  if (config.localIps) {
    if (typeof config.localIps === 'string') {
      config.localIps = config.localIps.split(',').map(ip => ip.trim()).filter(ip => ip);
    }
    // Validate each IP
    config.localIps.forEach(ip => {
      if (!isValidIp(ip)) {
        errors.push(`Invalid IP address: ${ip}`);
      }
    });
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return config;
}

/**
 * Simple IPv4 address validator
 * @param {string} ip - IP to validate
 * @returns {boolean}
 */
function isValidIp(ip) {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipv4Regex.test(ip)) return false;

  const parts = ip.split('.');
  return parts.every(part => {
    const num = parseInt(part, 10);
    return num >= 0 && num <= 255;
  });
}

/**
 * Simple Redis URL validator
 * @param {string} url - Redis URL
 * @returns {boolean}
 */
function isValidRedisUrl(url) {
  try {
    // Accept redis://, rediss://, or localhost:port formats
    if (url.startsWith('redis://') || url.startsWith('rediss://')) {
      return true;
    }
    // Accept localhost:6379 format
    if (url.includes(':') && url.split(':').length === 2) {
      const [host, port] = url.split(':');
      const portNum = parseInt(port, 10);
      return !isNaN(portNum) && portNum > 0 && portNum < 65536;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Build config from CLI arguments
 * This function is called by src/index.js which uses commander
 *
 * @param {Object} cliArgs - Commander program arguments
 * @param {string} cliArgs.exchange - Exchange name (positional)
 * @param {string} cliArgs.type - Market type (--type)
 * @param {string} cliArgs.limit - Symbol limit (--limit)
 * @param {string} cliArgs.batchSize - Batch size (--batch-size)
 * @param {string} cliArgs.subscriptionDelay - Delay between subscriptions (--subscription-delay)
 * @param {string} cliArgs.marketRefreshInterval - Market refresh interval (--market-refresh-interval)
 * @param {string} cliArgs.memoryLimit - Memory limit in MB (--memory-limit)
 * @param {string} cliArgs.debug - Enable debug mode (--debug)
 * @param {string} cliArgs.noProxy - Disable proxy (--no-proxy)
 * @param {string} cliArgs.watchTickers - Use watchTickers mode (--watch-tickers)
 * @param {string} cliArgs.proxyProvider - Proxy provider name (--proxy-provider)
 * @param {string} cliArgs.proxyKey - Proxy seller key (--proxy-key)
 * @param {string} cliArgs.proxyUsername - Proxy username (--proxy-username)
 * @param {string} cliArgs.proxyPassword - Proxy password (--proxy-password)
 * @param {string} cliArgs.localIps - Comma-separated local IPs (--local-ips)
 * @returns {Object} Validated configuration object
 * @throws {Error} If validation fails
 */
function buildConfig(cliArgs) {
  // Load environment variables first (lowest priority)
  const envVars = loadEnvFile();
  const processEnv = process.env;

  // Merge environment variables with defaults
  const config = {
    // Core
    exchange: cliArgs.exchange || '',
    type: cliArgs.type || processEnv.MARKET_TYPE || '',
    limit: cliArgs.limit || processEnv.SYMBOL_LIMIT || 5000,
    batchSize: cliArgs.batchSize || processEnv.BATCH_SIZE || 100,
    subscriptionDelay: cliArgs.subscriptionDelay || 100,
    marketRefreshInterval: cliArgs.marketRefreshInterval || processEnv.MARKET_REFRESH_INTERVAL || 300000,

    // Memory
    memoryLimit: cliArgs.memoryLimit || processEnv.MEMORY_LIMIT || 1024,

    // Redis
    redisUrl: cliArgs.redisUrl || processEnv.REDIS_URL || envVars.REDIS_URL || 'localhost:6379',
    redisBatching: cliArgs.redisBatching || processEnv.REDIS_BATCHING || envVars.REDIS_BATCHING || true,
    redisFlushMs: cliArgs.redisFlushMs || processEnv.REDIS_FLUSH_MS || envVars.REDIS_FLUSH_MS || 1000,
    redisMaxBatch: cliArgs.redisMaxBatch || processEnv.REDIS_MAX_BATCH || envVars.REDIS_MAX_BATCH || 1000,
    redisOnlyOnChange: cliArgs.redisOnlyOnChange || processEnv.REDIS_ONLY_ON_CHANGE || envVars.REDIS_ONLY_ON_CHANGE || true,
    redisMinIntervalMs: cliArgs.redisMinIntervalMs || processEnv.REDIS_MIN_INTERVAL_MS || envVars.REDIS_MIN_INTERVAL_MS || 0,

    // Proxy
    noProxy: cliArgs.noProxy || processEnv.NO_PROXY === 'true' || false,
    proxyProvider: cliArgs.proxyProvider || processEnv.PROXY_PROVIDER || envVars.PROXY_PROVIDER || null,
    proxyKey: cliArgs.proxyKey || processEnv.PROXY_SELLER_KEY || envVars.PROXY_SELLER_KEY || null,
    proxyUsername: cliArgs.proxyUsername || processEnv.OXYLABS_USERNAME || envVars.OXYLABS_USERNAME || null,
    proxyPassword: cliArgs.proxyPassword || processEnv.OXYLABS_PASSWORD || envVars.OXYLABS_PASSWORD || null,

    // Network
    localIps: cliArgs.localIps || processEnv.LOCAL_IPS || envVars.LOCAL_IPS || null,

    // Modes
    watchTickers: cliArgs.watchTickers || processEnv.WATCH_TICKERS === 'true' || false,
    debug: cliArgs.debug || processEnv.DEBUG === 'true' || false,
  };

  // Validate and return
  return validateConfig(config);
}

/**
 * Get a config summary for logging
 * @param {Object} config - Configuration object
 * @returns {Object} Cleaned config for display (removes sensitive values)
 */
function getConfigSummary(config) {
  const summary = { ...config };

  // Remove sensitive values
  if (summary.proxyPassword) summary.proxyPassword = '***REDACTED***';
  if (summary.proxyKey) summary.proxyKey = '***REDACTED***';

  return summary;
}

module.exports = {
  buildConfig,
  validateConfig,
  getConfigSummary,
  loadEnvFile,
  isValidRedisUrl,
  isValidIp,
};
