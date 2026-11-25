import { classKey, isValueHolding, tickerKey } from "./holdingsAllocation.js";
import { dollarsToBudgetCents } from "./rebalanceBudget.js";

export const OPTIMIZER_RULES = Object.freeze({
  classWeight: 3, holdingWeight: 1, shortfallWeight: 0.5, shortfallBreaks: Object.freeze([1 / 3, 2 / 3]),
  residualWeight: 1, excessResidualWeight: 2, residualFraction: 0.05, orderPenaltyBp: 1,
  holdingOvershootBp: 50, holdingOvershootBudgetFraction: 0.25,
  classOvershootBp: 25, classOvershootBudgetFraction: 0.15,
  refillOrders: 4, evaluationsPerPass: 6000, scoreTolerance: 1e-7,
});

const valueClasses = new Set(["bank bonds", "bra fixed income"]);
const eps = OPTIMIZER_RULES.scoreTolerance;
const ceilCents = value => Math.ceil(value * 100 - 1e-8);
const compareKey = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function projectFunding(total, cash, budgetCents, fundingSource, spentCents = 0) {
  const deposit = fundingSource === "new" ? budgetCents : 0;
  return { total: total + deposit / 100, cash: cash + (deposit - spentCents) / 100 };
}

// A pure model in cents. Score comparisons use the dollar-equivalent of basis
// points (one basis point is D/10,000 cents); order costs remain exact cents.
export function buildDynamicModel(allocation, settings) {
  const rules = OPTIMIZER_RULES;
  const { budgetCents: budget, fundingSource, cashAccountId, excludeTickers = [], excludeClasses = [], warnings = {} } = settings;
  if (!allocation.complete || !allocation.targetSum || !Number.isSafeInteger(budget) || budget < 0) return null;
  const accounts = allocation.rows.filter(row => row.cash && isValueHolding(row.holding) &&
    (!row.holding.manualCurrency || row.holding.manualCurrency === "USD"));
  const account = accounts.find(row => row.id === cashAccountId) ?? (!cashAccountId && accounts.length === 1 ? accounts[0] : null);
  if (fundingSource === "cash" && budget > 0 && (!account || budget > dollarsToBudgetCents(account.value))) return null;
  const cash = allocation.rows.reduce((sum, h) => sum + (h.cash ? h.value : 0), 0);
  const funding = projectFunding(allocation.total, cash, budget, fundingSource);
  if (!(funding.total > 0) || !Number.isFinite(funding.total)) return null;
  const denom = funding.total * 100;
  const bp = denom / 10000;
  const groups = new Map();
  const cashGroup = { key: "cash", label: "Cash", gap: -(funding.cash - cash) * 100 };
  groups.set("cash", cashGroup);
  const skipTickers = new Set(excludeTickers.map(tickerKey));
  const skipClasses = new Set(excludeClasses.map(classKey));
  const rows = [...allocation.rows].sort((a, b) => compareKey(a.ticker, b.ticker) || compareKey(a.id, b.id)).map(row => {
    const gap = row.target * denom - row.value * 100;
    if (!groups.has(row.classId)) groups.set(row.classId, { key: row.classId, label: row.assetClass, gap: 0 });
    groups.get(row.classId).gap += gap;
    return { ...row, gap };
  });
  const classes = [...groups.values()].sort((a, b) => compareKey(a.key, b.key));
  const classLimit = new Map(classes.map(c => [c.key, Math.floor(Math.max(0, c.gap) +
    Math.min(rules.classOvershootBp * bp, rules.classOvershootBudgetFraction * budget) + eps)]));
  const candidates = [];
  for (let i = 0; i < rows.length; i++) {
    const h = rows[i];
    if (h.cash || h.fxMissing || h.gap <= eps || h.target <= 0 || skipTickers.has(h.ticker) ||
        skipClasses.has(h.classId) || Object.hasOwn(warnings, h.ticker)) continue;
    const isValue = isValueHolding(h.holding);
    if (isValue ? !valueClasses.has(h.classId) : !h.sharePrice || valueClasses.has(h.classId)) continue;
    const denomination = Number(h.holding.purchaseIncrementUSD);
    const minAmount = Number(h.holding.purchaseMinimumUSD);
    const unit = isValue ? (denomination > 0 ? ceilCents(denomination) : 1) : ceilCents(h.sharePrice);
    if (!Number.isSafeInteger(unit) || unit <= 0) continue;
    const min = isValue && minAmount > 0 ? Math.max(1, Math.ceil(ceilCents(minAmount) / unit)) : 1;
    const over = isValue ? 0 : Math.min(rules.holdingOvershootBp * bp, rules.holdingOvershootBudgetFraction * budget);
    const max = Math.floor((Math.min(h.gap + over, classLimit.get(h.classId), budget) + eps) / unit);
    if (Number.isSafeInteger(min) && max >= min) candidates.push({ ...h, row: i, isValue, unit, min, max });
  }
  const startClass = classes.reduce((s, g) => s + Math.abs(g.gap), 0);
  const startHolding = rows.reduce((s, h) => s + (h.cash ? 0 : Math.abs(h.gap)), 0);
  const byClass = new Map(classes.map(g => [g.key, g.gap]));
  const holdingWeight = rules.holdingWeight;
  const classWeight = rules.classWeight;
  const baseTracking = classWeight * startClass + holdingWeight * startHolding;
  const shortfall = (h, spend) => rules.shortfallBreaks.reduce((sum, part) =>
    sum + rules.shortfallWeight * Math.max(0, h.gap * (1 - part) - spend), 0);
  const residual = amount => rules.residualWeight * amount +
    rules.excessResidualWeight * Math.max(0, amount - rules.residualFraction * budget);
  const startShortfall = candidates.reduce((sum, h) => sum + shortfall(h, 0), 0);
  const start = { score: baseTracking + startShortfall + residual(budget), tracking: baseTracking,
    classError: startClass, holdingError: startHolding, orders: 0, spent: 0 };
  const calculations = { rows, classes, candidates, budget, denom, bp, funding, cash, fundingSource, cashAccountId, cashGroup, classLimit, byClass,
    start, baseTracking, holdingWeight, classWeight, shortfall, residual };
  return calculations;
}

