import { test } from "node:test";
import assert from "node:assert/strict";
import { dollarsToBudgetCents } from "../src/lib/rebalanceBudget.js";
import { contributionBudgetForDate, contributionRollover, localContributionDate } from "../src/lib/contributionCapacity.js";

const snap = { planTotal: 14000, planComplete: true };
const tx = (date, price, extra) => ({ ticker: "AAA", date, qty: 1, price, side: "buy", ...extra });
const calc = (date, transactions = [], snapshot = snap, rate = 5) => contributionBudgetForDate(snapshot, transactions, rate, date);

test("current contribution budget matches the documented schedule, including days 15 and 16", () => {
  const history = [tx("2026-11-10", 6800)];
  for (const [date, entries, expected] of [
    ["2026-11-01", [], 7000], ["2026-11-10", history, 200], ["2026-11-15", history, 200],
    ["2026-11-16", history, 7200], ["2026-11-25", [...history, tx("2026-11-23", 7050)], 150],
  ]) assert.equal(calc(date, entries).currentRemaining, expected);
  assert.equal(calc("2026-11-16", history).currentTarget, 7200);
  assert.equal(calc("2026-11-16", [tx("2026-11-15", 10000)]).currentRemaining, 4000);
  assert.equal(calc("2026-11-15", [tx("2026-11-15", 7500)]).currentRemaining, 0);
  assert.equal(calc("2026-11-25", [tx("2026-11-15", 7500), tx("2026-11-24", 7200)]).currentRemaining, 0);
  assert.equal(contributionRollover(0, 0, 0, 16).currentRemaining, 0);
});

test("month and year boundary resets the period, investment, and plan source", () => {
  const entries = [tx("2026-11-30", 9500), tx("2026-11-15", 4000), tx("2026-12-01", 500)];
  assert.equal(calc("2026-11-30", entries).currentRemaining, 500);
  assert.equal(calc("2026-12-01", entries, { planTotal: 16000 }).currentRemaining, 7500);
  assert.equal(calc("2027-01-01", entries, null), null);
  assert.equal(localContributionDate(new Date(2027, 0, 1, 0, 0)), "2027-01-01");
});

test("budget recalculates with authoritative transactions, including empty histories and required FX", () => {
  assert.equal(calc("2026-11-16", null), null);
  assert.equal(calc("2026-11-16", []).currentRemaining, 14000);
  assert.equal(calc("2026-11-16", [tx("2026-11-16", 500)]).currentRemaining, 13500);
  assert.equal(calc("2026-11-16", [], { ...snap, planComplete: false }), null);
  assert.equal(calc("2026-11-16", [tx("2026-11-16", 5000, { currency: "BRL" })], snap, null), null);
  assert.equal(calc("2026-11-16", [tx("2026-11-16", 5000, { currency: "BRL" })]).currentRemaining, 13000);
});

test("contribution leftover is a hard budget in whole cents", () => {
  const contributions = calc("2026-11-10", [tx("2026-11-10", 6800)]);
  assert.equal(dollarsToBudgetCents(contributions.currentRemaining), 20000);
  assert.equal(dollarsToBudgetCents(1000.009), 100000);
  assert.equal(dollarsToBudgetCents(0), 0);
  assert.equal(dollarsToBudgetCents(Infinity), null);
});
