// src/lib/bankBonds.js
// Shared Bank Bonds transaction-replay helpers.
//
// Previously this math was duplicated: App.jsx had a ticker-agnostic
// aggregate replay (feeding the "US Bank Bonds" holding in the Holdings tab)
// and Performance.jsx had a separate per-ticker replay (feeding Position
// Performance + Composition Evolution). The two could disagree whenever a
// redemption transaction's `ticker` didn't match the CUSIP of the original
// buy — see the resolution logic below. Consolidated here (jul/2026) so both
// consumers share one source of truth.
//
// No React/JSX here — plain ESM so this can be unit tested directly in Node
// (see test/bank-bonds.test.mjs), same "pure module" convention as
// src/lib/parsing.js and lib/simplefin-map.js.

import { extractBondMeta, buildKnownBondsByDescKey } from "../../lib/bond-meta.js";

// Net principal invested in Bank Bonds, derived from transactions:
//   per CUSIP: Sum(buy qty x price) - Sum(sell qty x price)
// Prices already in real USD per unit (Fidelity x10 correction is applied at
// import time, item 40). Returns the total in USD (floored at 0 - fully
// matured/sold positions read as zero, never negative).
// Ticker-agnostic by design: sums everything into one accumulator, so it is
// unaffected by the redemption-ticker mismatch that computeBankBondsValueAt's
// per-ticker grouping below has to resolve. Always correct - used as the
// canonical reference total.
export function computeBankBondsPrincipal(transactions) {
  let total = 0;
  for (const tx of transactions || []) {
    if (!tx || (tx.assetClass || "") !== "Bank Bonds") continue;
    const qty = Number(tx.qty);
    const price = Number(tx.price);
    if (!isFinite(qty) || !isFinite(price)) continue;
    const amt = qty * price;
    if (tx.side === "buy") total += amt;
    else if (tx.side === "sell") total -= amt;
  }
  return Math.max(0, total);
}

// buildKnownBondsByDescKey (bond description -> known CUSIP) moved to
// ../../lib/bond-meta.js (jul/2026) so it can be shared with the SimpleFin
// interest-auto-resolution path (lib/simplefin-map.js). Same key format
// Transactions.jsx's dropdown fallback uses.

// Resolves the ticker used for grouping in computeBankBondsValueAt below.
// SimpleFin redemption rows (lib/simplefin-map.js, REDEMPTION_RX branch) use
// the bond's description TEXT as a placeholder `ticker` (no CUSIP available
// in that feed) - if that text doesn't match the CUSIP used by the original
// buy, the redemption becomes an orphan sell that never reduces the real
// position's cost, inflating the aggregate. This re-derives the bond's
// descKey from that placeholder text (same extractBondMeta the Fidelity CSV
// import path already uses for the identical problem) and looks it up
// against known buys. Falls back to the raw (uppercased) ticker when nothing
// resolves - manually-entered bonds, or text that doesn't parse - preserving
// the pre-fix orphan-position behavior for those cases.
// `bondBindings` (descKey -> CUSIP, item 41 "Bond Matching" reconciliation,
// api/fidelity-pending.js) is an ADDITIONAL resolution source, tried only
// when `knownBondsByDescKey` (derived from the user's real buy transactions)
// doesn't resolve — covers the older Bank Bonds positions that have no
// couponRate/maturityDate/shortName on their buy transaction (pre-CUSIP-in-
// CSV holdings) but have since been manually or auto-bound via the Bond
// Matching UI. Optional, defaults to {} — every existing caller (this file's
// own two exports below, and their callers in Performance.jsx) keeps working
// unchanged when it isn't passed.
function resolvedTickerFor(tx, knownTickers, knownBondsByDescKey, bondBindings = {}) {
  const raw = tx.ticker ? String(tx.ticker).toUpperCase() : null;
  if (!raw) return null;
  if (tx.side === "sell" && tx.redemption === true && !knownTickers.has(raw)) {
    const meta = extractBondMeta(raw);
    const hit = meta && (knownBondsByDescKey.get(meta.descKey) || bondBindings[meta.descKey]);
    if (hit) return hit;
  }
  return raw;
}