function changes(model, current, c, oldSpend, extra, priorClassSpend) {
  const gap = model.byClass.get(c.classId) - priorClassSpend;
  const cg = model.cashGroup.gap + current.spent;
  const classDelta = Math.abs(gap - extra) - Math.abs(gap) + Math.abs(cg + extra) - Math.abs(cg);
  const holdingDelta = Math.abs(c.gap - oldSpend - extra) - Math.abs(c.gap - oldSpend);
  const trackDelta = classDelta * model.classWeight + holdingDelta * model.holdingWeight;
  const orderDelta = oldSpend ? 0 : 1;
  const spent = current.spent + extra;
  return {
    tracking: current.tracking + trackDelta,
    classError: current.classError + classDelta,
    holdingError: current.holdingError + holdingDelta,
    orders: current.orders + orderDelta,
    spent,
    score: current.score + trackDelta + model.shortfall(c, oldSpend + extra) - model.shortfall(c, oldSpend) +
      model.residual(model.budget - spent) - model.residual(model.budget - current.spent) +
      orderDelta * OPTIMIZER_RULES.orderPenaltyBp * model.bp,
  };
}

function compareBaskets(a, b) {
  for (const x of [a.score - b.score, a.classError - b.classError, a.holdingError - b.holdingError,
    b.spent - a.spent, a.orders - b.orders]) if (Math.abs(x) > eps) return Math.sign(x);
  return 0;
}

// Include both integer neighbors of every kink. Between kinks the score and
// the average benefit per dollar are monotone or flat, so whole-share blocks
// can open an order even when its first share alone cannot pay the order cost.
function moveSizes(model, h, oldUnits, state, classSpent) {
  const { unit } = h;
  const upper = Math.min(h.max - oldUnits, Math.floor((model.budget - state.spent) / unit),
    Math.floor((model.classLimit.get(h.classId) - classSpent) / unit));
  const lower = oldUnits ? 1 : h.min;
  if (upper < lower) return [];
  const old = oldUnits * unit;
  const sizes = new Set([lower, upper]);
  const points = [
    h.gap - old, model.byClass.get(h.classId) - classSpent, -model.cashGroup.gap - state.spent,
    (1 - OPTIMIZER_RULES.residualFraction) * model.budget - state.spent,
    ...OPTIMIZER_RULES.shortfallBreaks.map(part => (1 - part) * h.gap - old),
  ];
  for (const point of points) {
    const n = Math.floor(point / unit);
    if (n >= lower && n <= upper) sizes.add(n);
    if (n + 1 >= lower && n + 1 <= upper) sizes.add(n + 1);
  }
  return [...sizes].sort((a, b) => a - b);
}

