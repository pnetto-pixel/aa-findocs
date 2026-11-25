import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDynamicModel, evaluateDynamicBasket, optimizeDynamic, OPTIMIZER_RULES, projectFunding } from "../src/lib/dynamicRebalance.js";
import { allocationByHolding, exDellAllocation, groupExDellAllocation, holdingsForAllocationScope, rebalanceExclusionOptions, withoutAllocationCash } from "../src/lib/holdingsAllocation.js";
import { standardRebalance } from "../src/lib/standardRebalance.js";
import { washSaleWarnings } from "../src/lib/taxHarvest.js";
import { fixture, largeFixture, referenceCases } from "./fixtures/rebalance.mjs";

const modelFor = ({ holdings, settings }) => buildDynamicModel(exDellAllocation(holdings), settings);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);
const basket = result => result.orders.map(r => [r.holding.ticker, r.deltaShares, r.deltaDollars]);

function exhaustive(model, score = result => result.score) {
  let best;
  const units = model.candidates.map(() => 0);
  function step(i) {
    if (i === units.length) {
      const result = evaluateDynamicBasket(model, units);
      if (result) {
        const adjusted = score(result, units);
        if (!best || adjusted < best.score - 1e-7) best = { ...result, score: adjusted, units: [...units] };
      }
      return;
    }
    const c = model.candidates[i];
    for (let k = 0; k <= c.max; k += k === 0 ? c.min : 1) {
      units[i] = k;
      step(i + 1);
    }
  }
  step(0);
  return best;
}

test("Ex-DELL normalizes non-DELL targets, including Cash, without mutating records", () => {
  const { holdings } = fixture(referenceCases.diversification);
  const before = structuredClone(holdings);
  const scope = exDellAllocation(holdings);
  near(scope.total, 100000);
  near(scope.targetSum, 70);
  assert.ok(!scope.rows.some(r => r.id === "dell"));
  for (const grouping of [false, true]) {
    const groups = groupExDellAllocation(scope, grouping);
    near(groups.reduce((sum, v) => sum + v.target, 0), 100);
    near(groups.reduce((sum, v) => sum + v.actual, 0), 100);
    near(groups.reduce((sum, v) => sum + v.gap, 0), 0);
    assert.ok(groups.some(v => v.target === 10 && v.actual > 10));
  }
  assert.deepEqual(holdings, before);
});

test("Holdings scope displays normalized weights and keeps the saved holding objects", () => {
  const dell = { id: "dell", ticker: " dell ", type: "auto", price: 100, qty: 4, target: 70 };
  const stock = { id: "aaa", ticker: "AAA", type: "auto", price: 10, qty: 50, target: 20 };
  const cash = { id: "cash", ticker: "CASH", type: "manual", manualMode: "value", manualValue: 50, assetClass: "Cash", target: 10 };
  const holdings = [dell, stock, cash];
  assert.equal(holdingsForAllocationScope(holdings, "total"), holdings);
  const scoped = holdingsForAllocationScope(holdings, "ex-dell");
  assert.deepEqual(scoped, [stock, cash]);
  assert.equal(scoped[0], stock);

  const allocation = exDellAllocation(holdings);
  const metrics = allocationByHolding(allocation);
  near(metrics.get(stock).actual, 500 / 550 * 100);
  near(metrics.get(stock).target, 20 / 30 * 100);
  near(metrics.get(cash).target, 10 / 30 * 100);
  assert.equal(metrics.has(dell), false);

  const orders = standardRebalance({
    holdings: scoped, totalValue: allocation.total, cash: 1000, fundingSource: "new",
    isCash: h => h === cash, holdingValue: h => h.price * h.qty, targetOf: h => metrics.get(h).target,
  });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].holding, stock);
  assert.equal(stock.target, 20);
});

test("unknown amounts are distinct from known zero quantities; signed balances do not alter targets", () => {
  const holdings = [
    { id: "zero", ticker: "ZERO", qty: 0, price: null, target: 50, assetClass: "Stocks" },
    { id: "unknown", ticker: "UN", qty: 2, price: null, target: 0, assetClass: "Stocks" },
    { id: "cash", ticker: "CASH", type: "manual", manualMode: "value", assetClass: "Cash", manualValue: -10 },
    { id: "big", ticker: "BIG", qty: 10, price: 10, target: 50, assetClass: "Stocks" },
  ];
  const scope = exDellAllocation(holdings);
  assert.equal(scope.complete, false);
  assert.equal(scope.rows.find(r => r.id === "zero").value, 0);
  assert.ok(groupExDellAllocation(scope, false).every(g => g.actual === null));
  const signed = groupExDellAllocation(exDellAllocation(holdings.filter(h => h.id !== "unknown")), true);
  assert.ok(signed.find(r => r.key === "cash").actual < 0);
});

