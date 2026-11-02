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
  if (today == null) return { candidates: [], openLots: [], uncertainTickers: [], incompleteTickers: [], uncertaintyReasons: {} };
  const uncertain = new Set();
  const uncertaintyReasons = {};
  function markUncertain(ticker, reason) {
    uncertain.add(ticker);
    const reasons = uncertaintyReasons[ticker] ||= [];
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  const rows = (transactions || []).filter(tx => {
    if (!tx || !tickerOf(tx)) return false;
    const date = dayNumber(tx.date);
    if (date == null) {
      // An undated buy or sale cannot safely be placed in the lot history.
      if (tx.side === 'buy' || tx.side === 'sell') markUncertain(tickerOf(tx), "invalid-date");
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
    if (currency !== 'USD' && currency !== 'BRL') { markUncertain(ticker, 'currency'); continue; }
    if (currencies.has(ticker) && currencies.get(ticker) !== currency) markUncertain(ticker, 'currency');
    else currencies.set(ticker, currency);
  }
  for (const [ticker, currency] of currencies) {
    const quote = pricesByTicker?.[ticker];
    if (quote != null && (typeof quote !== 'object' || String(quote.currency || '').trim().toUpperCase() !== currency)) markUncertain(ticker, 'currency');
  }
  const lots = new Map();
  const buys = [];
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1));
  for (const tx of sorted) {
    const ticker = tickerOf(tx);
    const qty = Number(tx.qty);
    if (tx.side === 'buy') {
      if (!tx.id || !(qty > 0) || !Number.isFinite(qty) || lots.has(tx.id)) {
        markUncertain(ticker, 'invalid-transaction');
        continue;
      }
      const lot = { tx, ticker, qty, remaining: qty };
      lots.set(tx.id, lot);
      buys.push(lot);
    } else if (tx.side === 'sell') {
      if (!(qty > 0) || !Number.isFinite(qty) || !Array.isArray(tx.harvestLots)) {
        markUncertain(ticker, !(qty > 0) || !Number.isFinite(qty) ? 'invalid-transaction' : 'unlinked-sale');
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
        markUncertain(ticker, tx.harvestLots.length === 0 ? 'unlinked-sale' : 'lot-links');
        continue;
      }
      for (const [lot, amount] of allocations) lot.remaining = Math.max(0, lot.remaining - amount);
    }
  }

  const openLots = [];
  const incomplete = new Set();
  let candidates = [];
  for (const lot of buys) {
    if (uncertain.has(lot.ticker) || lot.remaining <= EPSILON) continue;
    const quote = pricesByTicker?.[lot.ticker];
    const quotedPrice = quote?.price == null || quote.price === '' ? NaN : Number(quote.price);
    const purchasePrice = lot.tx.price == null || lot.tx.price === '' ? NaN : Number(lot.tx.price);
    const fee = Number(lot.tx.fee || 0);
    // A zero quote is also the app's common placeholder for a missing price.
    const currentPrice = Number.isFinite(quotedPrice) && quotedPrice > 0 ? quotedPrice : null;
    const price = Number.isFinite(purchasePrice) && purchasePrice >= 0 ? purchasePrice : null;
    const costPerShare = price != null && Number.isFinite(fee) && fee >= 0 ? price + fee / lot.qty : null;
    if (costPerShare == null) incomplete.add(lot.ticker);
    const gainLoss = currentPrice != null && costPerShare != null ? (currentPrice - costPerShare) * lot.remaining : null;
    const openLot = {
      buyId: lot.tx.id, ticker: lot.ticker, date: lot.tx.date, qty: lot.remaining,
      price, costPerShare, currentPrice, gainLoss,
      gainLossPct: gainLoss != null && costPerShare > 0 ? (currentPrice / costPerShare - 1) * 100 : null,
      loss: gainLoss == null ? null : Math.max(0, -gainLoss),
      currency: currencies.get(lot.ticker),
    };
    openLots.push(openLot);
    if (gainLoss < 0) candidates.push(openLot);
  }
  // The hypothetical sale needs every open lot's basis to identify all loss
  // lots. Keep incomplete lots visible in Holdings, but exclude their ticker
  // from opportunity totals until its cost history can be reviewed.
  candidates = candidates.filter(lot => !incomplete.has(lot.ticker));
  // Conservative purchase-window alert, not a tax-lot wash-sale calculation.
  // Include every known buy in the preceding 30 days, even if its lot is at a
  // loss or was subsequently sold. Assuming a hypothetical liquidation does
  // not prove that individual trades are free of wash-sale adjustments.
  for (const candidate of candidates) {
    const priorBuys = buys.filter(other => other.ticker === candidate.ticker &&
      dayNumber(other.tx.date) >= today - 30)
      .map(other => ({ date: other.tx.date, qty: other.qty }))
      .sort((a, b) => b.date.localeCompare(a.date));
    candidate.priorBuys = priorBuys;
    candidate.clearDate = priorBuys.length ? addCalendarDays(priorBuys[0].date, 31) : null;
  }
  candidates.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.date.localeCompare(b.date));
  // Within each ticker the greatest losses come first, followed by gains;
  // unpriced lots stay visible without claiming a monetary result.
  openLots.sort((a, b) => a.ticker.localeCompare(b.ticker) ||
    (a.gainLoss == null && b.gainLoss == null ? 0 : a.gainLoss == null ? 1 : b.gainLoss == null ? -1 : a.gainLoss - b.gainLoss) || a.date.localeCompare(b.date));
  return { candidates, openLots, uncertainTickers: [...uncertain].sort(), incompleteTickers: [...incomplete].sort(), uncertaintyReasons };
}

