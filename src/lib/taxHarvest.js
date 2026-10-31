import { currencyForAssetClass } from "./parsing.js";

// Tax harvesting estimates only use the transactions known to the app.
// harvestLots on a sale records the actual shares sold from each buy lot:
// [{ buyId, qty }]. Unallocated or invalid sales make the ticker uncertain.
const DAY_MS = 86400000;
const EPSILON = 1e-8;

function dayNumber(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return ms / DAY_MS;
}

export function addCalendarDays(date, days) {
  const day = dayNumber(date);
  return day == null ? null : new Date((day + days) * DAY_MS).toISOString().slice(0, 10);
}

function tickerOf(tx) {
  return String(tx?.ticker || '').trim().toUpperCase();
}

// For each ticker with a manually marked sale, report the latest applicable
// window. The sale date and all 30 following calendar days are in the window.
export function washSaleWarnings(transactions, asOf) {
  const today = dayNumber(asOf);
  const result = {};
  if (today == null) return result;
  for (const tx of transactions || []) {
    const date = dayNumber(tx.date);
    const ticker = tickerOf(tx);
    if (tx.side !== 'sell' || !tx.harvestSale || !ticker || date == null || today < date || today > date + 30) continue;
    if (!result[ticker] || tx.date > result[ticker].saleDate) {
      result[ticker] = { saleDate: tx.date, safeDate: addCalendarDays(tx.date, 31) };
    }
  }
  return result;
}

// pricesByTicker holds { price, currency } quotes. Missing quotes are never treated
// as zero. Returns no candidate for an uncertain ticker: historical sales may
// have consumed any of its buys. Amounts include buy fees in the cost basis.
export function buildHarvestLots(transactions, pricesByTicker, asOf) {
  const today = dayNumber(asOf);
  if (today == null) return { candidates: [], uncertainTickers: [] };
  const uncertain = new Set();
  const rows = (transactions || []).filter(tx => {
    if (!tx || !tickerOf(tx)) return false;
    const date = dayNumber(tx.date);
    if (date == null) {
      // An undated buy or sale cannot safely be placed in the lot history.
      if (tx.side === 'buy' || tx.side === 'sell') uncertain.add(tickerOf(tx));
      return false;
    }
    return date <= today;
  });
  // A ticker alone cannot safely identify its currency. Reject incomplete or
  // mixed histories and currency-mismatched quotes rather than comparing costs
  // and prices in different units.
  const currencies = new Map();
  for (const tx of rows) {
    if (tx.side !== 'buy' && tx.side !== 'sell') continue;
    const ticker = tickerOf(tx);
    const currency = String(tx.currency || currencyForAssetClass(tx.assetClass) || '').trim().toUpperCase();
    if (currency !== 'USD' && currency !== 'BRL') { uncertain.add(ticker); continue; }
    if (currencies.has(ticker) && currencies.get(ticker) !== currency) uncertain.add(ticker);
    else currencies.set(ticker, currency);
  }
  for (const [ticker, currency] of currencies) {
    const quote = pricesByTicker?.[ticker];
    if (quote != null && (typeof quote !== 'object' || String(quote.currency || '').trim().toUpperCase() !== currency)) uncertain.add(ticker);
  }
  const lots = new Map();
  const buys = [];
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1));
  for (const tx of sorted) {
    const ticker = tickerOf(tx);
    const qty = Number(tx.qty);
    if (tx.side === 'buy') {
      if (!tx.id || !(qty > 0) || !Number.isFinite(qty) || lots.has(tx.id)) {
        uncertain.add(ticker);
        continue;
      }
      const lot = { tx, ticker, qty, remaining: qty };
      lots.set(tx.id, lot);
      buys.push(lot);
    } else if (tx.side === 'sell') {
      if (!(qty > 0) || !Number.isFinite(qty) || !Array.isArray(tx.harvestLots)) {
        uncertain.add(ticker);
        continue;
      }
      let total = 0;
      const allocations = new Map();
      let valid = true;
      for (const entry of tx.harvestLots) {
        const lot = lots.get(entry?.buyId);
        const amount = Number(entry?.qty);
        if (!lot || lot.ticker !== ticker || !(amount > 0) || !Number.isFinite(amount)) {
          valid = false;
          continue;
        }
        total += amount;
        allocations.set(lot, (allocations.get(lot) || 0) + amount);
      }
      if (Math.abs(total - qty) > EPSILON || [...allocations].some(([lot, amount]) => amount > lot.remaining + EPSILON)) valid = false;
      if (!valid) {
        uncertain.add(ticker);
        continue;
      }
      for (const [lot, amount] of allocations) lot.remaining = Math.max(0, lot.remaining - amount);
    }
  }

  const candidates = [];
  for (const lot of buys) {
    if (uncertain.has(lot.ticker) || lot.remaining <= EPSILON) continue;
    const quote = pricesByTicker?.[lot.ticker];
    const currentPrice = quote?.price == null || quote.price === '' ? NaN : Number(quote.price);
    const price = lot.tx.price == null || lot.tx.price === '' ? NaN : Number(lot.tx.price);
    const fee = Number(lot.tx.fee || 0);
    // A zero quote is also the app's common placeholder for a missing price.
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(price) || price < 0 || !Number.isFinite(fee) || fee < 0) continue;
    const costPerShare = price + fee / lot.qty;
    if (!(currentPrice < costPerShare)) continue;
    candidates.push({
      buyId: lot.tx.id, ticker: lot.ticker, date: lot.tx.date, qty: lot.remaining,
      price, costPerShare, currentPrice, loss: (costPerShare - currentPrice) * lot.remaining,
      currency: currencies.get(lot.ticker),
    });
  }
  // The card models selling all known loss lots for each ticker today. Shares
  // in those lots (and shares already sold) cannot also be replacement shares.
  // Purchases still held in non-candidate lots remain potential replacements.
  // This is not a tax determination: outside accounts, DRIPs and identical
  // securities are not necessarily present in the transaction history.
  const soldLotIds = new Set(candidates.map(candidate => candidate.buyId));
  for (const candidate of candidates) {
    const priorBuys = buys.filter(other => other.ticker === candidate.ticker &&
      other.remaining > EPSILON && !soldLotIds.has(other.tx.id) &&
      dayNumber(other.tx.date) >= today - 30)
      .map(other => ({ date: other.tx.date, qty: other.remaining }))
      .sort((a, b) => b.date.localeCompare(a.date));
    candidate.priorBuys = priorBuys;
    candidate.clearDate = priorBuys.length ? addCalendarDays(priorBuys[0].date, 31) : null;
  }
  candidates.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.date.localeCompare(b.date));
  return { candidates, uncertainTickers: [...uncertain].sort() };
}
