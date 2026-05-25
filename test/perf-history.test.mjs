// Run with: node test/perf-history.test.mjs
// Validates the perf-history algorithm without hitting external APIs.

import { strict as assert } from 'node:assert';
import { computePerformance } from '../api/perf-history.js';

let passed = 0;
let failed = 0;

// Properly awaits async tests.
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

console.log('\n— computePerformance —');

await test('happy path: single AAPL buy, 3 days of candles', () => {
  const result = computePerformance({
    transactions: [
      { date: '2023-11-26', side: 'buy', ticker: 'AAPL', qty: 10, price: 180, assetClass: 'Stocks' },
    ],
    candles: {
      AAPL: { '2023-11-26': 180, '2023-11-27': 185, '2023-11-28': 190 },
    },
    spyCandles: { '2023-11-26': 450, '2023-11-27': 455, '2023-11-28': 460 },
    firstDate: '2023-11-26',
    todayDate: '2023-11-28',
  });
  assert.deepEqual(result.dates, ['2023-11-26', '2023-11-27', '2023-11-28']);
  assert.deepEqual(result.portfolio, [0, 2.78, 5.56]);
  assert.deepEqual(result.spy, [0, 1.11, 2.22]);
});

await test('excludes non-whitelisted classes', () => {
  const result = computePerformance({
    transactions: [
      { date: '2023-11-26', side: 'buy', ticker: 'TLT', qty: 5, price: 90, assetClass: 'Bonds' },
      { date: '2023-11-26', side: 'buy', ticker: 'CASH', qty: 1, price: 100, assetClass: 'Unallocated USD' },
    ],
    candles: { TLT: { '2023-11-26': 90, '2023-11-27': 91 } },
    spyCandles: { '2023-11-26': 450, '2023-11-27': 455 },
    firstDate: '2023-11-26',
    todayDate: '2023-11-27',
  });
  assert.deepEqual(result.dates, []);
  assert.equal(result.meta.reason, 'no-eligible-transactions');
});

await test('includes all four whitelisted classes', () => {
  const tx = (assetClass, ticker) => ({
    date: '2023-11-26', side: 'buy', ticker, qty: 1, price: 100, assetClass,
  });
  const result = computePerformance({
    transactions: [
      tx('Stocks', 'AAPL'),
      tx('BRA Stocks', 'BBSE3'),
      tx('Alternative', 'BTC'),
      tx('Real Estate', 'VNQ'),
    ],
    candles: {
      AAPL: { '2023-11-26': 100 },
      BBSE3: { '2023-11-26': 30 },
      BTC: { '2023-11-26': 40000 },
      VNQ: { '2023-11-26': 80 },
    },
    spyCandles: { '2023-11-26': 450 },
    fxMap: { '2023-11-26': 5 },
    firstDate: '2023-11-26',
    todayDate: '2023-11-26',
  });
  assert.equal(result.dates.length, 1);
  assert.equal(result.meta.txFiltered, 4);
});

await test('sell reduces position', () => {
  const result = computePerformance({
    transactions: [
      { date: '2023-11-26', side: 'buy', ticker: 'AAPL', qty: 10, price: 180, assetClass: 'Stocks' },
      { date: '2023-11-27', side: 'sell', ticker: 'AAPL', qty: 5, price: 185, assetClass: 'Stocks' },
    ],
    candles: { AAPL: { '2023-11-26': 180, '2023-11-27': 185, '2023-11-28': 200 } },
    spyCandles: { '2023-11-26': 450, '2023-11-27': 455, '2023-11-28': 460 },
    firstDate: '2023-11-26',
    todayDate: '2023-11-28',
  });
  // TWR uses prev day's positions to isolate price return from capital flows.
  // Day 0: base → 0%
  // Day 1: prev=10 shares; 10×185/10×180 − 1 = 2.78%; chain=1.0278
  // Day 2: prev=5 shares; 5×200/5×185 × chain − 1 = 11.11% (200/180 telescopes)
  assert.deepEqual(result.portfolio, [0, 2.78, 11.11]);
});

