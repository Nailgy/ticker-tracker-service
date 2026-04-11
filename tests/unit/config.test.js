/**
 * Configuration Parser - Unit Tests
 *
 * Tests for CLI argument parsing, environment variable loading,
 * and configuration validation.
 */

const { buildConfig, validateConfig, isValidRedisUrl, isValidIp } = require('../../src/config');

describe('Config Parser', () => {
  describe('buildConfig', () => {
    it('should build a valid config with minimal required arguments', () => {
      const config = buildConfig({
        exchange: 'binance',
        type: 'spot',
      });

      expect(config.exchange).toBe('binance');
      expect(config.type).toBe('spot');
      expect(config.limit).toBe(5000);
      expect(config.batchSize).toBe(100);
    });

    it('should convert exchange name to lowercase', () => {
      const config = buildConfig({
        exchange: 'BINANCE',
        type: 'spot',
      });

      expect(config.exchange).toBe('binance');
    });

    it('should convert market type to lowercase', () => {
      const config = buildConfig({
        exchange: 'binance',
        type: 'SPOT',
      });

      expect(config.type).toBe('spot');
    });

    it('should override defaults with CLI arguments', () => {
      const config = buildConfig({
        exchange: 'bybit',
        type: 'swap',
        limit: 1000,
        batchSize: 200,
        subscriptionDelay: 500,
      });

      expect(config.exchange).toBe('bybit');
      expect(config.type).toBe('swap');
      expect(config.limit).toBe(1000);
      expect(config.batchSize).toBe(200);
      expect(config.subscriptionDelay).toBe(500);
    });

    it('should parse boolean flags correctly', () => {
      const config = buildConfig({
        exchange: 'binance',
        type: 'spot',
        debug: true,
        noProxy: true,
        watchTickers: true,
      });

      expect(config.debug).toBe(true);
      expect(config.noProxy).toBe(true);
      expect(config.watchTickers).toBe(true);
    });

    it('should parse local IPs as comma-separated list', () => {
      const config = buildConfig({
        exchange: 'binance',
        type: 'spot',
        localIps: '192.168.1.1,192.168.1.2,192.168.1.3',
      });

      expect(Array.isArray(config.localIps)).toBe(true);
      expect(config.localIps).toHaveLength(3);
      expect(config.localIps).toContain('192.168.1.1');
    });

    it('should strip whitespace from local IPs', () => {
      const config = buildConfig({
        exchange: 'binance',
        type: 'spot',
        localIps: '192.168.1.1 , 192.168.1.2 , 192.168.1.3',
      });

      expect(config.localIps).toEqual(['192.168.1.1', '192.168.1.2', '192.168.1.3']);
    });
  });

  describe('validateConfig', () => {
    it('should throw if exchange is missing', () => {
      expect(() => {
        validateConfig({
          type: 'spot',
        });
      }).toThrow('exchange is required');
    });

    it('should throw if type is missing', () => {
      expect(() => {
        validateConfig({
          exchange: 'binance',
        });
      }).toThrow('--type is required');
    });

    it('should throw if type is invalid', () => {
      expect(() => {
        validateConfig({
          exchange: 'binance',
          type: 'invalid',
        });
      }).toThrow('--type must be \'spot\' or \'swap\'');
    });

    it('should throw if batch size is not a positive integer', () => {
      expect(() => {
        validateConfig({
          exchange: 'binance',
          type: 'spot',
          batchSize: 'not-a-number',
        });
      }).toThrow('--batch-size must be a positive integer');
    });

    it('should throw if batch size is zero or negative', () => {
      expect(() => {
        validateConfig({
          exchange: 'binance',
          type: 'spot',
          batchSize: 0,
        });
      }).toThrow('--batch-size must be a positive integer');
    });

    it('should throw if limit is not a positive integer', () => {
      expect(() => {
        validateConfig({
          exchange: 'binance',
          type: 'spot',
          limit: 'invalid',
        });
      }).toThrow('--limit must be a positive integer');
    });

    it('should throw if market refresh interval is less than 10000ms', () => {
      expect(() => {
        validateConfig({
          exchange: 'binance',
          type: 'spot',
          marketRefreshInterval: 5000,
        });
      }).toThrow('--market-refresh-interval must be >= 10000 ms');
    });

    it('should throw if Redis URL is invalid', () => {
      expect(() => {
        validateConfig({
          exchange: 'binance',
          type: 'spot',
          redisUrl: 'not-a-valid-url',
        });
      }).toThrow('REDIS_URL format invalid');
    });

    it('should throw if local IP is invalid', () => {
      expect(() => {
        validateConfig({
          exchange: 'binance',
          type: 'spot',
          localIps: ['192.168.1.1', '999.999.999.999'],
        });
      }).toThrow('Invalid IP address: 999.999.999.999');
    });

    it('should validate correct config successfully', () => {
      const config = {
        exchange: 'binance',
        type: 'spot',
        limit: 5000,
        batchSize: 100,
        subscriptionDelay: 100,
        marketRefreshInterval: 300000,
        redisUrl: 'localhost:6379',
      };

      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('isValidRedisUrl', () => {
    it('should accept redis:// URLs', () => {
      expect(isValidRedisUrl('redis://localhost:6379')).toBe(true);
      expect(isValidRedisUrl('redis://redis-server:6379')).toBe(true);
    });

    it('should accept rediss:// URLs', () => {
      expect(isValidRedisUrl('rediss://secure-redis:6379')).toBe(true);
    });

    it('should accept host:port format', () => {
      expect(isValidRedisUrl('localhost:6379')).toBe(true);
      expect(isValidRedisUrl('192.168.1.1:6379')).toBe(true);
    });

    it('should reject invalid port numbers', () => {
      expect(isValidRedisUrl('localhost:invalid')).toBe(false);
      expect(isValidRedisUrl('localhost:0')).toBe(false);
      expect(isValidRedisUrl('localhost:99999')).toBe(false);
    });

    it('should reject invalid formats', () => {
      expect(isValidRedisUrl('not-a-url')).toBe(false);
      expect(isValidRedisUrl('localhost')).toBe(false);
    });
  });

  describe('isValidIp', () => {
    it('should accept valid IPv4 addresses', () => {
      expect(isValidIp('192.168.1.1')).toBe(true);
      expect(isValidIp('127.0.0.1')).toBe(true);
      expect(isValidIp('0.0.0.0')).toBe(true);
      expect(isValidIp('255.255.255.255')).toBe(true);
    });

    it('should reject invalid IPv4 addresses', () => {
      expect(isValidIp('256.1.1.1')).toBe(false);
      expect(isValidIp('192.168.1')).toBe(false);
      expect(isValidIp('192.168.1.1.1')).toBe(false);
      expect(isValidIp('not-an-ip')).toBe(false);
      expect(isValidIp('')).toBe(false);
    });

    it('should reject IPv6 addresses', () => {
      expect(isValidIp('::1')).toBe(false);
      expect(isValidIp('2001:db8::1')).toBe(false);
    });
  });
});
