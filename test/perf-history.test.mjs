// Run with: node test/perf-history.test.mjs
// Validates the perf-history algorithm without hitting external APIs.

import { strict as assert } from 'node:assert';
import { computePerformance } from '../api/perf-history.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

console.log('\n— computePerformance —');

test('happy path: single AAPL buy, 3 days of candles', () => {
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

test('excludes non-whitelisted classes', () => {
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

test('includes all four whitelisted classes', () => {
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

test('sell reduces position', () => {
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
  // Day 0: 10*180 = 1800
  // Day 1: 5 left * 185 = 925
  // Day 2: 5 * 200 = 1000
  assert.deepEqual(result.portfolio, [0, -48.61, -44.44]);
});

test('BRL ticker converted to USD via FX', () => {
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

test('carries forward prices over weekends', () => {
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

test('skips days with no SPY data', () => {
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

test('large portfolio: 50 tickers × 250 days returns sensible series', () => {
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

test('missing US ticker candle: position with no price is skipped, but others still count', () => {
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

// Build synthetic price data (replaces Stooq/Yahoo mocks — prices now come from the browser).
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
  // Frankfurter FX: no BRL tickers in these tests → return empty
  if (/frankfurter\.dev/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ rates: {} }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

test('handler: returns needsPrices on first call (no priceData)', async () => {
  if (process.env.REDIS_URL?.startsWith('redis://invalid')) {
    console.log('       (skipped: no real REDIS_URL — algorithm tests above already validate the math)');
    return;
  }
  const { default: handler } = await import('../api/perf-history.js');
  const req = {
    method: 'POST',
    headers: { 'x-app-password': 'test-pwd' },
    body: { transactions: [{ date: '2024-01-01', side: 'buy', ticker: 'AAPL', qty: 10, price: 100, assetClass: 'Stocks' }] },
    query: { refresh: '1' },
  };
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(d) { this.body = d; return this; } };
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.needsPrices, true);
  assert.ok(Array.isArray(res.body.tickers));
  assert.ok(res.body.tickers.includes('SPY'));
  assert.ok(res.body.tickers.includes('AAPL'));
});

test('handler: returns non-empty series when priceData is provided', async () => {
  if (process.env.REDIS_URL?.startsWith('redis://invalid')) {
    console.log('       (skipped: no real REDIS_URL — algorithm tests above already validate the math)');
    return;
  }
  const { default: handler } = await import('../api/perf-history.js');
  const priceData = {
    SPY: makePriceMap(450),
    AAPL: makePriceMap(100),
  };
  const req = {
    method: 'POST',
    headers: { 'x-app-password': 'test-pwd' },
    body: {
      transactions: [{ date: '2024-01-02', side: 'buy', ticker: 'AAPL', qty: 10, price: 100, assetClass: 'Stocks' }],
      priceData,
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