await test('BRL ticker converted to USD via FX', () => {
  const result = computePerformance({
    transactions: [
      { date: '2023-11-26', side: 'buy', ticker: 'BBSE3', qty: 100, price: 30, assetClass: 'BRA Stocks' },
    ],
    candles: { BBSE3: { '2023-11-26': 30, '2023-11-27': 31 } },
    spyCandles: { '2023-11-26': 450, '2023-11-27': 455 },
    fxMap: { '2023-11-26': 5, '2023-11-27': 5 }, // BRL/USD
    firstDate: '2023-11-26',
    todayDate: '2023-11-27',
  });
  // Day 0: 100 * 30 / 5 = 600 USD
  // Day 1: 100 * 31 / 5 = 620 USD → +3.33%
  assert.deepEqual(result.portfolio, [0, 3.33]);
});

await test('carries forward prices over weekends', () => {
  const result = computePerformance({
    transactions: [
      { date: '2023-11-24', side: 'buy', ticker: 'AAPL', qty: 10, price: 180, assetClass: 'Stocks' },
    ],
    // SPY trades Fri + Mon, AAPL also; Sat/Sun should carry forward Fri price.
    candles: { AAPL: { '2023-11-24': 180, '2023-11-27': 190 } },
    spyCandles: { '2023-11-24': 450, '2023-11-27': 460 },
    firstDate: '2023-11-24',
    todayDate: '2023-11-27',
  });
  // Days emitted = SPY trading days only (Fri + Mon)
  assert.deepEqual(result.dates, ['2023-11-24', '2023-11-27']);
});

await test('skips days with no SPY data', () => {
  const result = computePerformance({
    transactions: [
      { date: '2023-11-26', side: 'buy', ticker: 'AAPL', qty: 10, price: 180, assetClass: 'Stocks' },
    ],
    candles: { AAPL: { '2023-11-26': 180, '2023-11-27': 185, '2023-11-28': 190 } },
    spyCandles: {}, // no SPY data at all
    firstDate: '2023-11-26',
    todayDate: '2023-11-28',
  });
  assert.deepEqual(result.dates, []);
  assert.equal(result.meta.reason, 'no-priced-days');
});