// Keep loss estimates in their native currency. The main total includes only
// groups without a recent-purchase flag; restricted losses remain
// visible separately and are never presented as tax savings.
export function groupHarvestCandidates(candidates = []) {
  const byAsset = new Map();
  for (const lot of candidates) {
    if (!lot || !lot.ticker || !['USD', 'BRL'].includes(lot.currency) || !Number.isFinite(lot.loss) || lot.loss <= 0) continue;
    const key = `${lot.ticker}|${lot.currency}`;
    let group = byAsset.get(key);
    if (!group) {
      group = { key, ticker: lot.ticker, currency: lot.currency, lots: [], totalLoss: 0, restricted: false, clearDate: null };
      byAsset.set(key, group);
    }
    group.lots.push(lot);
    group.totalLoss += lot.loss;
    if (lot.priorBuys?.length) {
      group.restricted = true;
      if (lot.clearDate && (!group.clearDate || lot.clearDate > group.clearDate)) group.clearDate = lot.clearDate;
    }
  }
  const groups = [...byAsset.values()];
  for (const group of groups) group.lots.sort((a, b) => b.loss - a.loss || a.date.localeCompare(b.date));
  groups.sort((a, b) => (a.currency === b.currency ? b.totalLoss - a.totalLoss || a.ticker.localeCompare(b.ticker) : a.currency === 'USD' ? -1 : 1));
  const totalsByCurrency = {};
  const restrictedTotalsByCurrency = {};
  for (const group of groups) {
    const totals = group.restricted ? restrictedTotalsByCurrency : totalsByCurrency;
    totals[group.currency] = (totals[group.currency] || 0) + group.totalLoss;
  }
  return { groups, totalsByCurrency, restrictedTotalsByCurrency };
}

// Scope only the card's presentation; the lot replay must still see all sales.
export function scopeHarvestToHoldings(harvest, holdings = []) {
  const current = new Set(holdings.filter(h => h.ticker &&
    String(h.assetClass || '').trim().toLowerCase() !== 'bank bonds' &&
    Number.isFinite(Number(h.qty)) && Number(h.qty) > EPSILON
  ).map(h => String(h.ticker).trim().toUpperCase()));
  const includes = ticker => current.has(String(ticker || '').trim().toUpperCase());
  return {
    ...harvest,
    candidates: (harvest.candidates || []).filter(lot => includes(lot.ticker)),
    openLots: (harvest.openLots || []).filter(lot => includes(lot.ticker)),
    uncertainTickers: (harvest.uncertainTickers || []).filter(includes),
    incompleteTickers: (harvest.incompleteTickers || []).filter(includes),
    uncertaintyReasons: Object.fromEntries(Object.entries(harvest.uncertaintyReasons || {}).filter(([ticker]) => includes(ticker))),
  };
}