// Generalized replay + accrued-interest projection for Bank Bonds, grouped
// per (resolved) ticker. Used by Position Performance (positionRows) and by
// the Composition Evolution card, which calls this once per historical date
// in the composition series to build a client-side Bank Bonds value series.
// `asOfISO` defaults to today.
export function computeBankBondsValueAt(transactions, asOfISO, bondBindings = {}) {
  const asOf = asOfISO || new Date().toISOString().slice(0, 10);
  const scoped = (transactions || []).filter(
    (tx) => tx?.assetClass === "Bank Bonds" && tx.date && tx.date <= asOf
  );

  // Pre-pass: resolve redemption rows whose `ticker` is really the bond's
  // description text back to the real CUSIP used by the matching buy, when
  // known. Never mutates the original transaction objects - only the ticker
  // used for grouping below.
  const knownTickers = new Set(
    scoped
      .filter((tx) => tx.side === "buy" && tx.ticker)
      .map((tx) => String(tx.ticker).toUpperCase())
  );
  const knownBondsByDescKey = buildKnownBondsByDescKey(scoped);

  const sorted = [...scoped].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const positions = {};
  for (const tx of sorted) {
    const ticker = resolvedTickerFor(tx, knownTickers, knownBondsByDescKey, bondBindings);
    if (!ticker) continue;
    if (!positions[ticker]) positions[ticker] = { totalQty: 0, totalCost: 0, lastBuyDate: null, lastBuyNotes: null };
    const pos = positions[ticker];
    const qty = Number(tx.qty) || 0;
    const price = Number(tx.price) || 0;
    if (tx.side === "buy") {
      pos.totalQty += qty;
      pos.totalCost += qty * price;
      if (!pos.lastBuyDate || tx.date > pos.lastBuyDate) {
        pos.lastBuyDate = tx.date;
        pos.lastBuyNotes = tx.notes || "";
      }
    } else if (tx.side === "sell") {
      const avgBefore = pos.totalQty > 0 ? pos.totalCost / pos.totalQty : 0;
      pos.totalQty -= qty;
      pos.totalCost -= avgBefore * qty;
      if (pos.totalQty < 0.0001) { pos.totalQty = 0; pos.totalCost = 0; }
    }
  }

  const byTicker = {};
  let total = 0;
  for (const [ticker, pos] of Object.entries(positions)) {
    if (pos.totalQty < 0.0001) continue;
    const avgCost = pos.totalCost / pos.totalQty;
    const totalCost = avgCost * pos.totalQty;
    let totalValue = totalCost;
    if (pos.lastBuyNotes && pos.lastBuyDate) {
      const couponM = pos.lastBuyNotes.match(/(\d+\.\d+)%/);
      const maturityM = pos.lastBuyNotes.match(/\d{2}\/\d{2}\/\d{4}$/);
      if (couponM && maturityM) {
        const annualRate = parseFloat(couponM[1]) / 100;
        const purchaseTs = new Date(pos.lastBuyDate + "T00:00:00").getTime();
        const asOfTs = new Date(asOf + "T00:00:00").getTime();
        const daysSincePurchase = Math.max(0, (asOfTs - purchaseTs) / 86400000);
        totalValue = totalCost + totalCost * annualRate * (daysSincePurchase / 365);
      }
    }
    byTicker[ticker] = { qty: pos.totalQty, avgCost, totalCost, totalValue };
    total += totalValue;
  }
  return { total, byTicker };
}