test("contribution-only recommendations ignore Cash balances, targets, and missing Cash values", () => {
  const { holdings } = fixture(referenceCases.shareTrap);
  const cash = holdings.find(h => h.assetClass === "Cash");
  const base = holdings.filter(h => h !== cash);
  const settings = { budgetCents: 100000, excludeTickers: ["LOCKED"] };
  const model = buildDynamicModel(exDellAllocation(base), settings);
  const expected = optimizeDynamic(model);
  assert.ok(expected.spent > 0 && expected.spent <= settings.budgetCents);
  for (const overrides of [
    { manualValue: 0, target: 20 },
    { manualValue: 80000, target: 50 },
    { manualValue: -1234, target: 0 },
    { manualValue: null, target: 99, manualCurrency: "BRL" },
  ]) {
    const totals = exDellAllocation([...base, { ...cash, ...overrides }]);
    const invested = withoutAllocationCash(totals);
    near(model.denom, (invested.total + settings.budgetCents / 100) * 100);
    assert.ok(totals.rows.some(h => h.classId === "cash"));
    assert.ok(!invested.rows.some(h => h.classId === "cash"));
    near(invested.rows.reduce((sum, h) => sum + h.target, 0), 1);
    assert.deepEqual(optimizeDynamic(buildDynamicModel(totals, settings)), expected);
  }
});

test("only targeted non-Cash Ex-DELL positions and their classes are listed as exclusions", () => {
  const { holdings } = fixture({
    budget: 1000, assets: [["AAA", "Stocks", 400, 100], ["BBB", "Bonds", 600, 100]],
  });
  holdings.push({ id: "untargeted", ticker: "UN", assetClass: "Alternative", type: "auto", price: 20, qty: 30, target: 0 });
  assert.deepEqual(rebalanceExclusionOptions(exDellAllocation(holdings)), {
    tickers: [["AAA", "AAA"], ["BBB", "BBB"]],
    classes: [["bonds", "Bonds"], ["stocks", "Stocks"]],
  });
});

test("existing cash and new deposits conserve the correct total and Cash", () => {
  assert.deepEqual(projectFunding(100000, 5000, 99881, "cash", 81001), { total: 100000, cash: 4189.99 });
  assert.deepEqual(projectFunding(100000, 5000, 99881, "new", 81001), { total: 100998.81, cash: 5188.8 });
  const out = fixture(referenceCases.shareTrap);
  const m = modelFor(out);
  const cash = m.funding.cash;
  const withDeposit = modelFor({ ...out, settings: { ...out.settings, fundingSource: "new" } });
  near(m.funding.total + 1000, withDeposit.funding.total);
  near(cash + 1000, withDeposit.funding.cash);
});

test("whole-share trap improves with refill and matches exhaustive search", () => {
  const model = modelFor(fixture(referenceCases.shareTrap));
  assert.equal(optimizeDynamic(model, { refill: false }).spent, 60000);
  const plan = optimizeDynamic(model);
  assert.deepEqual(basket(plan), [["B", 2, 1000]]);
  near(plan.score, exhaustive(model).score);
});

test("convex objective distributes meaningful gaps and matches exact reference", () => {
  const model = modelFor(fixture(referenceCases.diversification));
  const result = optimizeDynamic(model);
  assert.deepEqual(basket(result), [["A", 4, 400], ["B", 1, 100], ["C", 1, 100]]);
  near(result.score, exhaustive(model).score);
});

test("fixed income can deploy more than 1K; approved overshoot and cash weight reach 100% and 97.5%", () => {
  for (const [name, amount, scoreBp] of [["overshoot", 2000, 76], ["cashWeight", 1950, 242]]) {
    const model = modelFor(fixture(referenceCases[name]));
    const plan = optimizeDynamic(model);
    assert.equal(plan.spent, amount * 100);
    near(plan.score / model.bp, scoreBp);
    assert.equal(plan.orders.at(-1).deltaShares, null);
  }
});

