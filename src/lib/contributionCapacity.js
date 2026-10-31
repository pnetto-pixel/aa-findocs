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
