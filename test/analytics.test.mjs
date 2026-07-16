// Run with: node test/analytics.test.mjs
// Unit tests for src/lib/analytics.js (Risk / Monthly Returns / Invested vs
// Growth cards in the Performance tab).

import { strict as assert } from 'node:assert';
import {
  wealthFromTwr,
  dailyReturns,
  annualizedVolatility,
  cagr,
  sharpeRatio,
  betaVsBenchmark,
  underwaterSeries,
  maxDrawdown,
  monthlyReturns,
  investedSeries,
  xirr,
  xirrFromTransactions,
} from '../src/lib/analytics.js';

let passed = 0;
let failed = 0;

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

function approx(actual, expected, tol = 0.05) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ~${expected}, got ${actual}`
  );
}

console.log('\n— wealth / returns —');

await test('wealthFromTwr: base 0% → 1.0, +10% → 1.1', () => {
  assert.deepEqual(wealthFromTwr([0, 10, -5]), [1, 1.1, 0.95]);
});

await test('dailyReturns compound correctly', () => {
  const r = dailyReturns([1, 1.1, 0.99]);
  approx(r[0], 0.1, 1e-9);
  approx(r[1], 0.99 / 1.1 - 1, 1e-9);
});

await test('annualizedVolatility: constant series → 0, short series → null', () => {
  approx(annualizedVolatility([0.01, 0.01, 0.01]), 0, 1e-9);
  assert.equal(annualizedVolatility([0.01]), null);
});

console.log('\n— cagr / sharpe / beta —');

await test('cagr: +10% over exactly 365 days ≈ 10%/yr', () => {
  approx(cagr(['2025-01-01', '2026-01-01'], [0, 10]), 10, 0.1);
});

await test('cagr: refuses to annualize < 90 days', () => {
  assert.equal(cagr(['2026-01-01', '2026-02-01'], [0, 5]), null);
});

await test('sharpeRatio: 12% return / 15% vol = 0.8; null on zero vol', () => {
  approx(sharpeRatio(12, 15), 0.8, 1e-9);
  assert.equal(sharpeRatio(12, 0), null);
});

await test('beta: identical series → 1; leveraged 2x series → 2', () => {
  const b = [0.01, -0.02, 0.015, 0.005, -0.01];
  approx(betaVsBenchmark(b, b), 1, 1e-9);
  approx(betaVsBenchmark(b.map((x) => 2 * x), b), 2, 1e-9);
});

console.log('\n— drawdown —');

await test('maxDrawdown: peak 20% → trough -10% = -25% dd with dates', () => {
  const dates = ['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01'];
  const twr = [0, 20, -10, 5]; // wealth 1.0, 1.2, 0.9, 1.05
  const dd = maxDrawdown(dates, twr);
  approx(dd.ddPct, (0.9 / 1.2 - 1) * 100, 0.01);
  assert.equal(dd.peakDate, '2025-02-01');
  assert.equal(dd.troughDate, '2025-03-01');
});

await test('underwaterSeries: 0 at new highs, negative below peak', () => {
  const uw = underwaterSeries(['a', 'b', 'c'], [0, 20, -10]);
  approx(uw[0].dd, 0, 1e-9);
  approx(uw[1].dd, 0, 1e-9);
  approx(uw[2].dd, (0.9 / 1.2 - 1) * 100, 0.01);
});

console.log('\n— monthly returns —');

await test('monthlyReturns: per-month compounding and YTD', () => {
  const dates = ['2026-01-10', '2026-01-31', '2026-02-15', '2026-02-28', '2026-03-31'];
  const twr = [0, 10, 10, 21, 9.9]; // wealth 1.0, 1.1, 1.1, 1.21, 1.099
  const { years, table } = monthlyReturns(dates, twr);
  assert.deepEqual(years, ['2026']);
  approx(table['2026'][1], 10, 0.01); // 1.0 → 1.1 (first month from inception)
  approx(table['2026'][2], 10, 0.01); // 1.1 → 1.21
  approx(table['2026'][3], -9.17, 0.05); // 1.21 → 1.099
  approx(table['2026'].ytd, 9.9, 0.05);
});

await test('monthlyReturns: multiple years, years sorted desc', () => {
  const dates = ['2025-12-31', '2026-01-31'];
  const twr = [0, 5];
  const { years, table } = monthlyReturns(dates, twr);
  assert.deepEqual(years, ['2026', '2025']);
  approx(table['2026'][1], 5, 0.01);
});

console.log('\n— invested series —');

const resolveAllUSD = () => 1;

await test('investedSeries: buys add, sells subtract, aligned to dates', () => {
  const txs = [
    { date: '2026-01-05', side: 'buy', qty: 10, price: 100, fee: 5 },
    { date: '2026-02-05', side: 'sell', qty: 5, price: 120, fee: 5 },
  ];
  const { series, skipped } = investedSeries(
    ['2026-01-01', '2026-01-31', '2026-02-28'],
    txs,
    resolveAllUSD
  );
  assert.deepEqual(series, [0, 1005, 1005 - 595]);
  assert.equal(skipped, 0);
});

await test('investedSeries: BRL tx without FX is skipped and counted', () => {
  const txs = [
    { date: '2026-01-05', side: 'buy', qty: 10, price: 100, currency: 'BRL' },
  ];
  const resolve = (tx) => (tx.currency === 'BRL' ? null : 1);
  const { series, skipped } = investedSeries(['2026-01-31'], txs, resolve);
  assert.deepEqual(series, [0]);
  assert.equal(skipped, 1);
});

console.log('\n— xirr —');

await test('xirr: -1000 then +1100 one year later ≈ 10%', () => {
  const r = xirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 1100 },
  ]);
  approx(r, 10, 0.1);
});

await test('xirr: two staggered deposits, known IRR', () => {
  // -1000 at t0, -1000 at 6 months, +2200 at 12 months.
  const r = xirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2025-07-01', amount: -1000 },
    { date: '2026-01-01', amount: 2200 },
  ]);
  // Sanity bounds: better than +9% (2200/2000 with all money in from t0),
  // worse than +25%.
  assert.ok(r > 9 && r < 25, `expected ~13%, got ${r}`);
});

await test('xirr: all same sign → null; < 30 days span → null', () => {
  assert.equal(
    xirr([
      { date: '2025-01-01', amount: -100 },
      { date: '2026-01-01', amount: -100 },
    ]),
    null
  );
  assert.equal(
    xirr([
      { date: '2026-01-01', amount: -100 },
      { date: '2026-01-15', amount: 110 },
    ]),
    null
  );
});

await test('xirr: losing money gives a negative rate', () => {
  const r = xirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 800 },
  ]);
  approx(r, -20, 0.5);
});

await test('xirrFromTransactions: buy + final value, investor signs handled', () => {
  const txs = [{ date: '2025-01-01', side: 'buy', qty: 10, price: 100, fee: 0 }];
  const r = xirrFromTransactions(txs, resolveAllUSD, 1100, '2026-01-01');
  approx(r, 10, 0.1);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
