// Match explicitly linked repurchases against actual net sale proceeds. Values
// are matched in the transaction currency before converting to the app's USD
// reporting currency; later purchases cannot change an earlier purchase's match.
export function harvestContributionAdjustments(transactions, usdBrlRate) {
  const rows = (transactions || []).filter(tx => tx && typeof tx.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tx.date));
  const sales = new Map();
  const netSaleUSD = new Map();
  for (const tx of rows) {
    if (tx.side !== 'sell' || tx.harvestSale !== true || !tx.id || sales.has(tx.id)) continue;
    const proceeds = Math.max(0, (Number(tx.qty) || 0) * (Number(tx.price) || 0) - (Number(tx.fee) || 0));
    sales.set(tx.id, { tx, remaining: proceeds });
    netSaleUSD.set(tx, tx.currency === 'BRL' && usdBrlRate > 0 ? proceeds / usdBrlRate : proceeds);
  }
  const deductions = new Map();
  const saleMatches = new Map();
  const buys = rows.map((tx, index) => ({ tx, index }))
    .filter(({ tx }) => tx.side === 'buy' && tx.harvestRebuySaleId)
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.index - b.index);
  for (const { tx } of buys) {
    const sale = sales.get(tx.harvestRebuySaleId);
    if (!sale || sale.tx.date > tx.date || !tx.ticker ||
        String(sale.tx.ticker || '').toUpperCase() !== String(tx.ticker).toUpperCase() ||
        (sale.tx.currency && tx.currency && sale.tx.currency !== tx.currency)) continue;
    const cost = Math.max(0, (Number(tx.qty) || 0) * (Number(tx.price) || 0) + (Number(tx.fee) || 0));
    const matched = Math.min(cost, sale.remaining);
    sale.remaining -= matched;
    const usd = tx.currency === 'BRL' && usdBrlRate > 0 ? matched / usdBrlRate : matched;
    deductions.set(tx, usd);
    const matches = saleMatches.get(sale.tx) || [];
    matches.push({ buy: tx, amount: usd });
    saleMatches.set(sale.tx, matches);
  }
  return { deductions, saleMatches, netSaleUSD };
}

// Bond sales already reduce contributions inside a bucket. Credit only the
// portion also deducted from a linked buy in that same bucket to avoid counting
// the same rollover twice; keep the established bond rule otherwise.
export function adjustedContributionAmount(tx, amount, adjustments, bucketKey, included) {
  if (tx.side === 'buy') return Math.max(0, amount - (adjustments.deductions.get(tx) || 0));
  if (tx.side !== 'sell' || tx.assetClass !== 'Bank Bonds') return amount;
  // Ordinary bond sales keep the existing gross-plus-fee convention. A
  // marked harvesting sale must use net proceeds, matching the rollover cap.
  const saleAmount = adjustments.netSaleUSD.get(tx) ?? amount;
  const credit = (adjustments.saleMatches.get(tx) || []).reduce((sum, match) =>
    sum + (included(match.buy) && bucketKey(match.buy) === bucketKey(tx) ? match.amount : 0), 0);
  return Math.max(0, saleAmount - credit);
}
