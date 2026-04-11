/**
 * ProxyService & ExchangeFactory - Unit Tests
 *
 * Tests proxy rotation, exchange instance creation, and ticker normalization
 * using mocked CCXT to avoid external dependencies.
 */

const ProxyService = require('../../src/services/proxy.service');
const ExchangeFactory = require('../../src/services/exchange.factory.js');
const https = require('https');

// Mock https.Agent
jest.mock('https', () => ({
  Agent: jest.fn().mockImplementation((options) => ({
    localAddress: options.localAddress,
    keepAlive: options.keepAlive,
  })),
}));

// Mock CCXT
jest.mock('ccxt', () => ({
  pro: {
    binance: jest.fn().mockImplementation(() => ({
      id: 'binance',
      name: 'Binance',
      loadMarkets: jest.fn().mockResolvedValue([
        {
          id: 'btc/usdt',
          symbol: 'BTC/USDT',
          active: true,
          spot: true,
          swap: false,
        },
        {
          id: 'eth/usdt',
          symbol: 'ETH/USDT',
          active: true,
          spot: true,
          swap: false,
        },
        {
          id: 'bnb/usdt',
          symbol: 'BNB/USDT',
          active: false,
          spot: true,
          swap: false,
        },
      ]),
    })),
    bybit: jest.fn().mockImplementation(() => ({
      id: 'bybit',
      name: 'Bybit',
      loadMarkets: jest.fn().mockResolvedValue([]),
    })),
    kraken: jest.fn().mockImplementation(() => ({
      id: 'kraken',
      name: 'Kraken',
      loadMarkets: jest.fn().mockResolvedValue([]),
    })),
  },
}));

const ccxt = require('ccxt');

describe('ProxyService', () => {
  let proxyService;

  describe('Initialization', () => {
    it('should initialize with empty proxy list', () => {
      proxyService = new ProxyService();

      expect(proxyService.config.proxies.length).toBe(0);
      expect(proxyService.currentIndex).toBe(0);
      expect(proxyService.stats.totalRequests).toBe(0);
    });

    it('should initialize with proxy list', () => {
      const proxies = ['http://proxy1:8080', 'http://proxy2:8080'];
      proxyService = new ProxyService({ proxies });

      expect(proxyService.config.proxies).toEqual(proxies);
      expect(proxyService.getProxyCount()).toBe(2);
    });
  });

  describe('Round-Robin Rotation', () => {
    beforeEach(() => {
      const proxies = ['proxy1', 'proxy2', 'proxy3'];
      proxyService = new ProxyService({ proxies });
    });

    it('should return proxies in order', () => {
      expect(proxyService.getNextProxy()).toBe('proxy1');
      expect(proxyService.getNextProxy()).toBe('proxy2');
      expect(proxyService.getNextProxy()).toBe('proxy3');
    });

    it('should wrap around to first proxy', () => {
      proxyService.getNextProxy(); // proxy1
      proxyService.getNextProxy(); // proxy2
      proxyService.getNextProxy(); // proxy3
      expect(proxyService.getNextProxy()).toBe('proxy1');
      expect(proxyService.stats.rotations).toBe(1);
    });

    it('should track total requests', () => {
      proxyService.getNextProxy();
      proxyService.getNextProxy();
      proxyService.getNextProxy();

      expect(proxyService.stats.totalRequests).toBe(3);
    });

    it('should track rotation cycles', () => {
      for (let i = 0; i < 9; i++) {
        proxyService.getNextProxy();
      }

      expect(proxyService.stats.rotations).toBe(3);
    });

    it('should return null when no proxies configured', () => {
      const emptyProxy = new ProxyService({ proxies: [] });
      expect(emptyProxy.getNextProxy()).toBeNull();
    });

    it('should support single proxy (no wrapping)', () => {
      const single = new ProxyService({ proxies: ['only-proxy'] });

      expect(single.getNextProxy()).toBe('only-proxy');
      expect(single.getNextProxy()).toBe('only-proxy');
      expect(single.getNextProxy()).toBe('only-proxy');
    });
  });

  describe('Proxy Management', () => {
    beforeEach(() => {
      proxyService = new ProxyService({ proxies: ['proxy1', 'proxy2'] });
    });

    it('should get current proxy without advancing', () => {
      proxyService.getNextProxy(); // advance to proxy2

      const current = proxyService.getCurrentProxy();
      expect(current).toBe('proxy2');

      const next = proxyService.getNextProxy();
      expect(next).toBe('proxy2'); // Still proxy2 (second one)
    });

    it('should reset rotation', () => {
      proxyService.getNextProxy();
      proxyService.getNextProxy();
      proxyService.reset();

      expect(proxyService.currentIndex).toBe(0);
      expect(proxyService.stats.rotations).toBe(0);
      expect(proxyService.stats.totalRequests).toBe(0);
      expect(proxyService.getNextProxy()).toBe('proxy1');
    });

    it('should update proxy list', () => {
      proxyService.setProxies(['new1', 'new2', 'new3']);

      expect(proxyService.getProxyCount()).toBe(3);
      expect(proxyService.getNextProxy()).toBe('new1');
    });

    it('should clear proxy list', () => {
      proxyService.setProxies([]);

      expect(proxyService.getProxyCount()).toBe(0);
      expect(proxyService.getNextProxy()).toBeNull();
    });
  });

  describe('Status & Metrics', () => {
    beforeEach(() => {
      proxyService = new ProxyService({ proxies: ['proxy1', 'proxy2'] });
    });

    it('should return status snapshot', () => {
      proxyService.getNextProxy();
      proxyService.getNextProxy();

      const status = proxyService.getStatus();

      expect(status.proxyCount).toBe(2);
      expect(status.currentIndex).toBe(0);
      expect(status.currentProxy).toBe('proxy1');
      expect(status.stats.totalRequests).toBe(2);
    });
  });
});