// Per-bond CURRENT VALUE from SimpleFin, grouped per (resolved) ticker
// (jul/2026 — "current value must match SimpleFin individually per bond").
//
// Unlike computeBankBondsValueAt above (which PROJECTS a value from cost +
// accrued-interest and is kept only for Composition Evolution's historical
// series), this reads the ACTUAL market value SimpleFin reported for each
// bond. `bondMarketValuesByDescKey` is a plain object descKey -> marketValue,
// recorded on the aggregated "US Bank Bonds" holding when a SimpleFin Bank
// Bonds balance is approved (App.jsx applyFidelityBalanceUpdate). Each open
// position's descKey is derived from its buy transaction's structured
// couponRate/maturityDate/shortName (same descKey format buildKnownBondsByDescKey
// and extractBondMeta produce), so a bond keyed by a synthetic ticker, a real
// CUSIP, or a manually-entered ticker all resolve to the same market value as
// long as their coupon/maturity metadata is present.
//
// Fallback (deliberate): a bond SimpleFin did NOT return (some don't — matured,
// transferred, or simply absent from the feed) or one with no coupon/maturity
// metadata to build a descKey has `currentValue = totalCost` and
// `marketValueSource: "cost"`, so it never vanishes from the total — it just
// shows no gain/loss until SimpleFin reports it. Returns { total, byTicker }
// with byTicker[ticker] = { qty, avgCost, totalCost, currentValue,
// marketValueSource }.
export function computeBankBondsMarketValue(transactions, bondMarketValuesByDescKey = {}, bondBindings = {}) {
  const scoped = (transactions || []).filter(
    (tx) => tx?.assetClass === "Bank Bonds" && tx.date
  );
  const knownTickers = new Set(
    scoped
      .filter((tx) => tx.side === "buy" && tx.ticker)
      .map((tx) => String(tx.ticker).toUpperCase())
  );
  const knownBondsByDescKey = buildKnownBondsByDescKey(scoped);
  const sorted = [...scoped].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const positions = {};
  for (const tx of sorted) {
    const ticker = resolvedTickerFor(tx, knownTickers, knownBondsByDescKey, bondBindings);
    if (!ticker) continue;
    if (!positions[ticker]) positions[ticker] = { totalQty: 0, totalCost: 0, descKey: null };
    const pos = positions[ticker];
    const qty = Number(tx.qty) || 0;
    const price = Number(tx.price) || 0;
    if (tx.side === "buy") {
      pos.totalQty += qty;
      pos.totalCost += qty * price;
      // descKey comes from the buy row's structured metadata (populated by the
      // CSV import, the synthetic-id path, or the SimpleFin sync) — never from
      // the ticker's shape, so it matches the descKey SimpleFin's holding
      // description parses to.
      if (!pos.descKey && tx.couponRate != null && tx.maturityDate && tx.shortName) {
        pos.descKey = `${String(tx.shortName).toUpperCase()}|${tx.couponRate}|${tx.maturityDate}`;
      }
    } else if (tx.side === "sell") {
      const avgBefore = pos.totalQty > 0 ? pos.totalCost / pos.totalQty : 0;
      pos.totalQty -= qty;
      pos.totalCost -= avgBefore * qty;
      if (pos.totalQty < 0.0001) { pos.totalQty = 0; pos.totalCost = 0; }
    }
  }

  const byTicker = {};
  let total = 0;
  for (const [ticker, pos] of Object.entries(positions)) {
    if (pos.totalQty < 0.0001) continue;
    const totalCost = pos.totalCost;
    const avgCost = totalCost / pos.totalQty;
    const mv = pos.descKey != null ? Number(bondMarketValuesByDescKey[pos.descKey]) : NaN;
    const hasMv = isFinite(mv);
    const currentValue = hasMv ? mv : totalCost;
    byTicker[ticker] = {
      qty: pos.totalQty,
      avgCost,
      totalCost,
      currentValue,
      marketValueSource: hasMv ? "simplefin" : "cost",
    };
    total += currentValue;
  }
  return { total, byTicker };
}

// Total Bank Bonds COST, summed from the SAME per-ticker replay Position
// Performance uses (computeBankBondsMarketValue's byTicker totalCost). Kept as
// a distinct export from computeBankBondsPrincipal: the latter is ticker-
// agnostic (one global accumulator, subtracting each redemption at its SELL
// price), while this sums each open position's remaining cost at AVERAGE cost —
// the two diverge whenever a bond bought off-par is partially redeemed. The
// Holdings tab's aggregated "US Bank Bonds" holding uses THIS so its Cost
// matches the Position Performance table exactly (jul/2026).
export function computeBankBondsCost(transactions, bondBindings = {}) {
  const { byTicker } = computeBankBondsMarketValue(transactions, {}, bondBindings);
  return Object.values(byTicker).reduce((s, b) => s + (b.totalCost || 0), 0);
}

// Set of every distinct resolved ticker across ALL Bank Bonds transactions
// (buys + resolved-or-orphan redemptions), independent of current qty/date -
// unlike computeBankBondsValueAt's `byTicker` (which only lists positions
// still open as of a given date). Used by Composition Evolution's per-ticker
// view so a fully matured/redeemed CUSIP keeps its own resolved-CUSIP line
// (decaying to zero) instead of a phantom line keyed by the SimpleFin
// redemption's placeholder description text.
export function listBankBondsTickers(transactions, bondBindings = {}) {
  const all = (transactions || []).filter((tx) => tx?.assetClass === "Bank Bonds");
  const knownTickers = new Set(
    all
      .filter((tx) => tx.side === "buy" && tx.ticker)
      .map((tx) => String(tx.ticker).toUpperCase())
  );
  const knownBondsByDescKey = buildKnownBondsByDescKey(all);
  const set = new Set();
  for (const tx of all) {
    const ticker = resolvedTickerFor(tx, knownTickers, knownBondsByDescKey, bondBindings);
    if (ticker) set.add(ticker);
  }
  return set;
}

// Permanent aggregated "US Bank Bonds" holding id (item 37). Exported so
// App.jsx (and Performance.jsx, which redefines it locally per this repo's
// "no shared theme/const file" convention) can identify the one manual
// holding this reconciliation function owns.
export const BANK_BONDS_ID = "bank-bonds-aggregate";