test("preserves the exact reference comparisons for half-share, residual weight, and diversification", () => {
  const withWholeDollarBonds = name => {
    const data = fixture(referenceCases[name]);
    data.holdings.find(h => h.ticker === "F").purchaseIncrementUSD = 1;
    return modelFor(data);
  };
  const overshoot = withWholeDollarBonds("overshoot");
  const halfShareModel = { ...overshoot, candidates: overshoot.candidates.map(h => ({
    ...h, max: h.isValue ? h.max : Math.min(h.max, Math.floor((h.gap + h.unit / 2) / h.unit)),
  })) };
  assert.equal(exhaustive(halfShareModel).spent, 130000);
  assert.equal(exhaustive(overshoot).spent, 200000);

  const strong = withWholeDollarBonds("cashWeight");
  const weak = { ...strong, residual: remainder => 0.1 * remainder,
    start: { ...strong.start, score: strong.start.score - strong.residual(strong.budget) + 0.1 * strong.budget } };
  assert.equal(exhaustive(weak).spent, 170000);
  assert.equal(exhaustive(strong).spent, 195000);

  const diversity = modelFor(fixture(referenceCases.diversification));
  const maxReference = exhaustive(diversity, (plan, units) => {
    const penalties = diversity.candidates.map((h, i) => diversity.shortfall(h, units[i] * h.unit));
    const largest = Math.max(...diversity.candidates.map((h, i) => h.gap - units[i] * h.unit), 0);
    return plan.score - penalties.reduce((a, b) => a + b, 0) + largest;
  });
  assert.equal(maxReference.orders, 1);
  assert.deepEqual(maxReference.units, [6, 0, 0, 0]);
  const convex = exhaustive(diversity);
  assert.equal(convex.orders, 3);
  assert.equal(convex.spent, maxReference.spent);
});

test("approved caps consider BLK and COST above their gaps and enforce class limits", () => {
  const out = fixture({ budget: 2100, assets: [["BLK", "Stocks", 600, 1000], ["COST", "Stocks", 700, 1100], ["FILLER", "Stocks", 900, 100, true]] });
  const model = modelFor(out);
  assert.deepEqual(basket(optimizeDynamic(model)), [["BLK", 1, 1000], ["COST", 1, 1100]]);
  for (const c of model.candidates) assert.ok(c.max * c.unit - c.gap <= 50000 + 1e-7);
  const constrained = fixture({ budget: 2100, assets: [["BLK", "Stocks", 600, 1000], ["REST", "Other", 1500, 300]] });
  assert.ok(!modelFor(constrained).candidates.some(c => c.ticker === "BLK"));
});

test("multi-share blocks can open an order whose one-share score is unfavorable", () => {
  const model = modelFor(fixture({ D: 600000, budget: 80, assets: [["LOW", "Stocks", 70, 4]] }));
  assert.ok(evaluateDynamicBasket(model, [1]).score > model.start.score);
  const result = optimizeDynamic(model);
  assert.ok(result.orders[0].deltaShares > 1);
  near(result.score, exhaustive(model).score);
});

test("keeps no-purchase basket when spending makes the allocation worse", () => {
  const m = modelFor(fixture(referenceCases.cashReserve));
  assert.ok(m.candidates.length > 0);
  assert.equal(optimizeDynamic(m).spent, 0);
  assert.equal(exhaustive(m).spent, 0);
});

test("ticker, class and existing wash warning exclusions do not change valuation or gaps", () => {
  const out = fixture({ budget: 2000, assets: [["ONE", "Stocks", 800, 100], ["TWO", "BRA Stocks", 600, 100], ["THREE", "Stocks", 600, 100]] });
  const before = modelFor(out);
  const tx = [{ ticker: " three ", side: "sell", date: "2026-11-01", harvestSale: true }];
  for (const [date, found] of [["2026-11-01", []], ["2026-12-01", []], ["2026-12-02", ["THREE"]]]) {
    const after = modelFor({ ...out, settings: { ...out.settings, excludeTickers: [" one "],
      excludeClasses: ["bra stocks"], warnings: washSaleWarnings(tx, date) } });
    assert.deepEqual(after.candidates.map(c => c.ticker), found);
    assert.deepEqual(after.classes, before.classes);
    near(after.denom, before.denom);
    near(after.baseTracking, before.baseTracking);
  }
});

