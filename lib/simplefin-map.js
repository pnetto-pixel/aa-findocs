// lib/simplefin-map.js
//
// Pure mapper: raw SimpleFin `/accounts` payload -> the app's staging shape.
// No network, no Redis, no React — same "pure module + fixtures" convention as
// src/lib/parsing.js (the Fidelity CSV parser), so this can be unit tested in
// plain Node (see test/simplefin-map.test.mjs).
//
// Background: docs/plans/simplefin-fidelity-feed.md — Fase 0 (probe, done
// twice against the real Fidelity account) resolved most of the payload shape:
//   - Cash: account['available-balance'] (falls back to the synthetic
//     holdings[] entry with description "CASH", same value, when the
//     account-level field is missing).
//   - Bank Bonds (CDs/Treasuries, no CUSIP in this feed): sum of
//     holdings[].market_value where symbol === "" AND description !== "CASH"
//     (the CASH synthetic holding also has symbol === "" — excluding it by
//     description is load-bearing, not cosmetic).
//   - Dividends / bond interest / tax / redemption: recognized from
//     transactions[].description, which mirrors the Fidelity CSV Action
//     vocabulary closely but not identically — see mapOneTransaction below.
//   - Buy/sell of stocks and bond purchases: no real example seen in 90 days
//     of the probed account. Recognized by heuristic (YOU BOUGHT/YOU SOLD)
//     but SimpleFin's standard transaction schema carries only a signed total
//     `amount`, never separate qty/price — so a recognized trade still can't
//     become a valid transaction and is routed to `unmapped` for manual entry
//     rather than inventing numbers.
//
// A SimpleFin connection returns every institution the user linked in the
// Bridge, not just Fidelity (confirmed jul/2026: 22 accounts, 1 Fidelity).
// isFidelityOrg() is the mandatory filter — callers (api/fidelity-pending.js)
// must never map or surface holdings/transactions from a non-Fidelity org.

import { extractBondMeta, generateSyntheticBondTicker } from "./bond-meta.js";

const FIDELITY_ORG_HINTS = ["fidelity"];

