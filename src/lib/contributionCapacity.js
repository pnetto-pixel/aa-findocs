import { harvestContributionAdjustments, adjustedContributionAmount } from "./harvestContributions.js";

// Pure helpers shared by the contribution capacity snapshot table.

export function contributionTxToUSD(tx, usdBrlRate) {
  const qty = parseFloat(tx?.qty) || 0;
  const price = parseFloat(tx?.price) || 0;
  const fee = parseFloat(tx?.fee) || 0;
  const total = qty * price + fee;
  if (tx?.currency === "BRL" && usdBrlRate > 0) return total / usdBrlRate;
  return total;
}

export function computeHalfInvested(transactions, usdBrlRate, year, month) {
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const adjustments = harvestContributionAdjustments(transactions, usdBrlRate);
  const bucketKey = tx => `${tx.date.slice(0, 7)}-${Number(tx.date.slice(8, 10)) <= 15 ? 1 : 2}`;
  const included = tx => tx?.date?.slice(0, 7) === monthKey && (tx.ticker || "").toUpperCase() !== "DELL";
  const halves = [{ ordinary: 0, buys: 0, sells: 0 }, { ordinary: 0, buys: 0, sells: 0 }];
  for (const tx of transactions || []) {
    if (!included(tx)) continue;
    const day = Number(tx.date.slice(8, 10));
    if (!Number.isInteger(day) || day < 1 || day > new Date(Number(year), Number(month), 0).getDate()) continue;
    const half = halves[day <= 15 ? 0 : 1];
    const amount = adjustedContributionAmount(tx, contributionTxToUSD(tx, usdBrlRate), adjustments, bucketKey, included);
    if (tx.assetClass === "Bank Bonds") {
      if (tx.side === "buy") half.buys += amount;
      else if (tx.side === "sell") half.sells += amount;
    } else if (tx.side === "buy") half.ordinary += amount;
  }
  return { half1: halves[0].ordinary + Math.max(0, halves[0].buys - halves[0].sells),
    half2: halves[1].ordinary + Math.max(0, halves[1].buys - halves[1].sells) };
}

export function computeMonthlyInvested(transactions, usdBrlRate, month) {
  const [year, monthNumber] = month.split("-");
  const { half1, half2 } = computeHalfInvested(transactions, usdBrlRate, year, monthNumber);
  return half1 + half2;
}

// Recomputes realized amounts only for months which already have planning
// snapshots. Historical plan fields are deliberately copied unchanged and a
// transaction in a month without a snapshot never invents planning history.
export function reconcileContributionCapacityHistory(history, transactions, usdBrlRate) {
  const reconciled = {};
  for (const [month, snapshot] of Object.entries(history || {})) {
    if (!/^\d{4}-\d{2}$/.test(month) || !snapshot || typeof snapshot !== "object") {
      reconciled[month] = snapshot;
      continue;
    }
    reconciled[month] = {
      ...snapshot,
      invested: computeMonthlyInvested(transactions, usdBrlRate, month),
    };
  }
  return reconciled;
}

// Shared by the Contributions display and the Holdings purchase budget.
export function contributionRollover(planTotal, half1Auto, half2Auto, day) {
  const half1Target = planTotal / 2;
  const half1Deficit = Math.max(0, half1Target - half1Auto);
  const half2Target = half1Target + (day > 15 ? half1Deficit : 0);
  const half1Remaining = Math.max(0, half1Target - half1Auto);
  const half2Remaining = Math.max(0, half2Target - half2Auto);
  const totalInvested = half1Auto + half2Auto;
  const monthRemaining = Math.max(0, planTotal - totalInvested);
  const half = day <= 15 ? 1 : 2;
  return {
    half1Target, half2Target, half1Deficit, half1Remaining, half2Remaining, totalInvested, monthRemaining, half,
    currentTarget: half === 1 ? half1Target : half2Target,
    currentInvested: half === 1 ? half1Auto : half2Auto,
    currentRemaining: Math.min(monthRemaining, half === 1 ? half1Remaining : half2Remaining),
  };
}

export function localContributionDate(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(x => String(x).padStart(2, "0")).join("-");
}

// Holdings only consumes a completed server snapshot for the current month.
export function contributionBudgetForDate(snapshot, transactions, usdBrlRate, date) {
  if (!snapshot || snapshot.planComplete === false || !Number.isFinite(snapshot.planTotal) ||
      snapshot.planTotal < 0 || !Array.isArray(transactions)) return null;
  const month = date.slice(0, 7);
  if (!(usdBrlRate > 0) && transactions.some(t => t?.date?.slice(0, 7) === month &&
      t.currency === "BRL" && (t.side === "buy" || t.assetClass === "Bank Bonds") &&
      String(t.ticker || "").trim().toUpperCase() !== "DELL")) return null;
  const [year, monthNumber, day] = date.split("-").map(Number);
  const { half1, half2 } = computeHalfInvested(transactions, usdBrlRate, year, monthNumber);
  return { ...contributionRollover(snapshot.planTotal, half1, half2, day), monthlyTarget: snapshot.planTotal, month };
}