function pass(model, seed, excludeIndex = -1) {
  const units = seed ? [...seed] : model.candidates.map(() => 0);
  const classSpent = new Map();
  let state = model.start;
  let evaluations = 0;
  for (let i = 0; i < units.length; i++) {
    if (!units[i]) continue;
    const h = model.candidates[i];
    const delta = units[i] * h.unit;
    const prior = classSpent.get(h.classId) || 0;
    state = changes(model, state, h, 0, delta, prior);
    classSpent.set(h.classId, prior + delta);
  }
  const limit = OPTIMIZER_RULES.evaluationsPerPass;
  while (evaluations < limit) {
    let best = null;
    for (let i = 0; i < units.length && evaluations < limit; i++) {
      if (i === excludeIndex) continue;
      const h = model.candidates[i];
      const prior = classSpent.get(h.classId) || 0;
      const sizes = moveSizes(model, h, units[i], state, prior);
      const evaluate = n => {
        evaluations++;
        return changes(model, state, h, units[i] * h.unit, n * h.unit, prior);
      };
      // The baseline guard can cut a linear segment before its endpoint.
      if (sizes.length && evaluations < limit) {
        let hi = sizes.at(-1);
        const endpoint = evaluate(hi);
        if (endpoint.tracking > model.baseTracking + eps && state.tracking <= model.baseTracking + eps) {
          let lo = 0;
          while (hi - lo > 1 && evaluations < limit) {
            const mid = Math.floor((hi + lo) / 2);
            if (evaluate(mid).tracking <= model.baseTracking + eps) lo = mid;
            else hi = mid;
          }
          if (lo >= (units[i] ? 1 : h.min) && !sizes.includes(lo)) sizes.push(lo);
        }
      }
      for (const n of sizes) {
        if (evaluations >= limit) break;
        const delta = n * h.unit;
        const next = evaluate(n);
        const gain = state.score - next.score;
        if (next.tracking > Math.max(model.baseTracking, state.tracking) + eps || gain <= eps) continue;
        const rate = gain / delta;
        if (!best || rate > best.rate + eps ||
            (Math.abs(rate - best.rate) <= eps && compareBaskets(next, best.next) < 0)) {
          best = { i, n, delta, rate, next, classId: h.classId };
        }
      }
    }
    if (!best) break;
    units[best.i] += best.n;
    classSpent.set(best.classId, (classSpent.get(best.classId) || 0) + best.delta);
    state = best.next;
  }
  return { ...state, units, evaluations, limited: evaluations === limit };
}

// Also used by the exact enumeration oracle for tiny synthetic portfolios.
export function evaluateDynamicBasket(model, units) {
  if (units.length !== model.candidates.length) return null;
  let current = model.start;
  const classSpent = new Map();
  for (let i = 0; i < units.length; i++) {
    const n = units[i];
    if (n === 0) continue;
    const h = model.candidates[i];
    const cost = n * h.unit;
    const prior = classSpent.get(h.classId) || 0;
    if (!Number.isInteger(n) || n < h.min || n > h.max || cost > model.budget - current.spent ||
        prior + cost > model.classLimit.get(h.classId)) return null;
    current = changes(model, current, h, 0, cost, prior);
    classSpent.set(h.classId, prior + cost);
  }
  return current.tracking <= model.baseTracking + eps ? current : null;
}

export function optimizeDynamic(model, { refill = true } = {}) {
  const first = pass(model);
  let winner = first;
  let evaluations = first.evaluations;
  let limited = first.limited;
  const biggest = first.units.map((n, i) => [i, n * model.candidates[i].unit])
    .filter(([, spent]) => spent > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (refill) for (const [i] of biggest.slice(0, OPTIMIZER_RULES.refillOrders)) {
    const seed = [...first.units];
    seed[i] = 0;
    const alternative = pass(model, seed, i);
    evaluations += alternative.evaluations;
    limited ||= alternative.limited;
    const valid = evaluateDynamicBasket(model, alternative.units);
    if (valid && compareBaskets(valid, winner) < 0) winner = { ...alternative, ...valid };
  }
  const spentById = new Map();
  const orders = [];
  for (let i = 0; i < winner.units.length; i++) {
    const qty = winner.units[i];
    if (!qty) continue;
    const h = model.candidates[i];
    const cost = qty * h.unit;
    spentById.set(h.id, cost);
    orders.push({ holding: h.holding, deltaShares: h.isValue ? null : qty, deltaDollars: cost / 100 });
  }
  const exposure = (before, after) => ({ before: -before / model.bp / 100, after: -after / model.bp / 100 });
  const deposit = model.fundingSource === "new" ? model.budget : 0;
  const cashRows = model.rows.filter(h => h.cash);
  const cashRow = cashRows.find(h => h.id === model.cashAccountId) ?? (cashRows.length === 1 ? cashRows[0] : null);
  const holdings = model.rows.map(h => {
    const used = h.cash ? h.id === cashRow?.id : false;
    const before = h.gap - (used ? deposit : 0);
    const after = before + (used ? winner.spent : -(spentById.get(h.id) || 0));
    return { id: h.id, name: h.cash ? h.name : h.ticker || h.name, ...exposure(before, after) };
  });
  if (!cashRow && deposit) holdings.push({
    id: "contribution-cash-preview", name: "Contribution Cash", ...exposure(-deposit, winner.spent - deposit),
  });
  const classGaps = model.classes.map(c => {
    const spend = c.key === "cash" ? -winner.spent : model.rows.reduce((sum, h) =>
      sum + (h.classId === c.key ? spentById.get(h.id) || 0 : 0), 0);
    return { id: c.key, name: c.label, ...exposure(c.gap, c.gap - spend) };
  });
  return { ...winner, orders, evaluations, limited, leftover: (model.budget - winner.spent) / 100,
    projectedCash: model.cash + (deposit - winner.spent) / 100, gaps: { class: classGaps, holding: holdings } };
}
