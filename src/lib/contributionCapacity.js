// Pure helpers shared by the contribution capacity snapshot table.

export function contributionTxToUSD(tx, usdBrlRate) {
  const qty = parseFloat(tx?.qty) || 0;
  const price = parseFloat(tx?.price) || 0;
  const fee = parseFloat(tx?.fee) || 0;
  const total = qty * price + fee;
  if (tx?.currency === "BRL" && usdBrlRate > 0) return total / usdBrlRate;
  return total;
}

export function computeMonthlyInvested(transactions, usdBrlRate, month) {
  let invested = 0;
  let bondBuysFirstHalf = 0;
  let bondRedemptionsFirstHalf = 0;
  let bondBuysSecondHalf = 0;
  let bondRedemptionsSecondHalf = 0;

  for (const tx of transactions || []) {
    if (!tx?.date || tx.date.slice(0, 7) !== month) continue;
    if ((tx.ticker || "").toUpperCase() === "DELL") continue;

    const amount = contributionTxToUSD(tx, usdBrlRate);
    if (tx.assetClass === "Bank Bonds") {
      const day = parseInt(tx.date.slice(8, 10), 10);
      const firstHalf = day >= 1 && day <= 15;
      if (tx.side === "buy") {
        if (firstHalf) bondBuysFirstHalf += amount;
        else bondBuysSecondHalf += amount;
      } else if (tx.side === "sell") {
        if (firstHalf) bondRedemptionsFirstHalf += amount;
        else bondRedemptionsSecondHalf += amount;
      }
    } else if (tx.side === "buy") {
      invested += amount;
    }
  }

  return invested
    + Math.max(0, bondBuysFirstHalf - bondRedemptionsFirstHalf)
    + Math.max(0, bondBuysSecondHalf - bondRedemptionsSecondHalf);
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