await test('large portfolio: 50 tickers × 250 days returns sensible series', () => {
  // Simulate a realistic 436-transaction-like scenario.
  const tickers = Array.from({ length: 50 }, (_, i) => `T${i}`);
  const dates = Array.from({ length: 250 }, (_, i) => {
    const d = new Date('2024-01-01T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  // Each ticker: linear price growth from 100 to 150 over the range.
  const candles = {};
  for (const t of tickers) {
    candles[t] = {};
    for (let i = 0; i < dates.length; i++) {
      candles[t][dates[i]] = 100 + (i / (dates.length - 1)) * 50;
    }
  }
  // SPY also linear from 400 to 500.
  const spyCandles = {};
  for (let i = 0; i < dates.length; i++) {
    spyCandles[dates[i]] = 400 + (i / (dates.length - 1)) * 100;
  }
  // Buy 1 share of each on day 0.
  const transactions = tickers.map((t) => ({
    date: dates[0], side: 'buy', ticker: t, qty: 1, price: 100, assetClass: 'Stocks',
  }));

  const result = computePerformance({
    transactions,
    candles,
    spyCandles,
    firstDate: dates[0],
    todayDate: dates[dates.length - 1],
  });

  assert.equal(result.dates.length, 250);
  assert.equal(result.portfolio[0], 0);
  assert.equal(result.spy[0], 0);
  // End: portfolio +50%, SPY +25%
  assert.equal(result.portfolio[249], 50);
  assert.equal(result.spy[249], 25);
});

await test('missing US ticker candle: position with no price is skipped, but others still count', () => {
  const result = computePerformance({
    transactions: [
      { date: '2023-11-26', side: 'buy', ticker: 'AAPL', qty: 10, price: 180, assetClass: 'Stocks' },
      { date: '2023-11-26', side: 'buy', ticker: 'NODATA', qty: 5, price: 50, assetClass: 'Stocks' },
    ],
    candles: { AAPL: { '2023-11-26': 180, '2023-11-27': 185 } }, // NODATA missing
    spyCandles: { '2023-11-26': 450, '2023-11-27': 455 },
    firstDate: '2023-11-26',
    todayDate: '2023-11-27',
  });
  // Should still produce a chart from AAPL only
  assert.equal(result.dates.length, 2);
  assert.equal(result.portfolio[0], 0);
  assert.equal(result.portfolio[1], 2.78);
});

console.log(`\n— integration: handler with mocked fetch + redis + auth —`);

process.env.APP_PASSWORD = 'test-pwd';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://invalid-localhost:1';
process.env.TWELVEDATA_API_KEY = 'mock-key';

// Build synthetic price data for Twelve Data mock.
function makePriceMap(basePrice, startDate = '2024-01-02', days = 10) {
  const map = {};
  const start = new Date(startDate + 'T00:00:00Z');
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    map[d.toISOString().slice(0, 10)] = basePrice + i;
  }
  return map;
}

const realFetch = globalThis.fetch;

globalThis.fetch = async (url) => {
  if (/frankfurter\.dev/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ rates: {} }) };
  }
  if (/twelvedata\.com/.test(url)) {
    const match = url.match(/symbol=([^&]+)/);
    const symbolsRaw = match ? match[1] : '';
    const tickers = symbolsRaw.split(',');
    const makeValues = (basePrice) =>
      Object.entries(makePriceMap(basePrice)).map(([date, price]) => ({
        datetime: date,
        close: String(price),
      }));
    if (tickers.length === 1) {
      const ticker = tickers[0];
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', values: makeValues(ticker === 'SPY' ? 450 : 100) }),
      };
    }
    const result = {};
    for (const ticker of tickers) {
      result[ticker] = { status: 'ok', values: makeValues(ticker === 'SPY' ? 450 : 100) };
    }
    return { ok: true, status: 200, json: async () => result };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

await test('handler: returns 503 when TWELVEDATA_API_KEY not set', async () => {
  const saved = process.env.TWELVEDATA_API_KEY;
  delete process.env.TWELVEDATA_API_KEY;
  const { default: handler } = await import('../api/perf-history.js');
  const req = {
    method: 'POST',
    headers: { 'x-app-password': 'test-pwd' },
    body: { transactions: [{ date: '2024-01-02', side: 'buy', ticker: 'AAPL', qty: 10, price: 100, assetClass: 'Stocks' }] },
    query: {},
  };
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(d) { this.body = d; return this; } };
  await handler(req, res);
  process.env.TWELVEDATA_API_KEY = saved;
  assert.equal(res.statusCode, 503);
  assert.ok(/TWELVEDATA_API_KEY/.test(res.body.error));
});

await test('handler: returns non-empty series when mocked prices are provided', async () => {
  if (process.env.REDIS_URL?.startsWith('redis://invalid')) {
    console.log('       (skipped: no real REDIS_URL — algorithm tests above already validate the math)');
    return;
  }
  const { default: handler } = await import('../api/perf-history.js');
  const req = {
    method: 'POST',
    headers: { 'x-app-password': 'test-pwd' },
    body: {
      transactions: [{ date: '2024-01-02', side: 'buy', ticker: 'AAPL', qty: 10, price: 100, assetClass: 'Stocks' }],
    },
    query: { refresh: '1' },
  };
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(d) { this.body = d; return this; } };
  await handler(req, res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.dates?.length > 0, `expected non-empty dates: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.portfolio[0], 0);
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