test("conservative quote rounding and value-only denominations are hard constraints", () => {
  const out = fixture({ budget: 1000, assets: [["ODD", "Stocks", 700, 50.004], ["FIX", "Bank Bonds", 300, null]] });
  Object.assign(out.holdings.find(h => h.ticker === "FIX"), { purchaseIncrementUSD: 50, purchaseMinimumUSD: 150 });
  const model = modelFor(out);
  const plan = optimizeDynamic(model);
  const odd = plan.orders.find(r => r.holding.ticker === "ODD");
  const fixed = plan.orders.find(r => r.holding.ticker === "FIX");
  near(odd.deltaDollars, odd.deltaShares * 50.01);
  assert.equal(fixed.deltaDollars % 50, 0);
  assert.ok(fixed.deltaDollars >= 150 && fixed.deltaDollars <= 300);
  assert.ok(plan.spent <= model.budget);
  near(plan.score, exhaustive(model).score);
});

test("five-holding reference quantifies the heuristic gap against exhaustive search", () => {
  const m = modelFor(fixture(referenceCases.breadth));
  const exact = exhaustive(m);
  const candidate = optimizeDynamic(m);
  near(exact.score / m.bp, 1019.5);
  assert.ok(candidate.score >= exact.score - 1e-7);
  assert.ok((candidate.score - exact.score) / m.bp <= 38.01);
});

test("40/60-holding synthetic portfolios stay deterministic and bounded", () => {
  const scenarios = [
    { size: 40, D: 320000, dell: 150000, budget: 5000 },
    { size: 60, D: 450000, dell: 150000, budget: 10000 },
  ];
  for (const scenario of scenarios) {
    const data = largeFixture(scenario);
    assert.equal(data.holdings.length, scenario.size);
    const model = modelFor(data);
    const baseline = optimizeDynamic(model, { refill: false });
    const times = [];
    let result;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      result = optimizeDynamic(model);
      times.push(performance.now() - start);
    }
    const shuffled = data.holdings.map((h, i) => [h, (i * 31) % data.holdings.length])
      .sort((a, b) => a[1] - b[1]).map(([h]) => h);
    assert.deepEqual(result, optimizeDynamic(modelFor({ ...data, holdings: shuffled })));
    assert.ok(result.score <= baseline.score + 1e-7);
    assert.ok(result.tracking <= model.baseTracking + 1e-7);
    assert.ok(result.spent <= model.budget);
    assert.ok(result.spent / model.budget >= 0.95);
    assert.ok(result.evaluations <= OPTIMIZER_RULES.evaluationsPerPass * (OPTIMIZER_RULES.refillOrders + 1));
    for (const order of result.orders) {
      assert.ok(order.deltaShares > 0 && Number.isInteger(order.deltaShares));
      assert.ok(!data.settings.excludeTickers.includes(order.holding.ticker));
      assert.notEqual(order.holding.assetClass, "BRA Stocks");
    }
    const median = times.sort((a, b) => a - b)[2].toFixed(2);
    console.log(`Synthetic ${scenario.size}: ${(100 * result.spent / model.budget).toFixed(2)}% used, ${result.orders.length} orders, ${result.evaluations} evaluations, ${median} ms median`);
  }
});

test("Standard retains legacy price band, high-price fallback, blank budget, and value-only sizing", () => {
  const holdings = [
    { ticker: "H", price: 1200, target: 10, value: 9900 },
    { ticker: "A", price: 340, target: 8, value: 100 },
    { ticker: "B", price: 590, target: 6, value: 130 },
    { ticker: "F", type: "manual", manualMode: "value", assetClass: "Bank Bonds", target: 6, value: 10 },
    { ticker: "CASH", price: 1, target: 8, value: 0 }
  ];
  const options = { holdings, totalValue: 100000, holdingValue: h => h.value, isCash: h => h.ticker === "CASH" };
  const get = (cash, fundingSource = "new") => basket({ orders: standardRebalance({ ...options, cash, fundingSource }) });
  assert.deepEqual(get(0), [["A", 3, 1020], ["F", null, 1000], ["B", 1, 590], ["H", 1, 1200]]);
  assert.deepEqual(get(1400), [["A", 3, 1020], ["F", null, 380]]);
  assert.deepEqual(get(1400, "cash"), [["A", 3, 1020], ["F", null, 380]]);
});