describe('ExchangeFactory', () => {
  let factory;

  describe('Initialization', () => {
    it('should initialize with defaults', () => {
      factory = new ExchangeFactory({ exchange: 'binance' });

      expect(factory.config.exchange).toBe('binance');
      expect(factory.config.marketType).toBe('spot');
      expect(factory.exchangeInstance).toBeNull();
    });

    it('should initialize with custom config', () => {
      factory = new ExchangeFactory({
        exchange: 'BYBIT',
        marketType: 'SWAP',
      });

      expect(factory.config.exchange).toBe('bybit');
      expect(factory.config.marketType).toBe('swap');
    });

    it('should throw if exchange is missing', () => {
      expect(() => {
        new ExchangeFactory({});
      }).toThrow('exchange is required');
    });

    it('should throw if market type is invalid', () => {
      expect(() => {
        new ExchangeFactory({ exchange: 'binance', marketType: 'invalid' });
      }).toThrow('marketType must be spot or swap');
    });
  });

  describe('Exchange Creation', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should create exchange instance', () => {
      factory = new ExchangeFactory({ exchange: 'binance' });
      const exchange = factory.createExchange();

      expect(ccxt.pro.binance).toHaveBeenCalled();
      expect(exchange.id).toBe('binance');
      expect(factory.getExchange()).toBe(exchange);
    });

    it('should throw if exchange not supported', () => {
      factory = new ExchangeFactory({ exchange: 'invalid' });

      expect(() => {
        factory.createExchange();
      }).toThrow('not supported');
    });

    it('should apply exchange options', () => {
      factory = new ExchangeFactory({ exchange: 'binance' });
      factory.createExchange();

      const callArgs = ccxt.pro.binance.mock.calls[0][0];
      expect(callArgs.enableRateLimit).toBe(true);
      expect(callArgs.rateLimit).toBe(100);
    });

    it('should merge override options', () => {
      factory = new ExchangeFactory({ exchange: 'binance' });
      factory.createExchange({ rateLimit: 200 });

      const callArgs = ccxt.pro.binance.mock.calls[0][0];
      expect(callArgs.rateLimit).toBe(200);
    });
  });

  describe('Local IP Binding', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should bind to local IP if provided', () => {
      factory = new ExchangeFactory({
        exchange: 'binance',
        localIps: ['192.168.1.100', '192.168.1.101'],
      });

      factory.createExchange();

      expect(https.Agent).toHaveBeenCalled();
      const agentArgs = https.Agent.mock.calls[0][0];
      expect(agentArgs.localAddress).toBe('192.168.1.100');
    });

    it('should rotate local IPs on multiple creates', () => {
      factory = new ExchangeFactory({
        exchange: 'binance',
        localIps: ['192.168.1.100', '192.168.1.101', '192.168.1.102'],
      });

      factory.createExchange();
      factory.createExchange();
      factory.createExchange();

      const calls = https.Agent.mock.calls;
      expect(calls[0][0].localAddress).toBe('192.168.1.100');
      expect(calls[1][0].localAddress).toBe('192.168.1.101');
      expect(calls[2][0].localAddress).toBe('192.168.1.102');
    });

    it('should skip IP binding if empty list', () => {
      factory = new ExchangeFactory({
        exchange: 'binance',
        localIps: [],
      });

      factory.createExchange();

      expect(https.Agent).not.toHaveBeenCalled();
    });
  });

  describe('Proxy Integration', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should use proxy from ProxyService', () => {
      const proxyService = new ProxyService({
        proxies: ['http://proxy:8080'],
      });

      factory = new ExchangeFactory({
        exchange: 'binance',
        proxyService,
      });

      factory.createExchange();

      const callArgs = ccxt.pro.binance.mock.calls[0][0];
      expect(callArgs.proxy).toBe('http://proxy:8080');
    });

    it('should skip proxy if ProxyService has no proxies', () => {
      const proxyService = new ProxyService({ proxies: [] });

      factory = new ExchangeFactory({
        exchange: 'binance',
        proxyService,
      });

      factory.createExchange();

      const callArgs = ccxt.pro.binance.mock.calls[0][0];
      expect(callArgs.proxy).toBeUndefined();
    });

    it('should rotate proxies on multiple creates', () => {
      const proxyService = new ProxyService({
        proxies: ['proxy1', 'proxy2'],
      });

      factory = new ExchangeFactory({
        exchange: 'binance',
        proxyService,
      });

      factory.createExchange();
      factory.createExchange();

      const calls = ccxt.pro.binance.mock.calls;
      expect(calls[0][0].proxy).toBe('proxy1');
      expect(calls[1][0].proxy).toBe('proxy2');
    });
  });

  describe('Ticker Normalization', () => {
    beforeEach(() => {
      factory = new ExchangeFactory({ exchange: 'binance', marketType: 'spot' });
    });

    it('should normalize binance ticker', () => {
      const rawTicker = {
        symbol: 'BTC/USDT',
        last: 68000,
        bid: 67999,
        ask: 68001,
        high: 69000,
        low: 67000,
        baseVolume: 1000,
        quoteVolume: 68000000,
        timestamp: 1710000000000,
      };

      const normalized = factory.normalizeTicker('BTC/USDT', rawTicker);

      expect(normalized.symbol).toBe('BTC/USDT');
      expect(normalized.exchange).toBe('binance');
      expect(normalized.marketType).toBe('spot');
      expect(normalized.last).toBe(68000);
      expect(normalized.bid).toBe(67999);
      expect(normalized.ask).toBe(68001);
      expect(normalized.timestamp).toBe(1710000000000);
    });

    it('should add current timestamp if missing', () => {
      const rawTicker = {
        symbol: 'BTC/USDT',
        last: 68000,
      };

      const before = Date.now();
      const normalized = factory.normalizeTicker('BTC/USDT', rawTicker);
      const after = Date.now();

      expect(normalized.timestamp).toBeGreaterThanOrEqual(before - 100);
      expect(normalized.timestamp).toBeLessThanOrEqual(after + 100);
    });

    it('should handle null ticker', () => {
      const normalized = factory.normalizeTicker('BTC/USDT', null);
      expect(normalized).toBeNull();
    });

    it('should skip undefined/null fields', () => {
      const rawTicker = {
        symbol: 'BTC/USDT',
        last: 68000,
        bid: undefined,
        ask: null,
      };

      const normalized = factory.normalizeTicker('BTC/USDT', rawTicker);

      expect(normalized.bid).toBeUndefined();
      expect(normalized.ask).toBeUndefined();
      expect(normalized.last).toBe(68000);
    });

    it('should apply exchange-specific transforms', () => {
      factory = new ExchangeFactory({ exchange: 'bybit', marketType: 'swap' });

      const rawTicker = {
        symbol: 'BTC/USDT',
        last: 68000,
        info: {
          bid1: '67999.5',
          ask1: '68001.5',
        },
      };

      const normalized = factory.normalizeTicker('BTC/USDT', rawTicker);

      // Bybit transform should use bid1/ask1 if bid/ask missing
      expect(normalized.symbol).toBe('BTC/USDT');
      expect(normalized.exchange).toBe('bybit');
    });
  });

  describe('Market Loading', () => {
    it('should load and filter markets', async () => {
      factory = new ExchangeFactory({ exchange: 'binance', marketType: 'spot' });
      factory.createExchange();

      const markets = await factory.loadMarkets();

      expect(markets).toHaveLength(2); // BTC/USDT, ETH/USDT (BNB excluded - not active)
    });

    it('should throw if exchange not initialized', async () => {
      factory = new ExchangeFactory({ exchange: 'binance' });

      await expect(factory.loadMarkets()).rejects.toThrow('not initialized');
    });

    it('should filter by market type', async () => {
      factory = new ExchangeFactory({ exchange: 'binance', marketType: 'spot' });
      factory.createExchange();

      const markets = await factory.loadMarkets();

      expect(markets).toHaveLength(2);
      expect(markets[0].spot).toBe(true);
    });

    it('should exclude inactive markets', async () => {
      factory = new ExchangeFactory({ exchange: 'binance', marketType: 'spot' });
      factory.createExchange();

      const markets = await factory.loadMarkets();

      const inactive = markets.filter(m => m.active === false);
      expect(inactive).toHaveLength(0);
    });
  });

  describe('Normalization Rules', () => {
    it('should return rules for binance', () => {
      factory = new ExchangeFactory({ exchange: 'binance' });
      const rules = factory.getNormalizationRules();

      expect(rules.symbol).toBe('symbol');
      expect(rules.last).toBe('last');
      expect(rules.bid).toBe('bid');
    });

    it('should return rules for bybit', () => {
      factory = new ExchangeFactory({ exchange: 'bybit' });
      const rules = factory.getNormalizationRules();

      expect(rules.symbol).toBe('symbol');
      expect(rules.last).toBe('last');
    });

    it('should return default rules for unknown exchange', () => {
      factory = new ExchangeFactory({ exchange: 'unknown' });
      const rules = factory.getNormalizationRules();

      expect(rules.symbol).toBe('symbol');
      expect(rules.timestamp).toBe('timestamp');
    });
  });

  describe('Status & Metrics', () => {
    it('should return status snapshot', () => {
      factory = new ExchangeFactory({
        exchange: 'binance',
        marketType: 'spot',
        localIps: ['192.168.1.100'],
      });

      const status = factory.getStatus();

      expect(status.exchange).toBe('binance');
      expect(status.marketType).toBe('spot');
      expect(status.exchangeInitialized).toBe(false);
      expect(status.localIpCount).toBe(1);
    });

    it('should update status after exchange creation', () => {
      factory = new ExchangeFactory({ exchange: 'binance' });
      factory.createExchange();

      const status = factory.getStatus();

      expect(status.exchangeInitialized).toBe(true);
    });
  });
});
