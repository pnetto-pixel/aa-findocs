import assert from "node:assert/strict";
import { buildAccumulatedInvestment } from "../src/lib/accumulatedInvestment.js";

const buy = (date, amount, extra = {}) => ({ date, side: "buy", ticker: "IVV", qty: 1, price: amount,
  assetClass: "Stocks", currency: "USD", ...extra });
const series = (transactions, options = {}) => buildAccumulatedInvestment(transactions, 5, {
  today: "2026-10-30", ...options,
});
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test("empty, DELL-only, malformed, future and nonfinite data do not create history", () => {
  for (const transactions of [[], [buy("2026-01-01", 100, { ticker: "dell" })],
    [buy("2026-02-30", 100)], [buy("2027-01-01", 100)], [null], [buy("2026-01-01", Infinity)]]) {
    assert.deepEqual(series(transactions), []);
  }
});
test("fills quiet months and carries cumulative capital forward through today", () => {
  const rows = series([buy("2026-01-02", 100), buy("2026-03-10", 50)]);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.value), [100, 100, 150]);
  assert.equal(rows.at(-1).value, 150);
  assert.equal(rows.at(-1).partial, true);
  assert.equal(rows.at(-1).asOf, "2026-10-30");
  assert.equal(rows[1].previous, 0);
});
test("Y/Y uses the same calendar month, while M/M uses the preceding month", () => {
  const rows = series([buy("2025-01-01", 100), buy("2026-01-01", 100), buy("2026-02-01", 100)]);
  const feb = rows.find((row) => row.label === "Feb 26");
  assert.equal(feb.yoy, 200);
  assert.equal(feb.previous, 50);
  assert.equal(rows[0].yoy, null);
  assert.equal(rows[0].previous, null);
});
test("date filters retain earlier capital and comparison bases and choose whole periods", () => {
  const tx = [buy("2025-01-01", 100), buy("2026-01-01", 100), buy("2026-02-28", 100)];
  const rows = series(tx, { fromDate: "2026-02-15", toDate: "2026-02-16" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 300);
  assert.equal(rows[0].yoy, 200);
  assert.equal(rows[0].previous, 50);
  assert.deepEqual(series(tx, { fromDate: "2026-03-01", toDate: "2026-02-01" }), []);
});
test("quarter and half balances are endpoints, never sums of monthly balances", () => {
  const tx = [buy("2025-01-01", 100), buy("2025-04-01", 100), buy("2025-07-01", 100), buy("2026-01-01", 100)];
  const quarters = series(tx, { groupBy: "Quarter" });
  assert.equal(quarters[0].value, 100);
  assert.equal(quarters[1].value, 200);
  const q1 = quarters.find((row) => row.label === "Q1 '26");
  assert.equal(q1.value, 400);
  assert.equal(q1.yoy, 300);
  assert.ok(Math.abs(q1.previous - 100 / 3) < 1e-10);
  const halves = series(tx, { groupBy: "Half" });
  assert.equal(halves[0].value, 200);
  assert.equal(halves[1].value, 300);
  assert.equal(halves[2].yoy, 100);
  assert.ok(Math.abs(halves[2].previous - 100 / 3) < 1e-10);
});
test("year has Y/Y only and all views finish with the identical accumulated balance", () => {
  const tx = [buy("2025-01-01", 100), buy("2026-01-01", 100)];
  for (const groupBy of ["Month", "Quarter", "Half", "Year"]) {
    assert.equal(series(tx, { groupBy }).at(-1).value, 200);
  }
  const years = series(tx, { groupBy: "Year" });
  assert.equal(years[1].yoy, 100);
  assert.equal(years[1].previous, null);
});
test("Bank Bonds sum the monthly Contribution History bars consistently across groupings", () => {
  const tx = [buy("2026-01-02", 1000, { assetClass: "Bank Bonds" }),
    buy("2026-01-02", 1000, { assetClass: "Bank Bonds", side: "sell" }),
    buy("2026-01-20", 500, { assetClass: "Bank Bonds" }),
    buy("2026-02-02", 500, { assetClass: "Bank Bonds", side: "sell" })];
  for (const groupBy of ["Month", "Quarter", "Half", "Year"]) {
    assert.equal(series(tx, { groupBy }).at(-1).value, 500);
  }
});
test("redemptions in another half offset buys within the month, matching Contribution History", () => {
  const tx = [buy("2026-01-02", 1000, { assetClass: "Bank Bonds" }),
    buy("2026-01-20", 1000, { assetClass: "Bank Bonds", side: "sell" }),
    buy("2026-02-20", 500, { assetClass: "Bank Bonds" })];
  const rows = series(tx);
  assert.equal(rows[0].value, 0);
  assert.equal(rows[1].value, 500);
  for (const groupBy of ["Month", "Quarter", "Half", "Year"]) {
    assert.equal(series(tx, { groupBy }).at(-1).value, 500);
  }
});
test("ordinary sales do not undo historical contributions, BRL and fees use existing conversion", () => {
  const tx = [buy("2026-01-01", 500, { currency: "BRL", fee: 10 }),
    buy("2026-02-01", 500, { side: "sell" }), buy("2026-03-01", 9999, { ticker: "DELL" })];
  assert.equal(series(tx).at(-1).value, 102);
});
test("zero baselines are unavailable, and comparisons resume once capital exists", () => {
  const rows = series([buy("2026-01-01", 0), buy("2026-02-01", 100)]);
  assert.equal(rows[1].previous, null);
  assert.equal(rows[2].previous, 0);
});
test("periods at year boundaries compare to the exact prior calendar period", () => {
  const rows = series([buy("2025-12-31", 100), buy("2026-01-01", 100)], { groupBy: "Quarter" });
  assert.equal(rows[1].previous, 100);
  assert.equal(rows[1].yoy, null);
  assert.equal(rows[0].asOf, "2025-12-31");
});
console.log(`${passed} tests passed`);
