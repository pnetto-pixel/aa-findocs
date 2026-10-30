// Run with: node test/performance-scope.test.mjs
import { strict as assert } from "node:assert";
import { isDellExcluded, includesPerformanceTicker } from "../src/lib/performanceScope.js";
import { computePerformance } from "../api/perf-history.js";
import { investedSeries } from "../src/lib/analytics.js";

const txs = [
  { ticker: "DELL", date: "2026-01-01", side: "buy", qty: 10, price: 100, assetClass: "Stocks" },
  { ticker: "AAPL", date: "2026-01-01", side: "buy", qty: 1, price: 100, assetClass: "Stocks" },
];
const dates = ["2026-01-01", "2026-01-02", "2026-01-03"];
const compute = (transactions) => computePerformance({
  transactions,
  firstDate: dates[0],
  todayDate: dates[2],
  candles: {
    DELL: { [dates[0]]: 100, [dates[1]]: 200, [dates[2]]: 300 },
    AAPL: { [dates[0]]: 100, [dates[1]]: 110, [dates[2]]: 121 },
  },
  spyCandles: { [dates[0]]: 100, [dates[1]]: 101, [dates[2]]: 102 },
});

// Default preserves all positions. A dedicated exclusion also works when the
// ticker chip is empty (its established meaning is "all", not "none").
assert.equal(isDellExcluded(true, new Set()), false);
assert.equal(isDellExcluded(true, new Set(["DELL", "AAPL"])), false);
const excluded = isDellExcluded(false, new Set());
assert.equal(excluded, true);
const scoped = txs.filter((tx) => includesPerformanceTicker(tx.ticker, excluded));
assert.deepEqual(scoped.map((tx) => tx.ticker), ["AAPL"]);
const withoutDell = compute(scoped);
assert.deepEqual(withoutDell.portfolio, [0, 10, 21]);
assert.deepEqual(withoutDell.portfolioUSD, [100, 110, 121]);
assert.deepEqual(investedSeries(dates, scoped, () => 1).series, [100, 100, 100]);
assert.notDeepEqual(compute(txs).portfolio, withoutDell.portfolio);
assert.deepEqual(compute(txs).spy, withoutDell.spy);

// Unchecking Dell in the existing ticker chip propagates the same exclusion;
// selecting Dell locally in Composition cannot override it.
const chipExcluded = isDellExcluded(true, new Set(["AAPL"]));
assert.equal(chipExcluded, true);
assert.equal(includesPerformanceTicker("DELL", chipExcluded), false);
assert.equal(isDellExcluded(false, new Set(["DELL"])), true);
assert.equal(includesPerformanceTicker("dell", true), false);
assert.equal(includesPerformanceTicker(" Dell ", true), false);
assert.equal(includesPerformanceTicker("DELLX", true), true);
assert.equal(includesPerformanceTicker(undefined, true), true);
assert.equal(includesPerformanceTicker(null, true), true);
assert.equal(includesPerformanceTicker("DELL", false), true);

// A Dell-only portfolio must resolve to an empty response, rather than
// silently restoring Dell because an include-filter became empty.
const dellOnly = [txs[0]].filter((tx) => includesPerformanceTicker(tx.ticker, true));
assert.deepEqual(dellOnly, []);
assert.deepEqual(compute(dellOnly).dates, []);
assert.equal(compute(dellOnly).meta.reason, "no-eligible-transactions");

// The same predicate removes gross dividends and withheld tax while leaving
// unrelated income and untickered records alone.
const income = [
  { ticker: "DELL", totalReceived: 5 },
  { ticker: "dell", totalReceived: -1 },
  { ticker: "AAPL", totalReceived: 2 },
];
assert.equal(income.filter((e) => includesPerformanceTicker(e.ticker, true))
  .reduce((sum, e) => sum + e.totalReceived, 0), 2);
assert.deepEqual(txs.map((tx) => tx.ticker), ["DELL", "AAPL"]);
console.log("Performance Dell scope: all checks passed");