// Ensures a single manual "US Bank Bonds" holding reflects the portfolio's
// bank bonds. This is App.jsx's Holdings-tab counterpart to Position
// Performance's positionRows (src/Performance.jsx) - both must show the same
// current value for Bank Bonds, so both use computeBankBondsMarketValue.
//
// Bugfix (aug/2026): before this, the Holdings tab's displayed value came
// from `marketValueOverride`, a flat SUM of SimpleFin's last-synced market
// values (computeBalanceCandidates in lib/simplefin-map.js) with no per-bond
// fallback - any bond present in the transaction log but silently missing
// or non-numeric in that SimpleFin snapshot contributed NOTHING (not even
// its cost) to the total, while Position Performance's per-bond replay
// (computeBankBondsMarketValue) always falls back to that bond's own cost
// when SimpleFin didn't report it. The two totals diverged by exactly the
// cost of whichever bonds fell into that gap. Now both consumers read the
// exact same byTicker resolution, keyed by `bondMarketValues` (descKey ->
// market value, recorded on this holding by App.jsx's
// applyFidelityBalanceUpdate and consumed identically by Performance.jsx) -
// `marketValueOverride`/`marketValueOverrideAsOf` are kept around only as a
// reference/back-compat field, no longer read here.
//
// `transactions` is the full transaction log (Bank Bonds rows are filtered
// internally by computeBankBondsMarketValue/computeBankBondsCost, same as
// every other consumer of those two functions). `hasBankBondTx` is a
// precomputed bool - callers already need it for their own early exits, so
// it is threaded through rather than recomputed here.
// - Mirrors only the aggregated holding; Cash and other manual holdings (e.g.
//   BRA Fixed Income) are never touched.
// - When there are Bank Bonds transactions, the holding is created if missing
//   and kept in sync.
// - When there are no Bank Bonds transactions AND no holding exists yet,
//   nothing is added (avoids an empty placeholder for users with no bonds).
// Returns a patched holdings array if anything changed, null otherwise.
export function applyBankBondsHolding(holdings, transactions, hasBankBondTx) {
  const arr = Array.isArray(holdings) ? holdings : [];
  const existing = arr.find((h) => h && h.id === BANK_BONDS_ID);

  // Per-bond SimpleFin market values (descKey -> value), recorded on the
  // holding itself so this reconciliation (which runs on every transaction
  // change) always has access to the last synced per-bond snapshot - the
  // exact same field and shape Performance.jsx's positionRows reads.
  const bondMarketValues =
    existing && existing.bondMarketValues && typeof existing.bondMarketValues === "object"
      ? existing.bondMarketValues
      : {};
  const { total: displayValue } = computeBankBondsMarketValue(transactions, bondMarketValues);
  const principal = computeBankBondsCost(transactions);

  if (!existing) {
    if (!hasBankBondTx) return null; // nothing to track yet
    return [
      ...arr,
      {
        id: BANK_BONDS_ID,
        type: "manual",
        manualMode: "value",
        ticker: "US BANK BONDS",
        name: "US Bank Bonds",
        assetClass: "Bank Bonds",
        assetClassOverride: "Bank Bonds",
        manualCurrency: "USD",
        qty: null,
        manualPrice: null,
        manualValue: displayValue,
        costBasis: principal,
        price: null,
        target: 0,
        derivedFromTransactions: true,
        lastUpdated: new Date().toISOString(),
      },
    ];
  }

  // A holding placeholder can exist without any Bank Bonds transactions yet
  // (e.g. auto-created from a SimpleFin balance candidate - see
  // App.jsx's applyFidelityBalanceUpdate). Its manualValue there is a real
  // SimpleFin-reported number, not a placeholder 0 - with no Bank Bonds
  // transactions computeBankBondsMarketValue/computeBankBondsCost always
  // return 0, so reconciling normally here would silently zero it back out
  // on every load/refresh. Skip reconciliation for this holding until a real
  // Bank Bonds transaction exists to derive a value from.
  if (!hasBankBondTx && existing.derivedFromTransactions === false) return null;

  // Reaching here means hasBankBondTx === true (the guard above already
  // returned for the false case), so this is the moment to graduate a
  // not-yet-derived holding permanently, even if nothing else changed (the
  // flag flip still is a change).
  const needsGraduation = existing.derivedFromTransactions === false;
  if (existing.manualValue === displayValue && existing.costBasis === principal && !needsGraduation) return null;
  return arr.map((h) =>
    h.id === BANK_BONDS_ID
      ? {
          ...h,
          manualValue: displayValue,
          costBasis: principal,
          // Graduates the holding once a real Bank Bonds transaction shows
          // up: from then on it reconciles normally, permanently.
          derivedFromTransactions: true,
          lastUpdated: new Date().toISOString(),
        }
      : h
  );
}