export function isFidelityOrg(org) {
  const haystack = `${org?.name || ""} ${org?.domain || ""}`.toLowerCase();
  return FIDELITY_ORG_HINTS.some((hint) => haystack.includes(hint));
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `sf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toNumber(x) {
  if (x === null || x === undefined || x === "") return NaN;
  return typeof x === "number" ? x : parseFloat(x);
}

// SimpleFin timestamps are unix seconds. The app's date fields are plain
// "YYYY-MM-DD" strings (no time component), so truncate rather than keep
// a full ISO timestamp.
function unixToDateOnly(sec) {
  if (typeof sec !== "number" || !isFinite(sec)) return null;
  try {
    return new Date(sec * 1000).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

// Cash-sweep interest/reinvestment cycle (e.g. "INTEREST EARNED CASH
// (123456789) (Cash)" paired with "REINVESTMENT CASH (123456789) (Cash)",
// same amount opposite sign) — always excluded, same purge category the CSV
// parser already applies (src/lib/parsing.js: isCashSweep / distributionEvents).
const EXCLUDE_CASH_CYCLE_RX = /EARNED CASH|REINVESTMENT CASH/i;
// Share distributions (paid in shares, not cash) — always excluded, same
// purge category as the CSV parser's DISTRIBUTION guard.
const DISTRIBUTION_RX = /^DISTRIBUTION\b/i;
// External transfer already captured by the Cash balance update — always
// excluded, same purge category as EXCLUDE_CASH_CYCLE_RX / DISTRIBUTION_RX.
const EXCLUDE_EFT_RECEIVED_RX = /^ELECTRONIC FUNDS TRANSFER RECEIVED/i;
const FOREIGN_TAX_RX = /FOREIGN TAX/i;
const DIVIDEND_RX = /DIVIDEND/i;
const REINVEST_RX = /REINVEST/i;
const INTEREST_RX = /INTEREST/i;
const REDEMPTION_RX = /REDEMPTION PAYOUT|^REDEEMED/i;
const TRADE_RX = /YOU BOUGHT|YOU SOLD/i;

// Ticker extraction patterns, tried in order. Dividend/foreign-tax rows follow
// the Fidelity CSV convention of a trailing "(TICKER) (Cash)"; bond interest
// rows usually have no bracketed ticker (no CUSIP anywhere in this feed), so
// the issuer name itself becomes the "ticker" — a text placeholder good
// enough for the staging UI, not a market-priced instrument.
const TRAILING_TICKER_RX = /\(([A-Z]{1,5})\)\s*\(Cash\)\s*$/i;
const INTEREST_PREFIX_RX = /^INTEREST(?:\s+AS\s+OF\s+\d{4}-\d{2}-\d{2})?\s+(.+?)\s*\(Cash\)\s*$/i;
const FOREIGN_TAX_STRIP_RX = /^FOREIGN TAX (?:PAID|WITHHELD)\s+(.+?)\s*\(Cash\)\s*$/i;
const REDEMPTION_STRIP_RX = /^REDEMPTION PAYOUT\s+(.+?)\s*\(Cash\)\s*$/i;

function extractTicker(description, patterns) {
  for (const rx of patterns) {
    const m = description.match(rx);
    if (m && m[1]) {
      const t = m[1].trim().toUpperCase();
      if (t) return t;
    }
  }
  return null;
}

// Holdings from an account that are shaped like a bank bond / CD (no ticker
// symbol, not the synthetic CASH row) — same filter computeBalanceCandidates
// uses to sum the Bank Bonds balance, extracted here so both that sum AND the
// INTEREST auto-resolution below (mapOneTransaction) share one definition.
function bankBondHoldings(account) {
  const holdings = Array.isArray(account?.holdings) ? account.holdings : [];
  return holdings.filter((h) => {
    const symbol = String(h?.symbol ?? "").trim();
    const description = String(h?.description ?? "").trim().toUpperCase();
    return symbol === "" && description !== "CASH";
  });
}

// Extracts one staging-shaped row per bank-bond-style holding in an account
// (see bankBondHoldings() above), regardless of whether the description text
// parses into coupon/maturity metadata. This feeds the "Bond Matching"
// reconciliation UI (Transactions.jsx): SimpleFin never returns a CUSIP for
// these holdings, but its description carries the same coupon%+maturity text
// the Fidelity CSV import already knows how to parse (extractBondMeta) — so
// the same descKey used by knownBondsByDescKey can bind a holding to a real
// CUSIP already known from the user's buy transactions. When the description
// doesn't match the expected pattern (unexpected format), `descKey` is null
// and the item is still included — the Bond Matching UI falls back to a raw
// description key for manual binding rather than silently dropping the row.
function extractBondHoldingsList(account) {
  const accountId = account?.id ?? null;
  const accountName = account?.name ?? null;
  return bankBondHoldings(account).map((h) => {
    const description = String(h?.description || "").trim();
    const meta = extractBondMeta(description);
    const mv = toNumber(h.market_value ?? h["market-value"]);
    return {
      accountId,
      accountName,
      description,
      marketValue: isFinite(mv) ? mv : null,
      descKey: meta ? meta.descKey : null,
      couponRate: meta ? meta.couponRate : null,
      maturityDate: meta ? meta.maturityDate : null,
      shortName: meta ? meta.shortName : null,
    };
  });
}

// Bond BUY transactions synthesized from an account's HOLDINGS snapshot
// (jul/2026 — "sync should add new bonds to the transactions, so there are
// three ways in: manual, CSV import, or SimpleFin sync").
//
// SimpleFin's holdings feed carries no CUSIP and no purchase date for bank
// bonds, but it DOES carry the cost: `purchase_price` x `shares` (confirmed by
// the user, jul/2026), with `cost_basis` as an already-multiplied alternative.
// So a synthesized buy uses:
//   - ticker: a deterministic synthetic id from coupon+maturity
//     (generateSyntheticBondTicker) — the CUSIP is never in this feed.
//   - cost = purchase_price x shares when present, else `cost_basis`, else
//     (last resort) the current market value. Represented at par: price pinned
//     at 1000 and qty = cost / 1000, so qty x price === cost, consistent with
//     the CSV import's Bank Bonds representation. Real gain/loss then falls out
//     of (per-bond market value − this cost); only the market-value fallback
//     starts gain/loss at ~0. Never invents a cost the feed doesn't provide.
//   - date: the account's balance-date (the "as of" of this snapshot), or
//     today if absent — the true purchase date is unknown and unknowable here.
//
// Only emitted for bonds the user does NOT already have a Bank Bonds buy for
// (descKey absent from `knownBondsByDescKey`) — an existing bond is never
// duplicated. Bonds whose description doesn't parse to a descKey (unexpected
// format, no coupon/maturity) are skipped here rather than guessed at; their
// market value still reaches the total via the bondHoldings snapshot. A stable
// `simplefinId` (`sfbond-buy:<descKey>`) lets the server dedupe across syncs
// even though qty (derived from a possibly-drifting cost) can change.
function bondCostBasis(h) {
  const pp = toNumber(h?.purchase_price ?? h?.["purchase-price"]);
  const sh = toNumber(h?.shares);
  if (isFinite(pp) && isFinite(sh) && pp > 0 && sh > 0) return pp * sh;
  const cb = toNumber(h?.cost_basis ?? h?.["cost-basis"]);
  if (isFinite(cb) && cb > 0) return cb;
  const mv = toNumber(h?.market_value ?? h?.["market-value"]);
  if (isFinite(mv) && mv > 0) return mv;
  return NaN;
}

function bondBuyTransactions(account, knownBondsByDescKey = new Map()) {
  const asOf = unixToDateOnly(account?.["balance-date"]) || new Date().toISOString().slice(0, 10);
  const out = [];
  for (const h of bankBondHoldings(account)) {
    const description = String(h?.description || "").trim();
    const meta = extractBondMeta(description);
    if (!meta || !meta.descKey) continue; // can't identify -> don't synthesize a buy
    if (knownBondsByDescKey.get(meta.descKey)) continue; // already a known position
    const cost = bondCostBasis(h);
    if (!isFinite(cost) || cost <= 0) continue;
    const ticker = generateSyntheticBondTicker(meta.couponRate, meta.maturityDate);
    if (!ticker) continue; // no deterministic id -> skip rather than guess
    out.push({
      id: newId(),
      date: asOf,
      side: "buy",
      ticker,
      assetClass: "Bank Bonds",
      qty: cost / 1000,
      price: 1000,
      currency: "USD",
      fee: 0,
      couponRate: meta.couponRate,
      maturityDate: meta.maturityDate,
      shortName: meta.shortName,
      notes: meta.notes,
      source: "simplefin",
      simplefinId: `sfbond-buy:${meta.descKey}`,
      syncedBond: true,
      createdAt: new Date().toISOString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stock/ETF position delta detection (jul/2026) — detects new tickers and
// share-count changes between a Fidelity account's HOLDINGS snapshot and the
// user's already-known net qty (from live transactions), and synthesizes the
// buy/sell candidates a real trade log would have produced. Mirrors
// bondBuyTransactions() above, but for holdings WITH a ticker symbol
// (stocks/ETFs) instead of bank-bond-shaped holdings (no symbol).
//
// This is Phase 1 only: detection + staging into the SAME `transactions`
// array/approval queue as every other Fidelity Import candidate (Trades
// table, src/Transactions.jsx) — nothing here is applied automatically, and
// nothing has an irreversible side effect at detection time. A future Phase 2
// (full auto-approval) is intentionally NOT implemented; this function's
// pure, side-effect-free shape (snapshot + known qty in, candidates out) is
// what would let a future auto-apply path reuse it directly instead of
// needing a rewrite.
//
// Net qty per ticker, duplicated from src/App.jsx's computeNetQty (same
// project convention as other small client/server duplicated helpers — see
// docs/CONTEXT.md) so this can run server-side (api/fidelity-pending.js
// handleSync) without importing a frontend module.
//
// `beforeDate` (optional, "YYYY-MM-DD") restricts the sum to transactions
// dated STRICTLY before that day. Used by stockPositionDeltas below to
// answer "what did the SimpleFin snapshot already have baked in as of its
// own balance-date" — a transaction dated ON the snapshot's balance-date is
// same-day-ambiguous (the snapshot's `shares` may or may not have caught up
// to it yet, since Fidelity's own settlement timing is opaque to us), so it's
// excluded from "settled" the same way it's included in the unrestricted sum.
// Omitting `beforeDate` preserves the original unrestricted behavior
// (pre-aug/2026), used everywhere else this function is called.
export function computeNetQty(transactions, beforeDate) {
  const net = {};
  for (const tx of transactions || []) {
    if (!tx || !tx.ticker || tx.qty == null) continue;
    if (beforeDate && !(typeof tx.date === "string" && tx.date < beforeDate)) continue;
    const t = String(tx.ticker).toUpperCase();
    if (net[t] == null) net[t] = 0;
    if (tx.side === "buy") net[t] += Number(tx.qty);
    else if (tx.side === "sell") net[t] -= Number(tx.qty);
  }
  return net;
}

// Small duplicate of src/lib/parsing.js's inferAssetClass ETF/CUSIP/B3
// classification tables. Not imported directly: src/lib/parsing.js pulls in
// papaparse, which this file must stay free of (see header comment — it
// needs to stay importable from a serverless function). Same
// duplicate-across-the-client/server-boundary convention already used by
// lib/bond-meta.js's callers.
const SF_FIXED_INCOME_ETFS = new Set([
  "BND", "AGG", "SCHZ", "IAGG", "BNDX", "VCIT", "VCSH", "LQD", "HYG",
  "TLT", "IEF", "SHY", "GOVT", "MUB", "VTEB", "BSV", "BIV", "BLV",
  "VGSH", "VGIT", "VGLT", "SPTL", "SPIB", "SPAB", "FBND",
]);
const SF_REAL_ESTATE_ETFS = new Set([
  "VNQ", "XLRE", "IYR", "SCHH", "RWR", "USRT", "FREL", "REM", "MORT", "KBWY",
]);
const SF_B3_RX = /^[A-Z]{4}\d{1,2}$/;
const SF_CUSIP_RX = /^[A-Z0-9]{9}$/;

function inferAssetClassForDelta(ticker) {
  const t = String(ticker || "").trim().toUpperCase();
  if (!t) return "Stocks";
  if (SF_FIXED_INCOME_ETFS.has(t)) return "Bonds";
  if (SF_REAL_ESTATE_ETFS.has(t)) return "Real Estate";
  if (SF_CUSIP_RX.test(t)) return "Bank Bonds";
  if (SF_B3_RX.test(t)) return "BRA Stocks";
  return "Stocks"; // default: everything stockHoldings() returns has a plain symbol
}

// Holdings shaped like a stock/ETF position — the opposite filter of
// bankBondHoldings() above: anything WITH a ticker symbol (bank bonds and the
// synthetic CASH row both have symbol === "").
function stockHoldings(account) {
  const holdings = Array.isArray(account?.holdings) ? account.holdings : [];
  return holdings.filter((h) => String(h?.symbol ?? "").trim() !== "");
}

// Average cost per share for a buy-direction delta: purchase_price is
// already a per-share figure (see bondCostBasis's pp x shares comment above);
// cost_basis is a total, so it needs dividing by shares to become per-share.
function avgCostPerShare(h) {
  const pp = toNumber(h?.purchase_price ?? h?.["purchase-price"]);
  if (isFinite(pp) && pp > 0) return pp;
  const cb = toNumber(h?.cost_basis ?? h?.["cost-basis"]);
  const sh = toNumber(h?.shares);
  if (isFinite(cb) && cb > 0 && isFinite(sh) && sh > 0) return cb / sh;
  return NaN;
}

// Compares one account's stock/ETF holdings snapshot against the user's
// known net qty per ticker and synthesizes buy/sell candidates for whatever
// moved. Returns `{ transactions, unmapped }` (same "never invent, surface
// what can't be resolved" shape as the rest of this file).
//
// Price rules (confirmed with the user, jul/2026):
//   - New ticker (known qty 0, shares > 0) or a share-count INCREASE: a "buy"
//     for the delta qty, priced at the snapshot's average cost
//     (purchase_price, falling back to cost_basis/shares) — an approximation
//     of the real incremental trade price (SimpleFin never reports the
//     actual trade price), flagged in `notes`.
//   - A share-count DECREASE where the holding is still present with
//     shares > 0 remaining: a "sell" for the delta qty, priced at the
//     CURRENT market value per remaining share (market_value / shares) — a
//     proxy for the actual sale price, flagged in `notes`. Per explicit
//     product decision, this kind of sell is never routed to `unmapped`.
//   - Full liquidation where the holding is still listed at exactly 0 shares
//     has NO market_value left to serve as that proxy (0 shares remaining ->
//     nothing to divide by) — routed to `unmapped` instead of inventing a
//     number. Documented, deliberate exception to the rule above, which
//     assumes a partial reduction where the remaining position still carries
//     a real market value.
//   - Missing `shares` on a holding entirely (can't determine a qty at all):
//     skipped gracefully — no candidate, no unmapped row, nothing actionable
//     to surface.
//   - A ticker the user already holds (known qty > 0) that no longer appears
//     AT ALL in this account's holdings snapshot (the more likely real-world
//     shape of "sold everything") is intentionally NOT detected here: this
//     function only sees one account's holdings, while `netQtyByTicker` is
//     built from ALL live transactions across every account, so a ticker
//     absent from THIS account's snapshot could simply be held in a
//     different Fidelity account and not be a sale at all. Safely
//     distinguishing those two cases would need account-level position
//     tracking the transaction log doesn't have today — left undetected
//     (status quo, no regression) rather than guessed at.
//
// Snapshot-lag false positive (bug found aug/2026 — reported as "buys staged
// backwards as sells"): `netQtyByTicker` is built from the user's FULL live
// transaction log with no date filter, so it already includes a buy entered
// today even though today's SimpleFin holdings snapshot (`h.shares`) was
// pulled before Fidelity's own books caught up to that same-day trade. The
// bug wasn't a sign error — the delta math above is correct — it's that
// `knownQty` and `sharesNew` were being compared as if they described the
// same point in time when they don't: `knownQty` already includes the
// same-day buy, `sharesNew` doesn't yet, so `sharesNew - knownQty` comes out
// negative (a phantom "sell") for a qty that's actually a completed, already
// -recorded buy. The fix: also compute a SETTLED qty per ticker using only
// transactions dated strictly before the snapshot's own `asOf` (via
// computeNetQty's `beforeDate`), and skip the delta entirely (no candidate,
// no unmapped row) whenever the snapshot's shares already match THAT settled
// figure — i.e. the apparent "sell" is fully explained by a buy the snapshot
// simply hasn't absorbed yet, not a real, actionable position change. This is
// a silent skip rather than an `unmapped` row: there's nothing for the user
// to resolve here (the real buy is already in their transaction log), it's
// only the snapshot lagging by a day. `liveTransactions` is optional — when
// the caller doesn't pass it (or passes something that isn't an array), this
// guard never runs and behavior is byte-for-byte identical to before this
// fix, matching the rest of this file's "omit the param for pre-feature
// behavior" convention.
function stockPositionDeltas(account, netQtyByTicker = {}, liveTransactions = null) {
  const asOf = unixToDateOnly(account?.["balance-date"]) || new Date().toISOString().slice(0, 10);
  const accountId = account?.id ?? null;
  const accountName = account?.name ?? null;
  const transactions = [];
  const unmapped = [];
  const settledQtyByTicker = Array.isArray(liveTransactions)
    ? computeNetQty(liveTransactions, asOf)
    : null;

  for (const h of stockHoldings(account)) {
    const ticker = String(h?.symbol || "").trim().toUpperCase();
    if (!ticker) continue;

    const sharesNew = toNumber(h?.shares);
    if (!isFinite(sharesNew) || sharesNew < 0) continue; // no usable shares data -> skip gracefully

    const rawKnown = netQtyByTicker ? netQtyByTicker[ticker] : undefined;
    const knownQty = isFinite(Number(rawKnown)) ? Number(rawKnown) : 0;
    const delta = sharesNew - knownQty;
    if (Math.abs(delta) < 1e-9) continue; // unchanged

    if (settledQtyByTicker) {
      const settledQty = isFinite(Number(settledQtyByTicker[ticker])) ? Number(settledQtyByTicker[ticker]) : 0;
      if (Math.abs(sharesNew - settledQty) < 1e-9) continue; // snapshot lag: apparent delta is fully explained by a same-day/future tx not yet absorbed -- skip silently
    }

    const assetClass = inferAssetClassForDelta(ticker);
    // Durable identity, NOT tied to `asOf`: the account's balance-date
    // advances every business day the sync runs, so an ID built from asOf
    // (the pre-fix approach) mints a brand-new "duplicate" of the SAME
    // unresolved delta every single day it isn't acted on -- both here and in
    // the buy/sell candidate below. Anchoring instead to the snapshot's
    // TARGET position (accountId + ticker + sharesNew, the post-delta share
    // count) keeps the id -- and therefore the dedupe in
    // api/fidelity-pending.js handleSync -- stable across days for as long as
    // the position doesn't move again. It only changes once the delta is
    // resolved (approved -> knownQty catches up to sharesNew -> this exact
    // delta no longer fires) or the position genuinely moves further (a real,
    // distinct new delta, which SHOULD get a new id). sharesNew (the target),
    // not the delta itself, is deliberate: two different deltas can happen to
    // be the same size (e.g. two separate +5-share buys), and keying on the
    // delta size alone would collide them into the same id. `asOf` is still
    // used for the `date` field below (a real calendar date is needed there)
    // -- just never as part of the identity.
    const simplefinId = `sfstock-delta:${accountId}:${ticker}:${sharesNew}`;

    if (delta > 0) {
      const price = avgCostPerShare(h);
      if (!isFinite(price) || price <= 0) {
        unmapped.push({
          simplefinId,
          accountId,
          accountName,
          date: asOf,
          description: `${ticker} position increase detected in SimpleFin holdings (${knownQty} -> ${sharesNew} shares)`,
          amount: null,
          reason: "stock position increased but the holding has no purchase_price/cost_basis to derive a buy price -- enter manually",
        });
        continue;
      }
      transactions.push({
        id: newId(),
        date: asOf,
        side: "buy",
        ticker,
        assetClass,
        qty: delta,
        price,
        currency: "USD",
        fee: 0,
        notes:
          knownQty === 0
            ? "New position detected from SimpleFin holdings snapshot. Price is the position's average cost (purchase_price), not necessarily the actual trade price."
            : "Position increase detected from SimpleFin holdings snapshot. Price is the position's average cost (purchase_price), not the actual incremental trade price.",
        source: "simplefin",
        simplefinId,
        derivedFromHoldingsDiff: true,
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    // delta < 0: shares decreased. Only a genuine partial reduction (holding
    // still present with shares > 0 remaining) has a market_value to proxy a
    // sell price from -- see the full-liquidation exception above.
    if (sharesNew > 0) {
      const mv = toNumber(h?.market_value ?? h?.["market-value"]);
      if (!isFinite(mv) || mv <= 0) {
        unmapped.push({
          simplefinId,
          accountId,
          accountName,
          date: asOf,
          description: `${ticker} position decrease detected in SimpleFin holdings (${knownQty} -> ${sharesNew} shares)`,
          amount: null,
          reason: "stock position decreased but the holding has no valid market_value to estimate a sell price -- enter manually",
        });
        continue;
      }
      transactions.push({
        id: newId(),
        date: asOf,
        side: "sell",
        ticker,
        assetClass,
        qty: -delta,
        price: mv / sharesNew,
        currency: "USD",
        fee: 0,
        notes: "Sell price estimated from SimpleFin market value, not the actual trade price.",
        source: "simplefin",
        simplefinId,
        derivedFromHoldingsDiff: true,
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    // Full liquidation, holding still listed at exactly 0 shares -- no
    // market_value left to proxy a price from.
    unmapped.push({
      simplefinId,
      accountId,
      accountName,
      date: asOf,
      description: `${ticker} position appears fully sold (SimpleFin holdings shows 0 shares)`,
      amount: null,
      reason: "stock position fully sold but SimpleFin has no market value left to estimate a sell price -- enter manually",
    });
  }

  return { transactions, unmapped };
}

// Maps a single SimpleFin transaction to one of:
//   { excluded: true }               — intentionally dropped, never surfaced
//   { transaction: {...} }           — a buy/sell transaction candidate
//   { bondIncome: {...} }            — a dividend/interest/tax income event
//   { unmapped: {...} }              — visible-but-unresolved, never silent
// `knownBondsByDescKey` (bond description -> known CUSIP, see lib/bond-meta.js)
// is used only by the INTEREST branch below, to auto-resolve the issuer-name
// placeholder ticker to a real CUSIP when possible. Optional — callers that
// don't care about auto-resolution (or don't have any known bonds yet) can
// omit it, which behaves exactly like before this feature (jul/2026).
// `bondBindings` (descKey -> CUSIP, the persisted staging field) is the
// SECOND resolution source for that same branch: bonds bought before Fidelity
// stopped putting the CUSIP in the CSV have no coupon/maturity metadata on
// their buy transaction, so they can never enter knownBondsByDescKey — the
// user's own confirmed bind is the only thing that can resolve them.
function mapOneTransaction(tx, account, knownBondsByDescKey = new Map(), bondBindings = {}) {
  const simplefinId = tx?.id != null ? String(tx.id) : null;
  const description = String(tx?.description || "").trim();
  const upper = description.toUpperCase();
  const amountNum = toNumber(tx?.amount);
  const date = unixToDateOnly(tx?.posted ?? tx?.transacted_at);
  const accountId = account?.id ?? null;
  const accountName = account?.name ?? null;

  const unmappedItem = (reason) => ({
    simplefinId,
    accountId,
    accountName,
    date,
    description,
    amount: isFinite(amountNum) ? amountNum : null,
    reason,
  });

  if (!description) return { unmapped: unmappedItem("missing description") };
  if (!date) return { unmapped: unmappedItem("missing/invalid posted date") };

  if (EXCLUDE_CASH_CYCLE_RX.test(upper)) return { excluded: true };
  if (DISTRIBUTION_RX.test(upper)) return { excluded: true };
  if (EXCLUDE_EFT_RECEIVED_RX.test(upper)) return { excluded: true };

  // Foreign tax withheld — checked before the general dividend guard (same
  // ordering lesson as the CSV parser: FOREIGN TAX rows also contain neither
  // "REDEMPTION" nor "REINVEST" but must not fall through to DIVIDEND).
  if (FOREIGN_TAX_RX.test(upper)) {
    const ticker = extractTicker(description, [TRAILING_TICKER_RX, FOREIGN_TAX_STRIP_RX]);
    if (!ticker || !isFinite(amountNum) || amountNum === 0) {
      return { unmapped: unmappedItem("foreign tax matched but ticker/amount not extractable") };
    }
    return {
      bondIncome: { id: newId(), date, ticker, amount: Math.abs(amountNum), kind: "tax", source: "simplefin", simplefinId },
    };
  }

  // Dividends — excludes reinvestment rows (same amount immediately
  // reinvested, not a cash payment).
  if (DIVIDEND_RX.test(upper) && !REINVEST_RX.test(upper)) {
    const ticker = extractTicker(description, [TRAILING_TICKER_RX]);
    if (!ticker || !isFinite(amountNum) || amountNum <= 0) {
      return { unmapped: unmappedItem("dividend matched but ticker/amount not extractable") };
    }
    return {
      bondIncome: { id: newId(), date, ticker, amount: amountNum, kind: "dividend", source: "simplefin", simplefinId },
    };
  }

  // Bond/CD interest. The cash-sweep cycle ("EARNED CASH"/"REINVESTMENT
  // CASH") was already excluded above, so anything reaching here is a real
  // CD/bond coupon payment.
  //
  // As of jul/2026 the interest description was observed to sometimes carry
  // the bond's FULL "Symbol Description" text (issuer + coupon% + maturity,
  // e.g. "INTEREST WELLS FARGO BANK NATL ASSN CD 3.95000% 05/08/2029
  // (Cash)"), not just the bare issuer name the original implementation
  // assumed. When that's the case, extractBondMeta gives an exact,
  // non-ambiguous descKey directly from this transaction's own text — no
  // cross-referencing needed, and no risk of confusing two bonds from the
  // same issuer with different coupons/maturities (the bug this branch used
  // to have: normalizing away everything after the issuer name collapsed
  // "WELLS FARGO ... 3.95% 05/08/2029" and "WELLS FARGO ... 3.80% 05/08/2029"
  // into the same lookup, meaning neither could ever match a holding's
  // shortName-only text and both fell through to "no resolution attempted").
  //
  // When the description doesn't parse into coupon+maturity (older/leaner
  // format, issuer name only), fall back to the original approach:
  // cross-reference the issuer name against this account's HOLDINGS array
  // (which DOES carry the full description with coupon/maturity for
  // bank-bond-shaped positions) — only when exactly one holding's shortName
  // matches the issuer exactly (after normalization). Any ambiguity (0 or 2+
  // matches) is left alone; approximate/fuzzy matches are never attempted, to
  // avoid ever resolving to the wrong bond.
  if (INTEREST_RX.test(upper)) {
    const ticker = extractTicker(description, [TRAILING_TICKER_RX, INTEREST_PREFIX_RX]);
    if (!ticker || !isFinite(amountNum) || amountNum <= 0) {
      return { unmapped: unmappedItem("interest matched but ticker/amount not extractable") };
    }
    const ev = { id: newId(), date, ticker, amount: amountNum, kind: "interest", source: "simplefin", simplefinId };

    // Two sources, in order: the metadata on the user's own buy transactions
    // (automatic, needs coupon+maturity+issuer saved), then the persisted
    // bind the user confirmed by picking a CUSIP in the Fidelity Income
    // dropdown. The second exists because the first can never learn a bond
    // whose buy has no coupon/maturity metadata — see the function header.
    const resolveDescKey = (descKey) => {
      const bound = bondBindings && bondBindings[descKey];
      return (
        knownBondsByDescKey.get(descKey) ||
        (bound ? String(bound).trim().toUpperCase() : null)
      );
    };

    // Path 1: the interest description itself carries coupon%+maturity --
    // an exact, unambiguous identity, no cross-referencing required.
    const selfMeta = extractBondMeta(ticker);
    if (selfMeta && selfMeta.shortName) {
      const resolvedCusip = resolveDescKey(selfMeta.descKey);
      if (resolvedCusip) {
        ev.ticker = resolvedCusip;
      } else {
        ev.descKey = selfMeta.descKey;
      }
      return { bondIncome: ev };
    }

    // Path 2 (fallback): description is issuer-name-only -- cross-reference
    // against this account's holdings by shortName, same conservative
    // 0-or-2+-matches-means-no-resolution rule as before.
    const normalizedIssuer = ticker.toUpperCase().replace(/\s+/g, " ").trim();
    const matches = [];
    for (const h of bankBondHoldings(account)) {
      const meta = extractBondMeta(String(h?.description || ""));
      if (!meta || !meta.shortName) continue;
      const normalizedShortName = meta.shortName.toUpperCase().replace(/\s+/g, " ").trim();
      if (normalizedShortName === normalizedIssuer) matches.push(meta);
    }
    if (matches.length === 1) {
      const meta = matches[0];
      const resolvedCusip = resolveDescKey(meta.descKey);
      if (resolvedCusip) {
        // Exact single match against a bond the user already has a buy
        // transaction for (or has explicitly bound) — safe to overwrite the
        // placeholder issuer name with the real CUSIP so downstream consumers
        // (Dividends, Performance) match on the same key as the purchase.
        ev.ticker = resolvedCusip;
      } else {
        // Matched exactly one holding, but nothing resolves it to a CUSIP
        // yet — keep the issuer name as `ticker` (status quo) and carry the
        // descKey, which is what lets the client persist the user's dropdown
        // pick as a bind (src/Transactions.jsx approvePendingFidBond) so this
        // same bond never has to be resolved by hand again.
        ev.descKey = meta.descKey;
      }
    }
    // 0 or 2+ matches: no resolution attempted — `ticker` stays the issuer
    // name, no `descKey` added.
    return { bondIncome: ev };
  }

  // Bond/CD redemption (maturity): face value paid back -> a sell that zeroes
  // the position, same convention the CSV parser uses for REDEMPTION rows.
  // No CUSIP is available in this feed, so the bond's own description text
  // becomes the transaction's ticker (a placeholder the user can correct
  // later via the normal inline-edit in the transactions table).
  if (REDEMPTION_RX.test(upper)) {
    const bondName = extractTicker(description, [REDEMPTION_STRIP_RX]);
    if (!bondName || !isFinite(amountNum) || amountNum <= 0) {
      return { unmapped: unmappedItem("redemption matched but bond name/amount not extractable") };
    }
    const amountAbs = Math.abs(amountNum);
    return {
      transaction: {
        id: newId(),
        date,
        side: "sell",
        ticker: bondName,
        assetClass: "Bank Bonds",
        qty: amountAbs / 1000,
        price: 1000,
        currency: "USD",
        fee: 0,
        notes: description,
        redemption: true,
        source: "simplefin",
        simplefinId,
        createdAt: new Date().toISOString(),
      },
    };
  }

  // Stock buy/sell — heuristic only (no real example seen). SimpleFin's
  // standard transaction schema has no structured qty/price, only a signed
  // total `amount`, so this can never become a valid transaction. Surfaced
  // for manual entry rather than guessed at.
  if (TRADE_RX.test(upper)) {
    return { unmapped: unmappedItem("buy/sell recognized but SimpleFin has no structured qty/price — enter manually") };
  }

  return { unmapped: unmappedItem("unrecognized description") };
}

// Cash + Bank Bonds balance snapshots for one Fidelity account. `id` is
// deterministic (per account + kind) so repeated syncs upsert the same
// candidate instead of accumulating duplicates. Returns
// `{ candidates, skipped }` — `skipped` surfaces holdings that were excluded
// from the Bank Bonds sum for a reason worth a human looking at (currently:
// unparseable market_value), same unmappedItem-ish shape as mapOneTransaction
// so it can be merged straight into `unmapped` for the staging UI.
function computeBalanceCandidates(account) {
  const candidates = [];
  const skipped = [];
  const asOf = unixToDateOnly(account?.["balance-date"]);
  const holdings = Array.isArray(account?.holdings) ? account.holdings : [];

  const availableBalance = toNumber(account?.["available-balance"]);
  let cashValue = isFinite(availableBalance) ? availableBalance : null;
  if (cashValue === null) {
    const cashHolding = holdings.find(
      (h) => String(h?.description || "").trim().toUpperCase() === "CASH"
    );
    const hv = cashHolding ? toNumber(cashHolding.market_value ?? cashHolding["market-value"]) : NaN;
    if (isFinite(hv)) cashValue = hv;
  }
  if (cashValue !== null) {
    candidates.push({
      id: `simplefin-cash-${account.id}`,
      kind: "cash",
      accountId: account.id,
      accountName: account.name,
      proposed: cashValue,
      asOf,
    });
  }

  let bankBondsSum = 0;
  let sawBankBondHolding = false;
  // Holdings with a symbol are stocks/ETFs, not bank bonds — not reported
  // here (correct exclusion, not an error worth surfacing). The CASH
  // synthetic holding also has symbol === "" — must be excluded here too,
  // or the cash balance would double-count into Bank Bonds. See
  // bankBondHoldings() above (shared with the INTEREST auto-resolution path).
  for (const h of bankBondHoldings(account)) {
    const mv = toNumber(h.market_value ?? h["market-value"]);
    if (!isFinite(mv)) {
      // Looked like a bank-bonds-style holding (no symbol, not CASH) but the
      // feed didn't carry a usable market_value — excluding it silently
      // would understate the Bank Bonds total with no trace, so it goes to
      // `skipped` (merged into `unmapped` by mapSimplefinPayload) instead.
      skipped.push({
        accountId: account.id,
        accountName: account.name,
        date: asOf,
        description: h?.description ?? "",
        amount: null,
        reason: "bank-bonds holding has no valid market_value — excluded from Bank Bonds total",
      });
      continue;
    }
    bankBondsSum += mv;
    sawBankBondHolding = true;
  }
  if (sawBankBondHolding) {
    candidates.push({
      id: `simplefin-bank-bonds-${account.id}`,
      kind: "bank-bonds",
      accountId: account.id,
      accountName: account.name,
      proposed: bankBondsSum,
      asOf,
    });
  }

  return { candidates, skipped };
}

// Maps a raw SimpleFin `/accounts` payload ({ accounts: [...], errors: [...] })
// to the app's staging shape. Filters to Fidelity accounts internally — never
// maps holdings/transactions from any other linked institution.
// `knownBondsByDescKey` (optional, see lib/bond-meta.js buildKnownBondsByDescKey)
// is forwarded to mapOneTransaction so bond INTEREST rows can auto-resolve to
// a real CUSIP when the caller has one built from the user's live
// transactions (see api/fidelity-pending.js handleSync). Omit it (or pass
// nothing) to get the pre-feature behavior.
// `netQtyByTicker` (optional, see computeNetQty above) is forwarded to
// stockPositionDeltas so stock/ETF holdings can be diffed against the user's
// known positions (see api/fidelity-pending.js handleSync). Omit it to skip
// delta detection entirely (pre-feature behavior — no stock deltas emitted).
// `bondBindings` (optional, descKey -> CUSIP) is forwarded to
// mapOneTransaction as the second INTEREST resolution source — the user's own
// confirmed binds, persisted in the staging blob. Omit it to get the
// pre-feature behavior (knownBondsByDescKey only).
// `liveTransactions` (optional, the RAW array behind `netQtyByTicker` -- not
// the aggregated map) is forwarded to stockPositionDeltas so it can compute a
// settled-as-of-snapshot qty per ticker and guard against the same-day
// snapshot-lag false positive documented above stockPositionDeltas (aug/2026
// bugfix). Omit it to get the pre-fix behavior.
export function mapSimplefinPayload(
  payload,
  { knownBondsByDescKey, netQtyByTicker, bondBindings, liveTransactions } = {}
) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const transactions = [];
  const bondIncome = [];
  const balanceCandidates = [];
  const unmapped = [];
  const bondHoldings = [];

  for (const account of accounts) {
    if (!isFidelityOrg(account?.org)) continue;

    const { candidates, skipped } = computeBalanceCandidates(account);
    balanceCandidates.push(...candidates);
    unmapped.push(...skipped);
    bondHoldings.push(...extractBondHoldingsList(account));

    // New bonds discovered in the holdings snapshot become buy transactions
    // (the third data-entry path alongside manual + CSV import). Only bonds
    // the user doesn't already own are synthesized; existing ones are skipped
    // via knownBondsByDescKey. See bondBuyTransactions() above.
    transactions.push(
      ...bondBuyTransactions(
        account,
        knownBondsByDescKey instanceof Map ? knownBondsByDescKey : new Map()
      )
    );

    // Stock/ETF position deltas discovered in the holdings snapshot become
    // buy/sell transactions the same way — see stockPositionDeltas above.
    if (netQtyByTicker && typeof netQtyByTicker === "object") {
      const deltas = stockPositionDeltas(
        account,
        netQtyByTicker,
        Array.isArray(liveTransactions) ? liveTransactions : null
      );
      transactions.push(...deltas.transactions);
      unmapped.push(...deltas.unmapped);
    }

    const txs = Array.isArray(account.transactions) ? account.transactions : [];
    for (const tx of txs) {
      const mapped = mapOneTransaction(
        tx,
        account,
        knownBondsByDescKey instanceof Map ? knownBondsByDescKey : new Map(),
        bondBindings && typeof bondBindings === "object" && !Array.isArray(bondBindings)
          ? bondBindings
          : {}
      );
      if (mapped.excluded) continue;
      if (mapped.transaction) transactions.push(mapped.transaction);
      else if (mapped.bondIncome) bondIncome.push(mapped.bondIncome);
      else if (mapped.unmapped) unmapped.push(mapped.unmapped);
    }
  }

  return { transactions, bondIncome, balanceCandidates, unmapped, bondHoldings };
}
