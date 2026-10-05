import assert from "node:assert/strict";
import {
  computeMonthlyInvested,
  reconcileContributionCapacityHistory,
} from "../src/lib/contributionCapacity.js";

const history = {
  "2026-09": {
    monthlyFixed: 4400,
    dividends: 560.63,
    dellSale: 12120.25,
    extras: [],
    planTotal: 17080.88,
    invested: 16132.24,
    savedAt: "2026-10-01T00:00:00.000Z",
  },
};

const transactions = [
  { date: "2026-09-02", side: "buy", ticker: "VOO", assetClass: "Stocks", qty: 1, price: 16132.24, fee: 0, currency: "USD" },
  { date: "2026-09-30", side: "buy", ticker: "BOND1", assetClass: "Bank Bonds", qty: 1, price: 995, fee: 0, currency: "USD" },
  { date: "2026-08-20", side: "buy", ticker: "LATE", assetClass: "Stocks", qty: 1, price: 500, fee: 0, currency: "USD" },
];

const reconciled = reconcileContributionCapacityHistory(history, transactions, 5);
assert.equal(Number(reconciled["2026-09"].invested.toFixed(2)), 17127.24);
assert.equal(reconciled["2026-09"].planTotal, 17080.88);
assert.equal(reconciled["2026-09"].monthlyFixed, 4400);
assert.equal(reconciled["2026-09"].savedAt, history["2026-09"].savedAt);
assert.equal(reconciled["2026-08"], undefined);
assert.notEqual(reconciled["2026-09"], history["2026-09"]);

assert.equal(computeMonthlyInvested([
  { date: "2026-09-01", side: "buy", ticker: "DELL", assetClass: "Stocks", qty: 1, price: 1000, currency: "USD" },
  { date: "2026-09-03", side: "buy", ticker: "BOND", assetClass: "Bank Bonds", qty: 1, price: 2000, currency: "USD" },
  { date: "2026-09-29", side: "sell", ticker: "BOND", assetClass: "Bank Bonds", qty: 1, price: 1500, currency: "USD" },
  { date: "2026-09-30", side: "buy", ticker: "BR", assetClass: "BRA Stocks", qty: 10, price: 50, fee: 5, currency: "BRL" },
], 5, "2026-09"), 2101);

console.log("contribution capacity reconciliation tests passed.");
