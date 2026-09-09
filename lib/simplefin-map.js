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
//   - Buy/sell of stocks and bond purchases: no real example was seen in the
//     90 days of the Fase 0 probe, so everything about trade rows is
//     heuristic, never observed fact. They used to be routed straight to
//     `unmapped` on the assumption that SimpleFin's schema carries only a
//     signed total `amount` and never a qty -- an extrapolation from the
//     standard schema, NOT something the probe confirmed. Since sep/2026 they
//     go through reconcileTrades() instead, which tries (1) qty/price
//     reported on the transaction itself, then (2) the holdings snapshot's
//     share delta, and only then (3) `unmapped` -- still never inventing a
//     qty. See the reconcileTrades header for the full rationale.
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
//
// ANCHORED (set/2026), for the same reason already documented for
// EXCLUDE_CORE_SWEEP_RX and TRADE_ANCHORED_RX. A SimpleFin description is
// "<Action> <security name> (Cash)", and the CSV parser this rule was ported
// from only ever tests "EARNED CASH" against the ACTION column — never
// against the security name. The unanchored port did test the security name,
// so any bond or CD whose name contains those words was dropped BEFORE the
// INTEREST branch could see it, and `{ excluded }` leaves no trace: no
// staged row, no unmapped row, nothing in the UI. The whole point of the
// cash-sweep purge is the CORE position, whose row always starts with the
// action, so anchoring loses no real exclusion.
const EXCLUDE_CASH_CYCLE_RX =
  /^(?:INTEREST(?:\s+AS\s+OF\s+\d{4}-\d{2}-\d{2})?\s+EARNED\s+CASH|REINVESTMENT\s+CASH)\b/i;
// Share distributions (paid in shares, not cash) — always excluded, same
// purge category as the CSV parser's DISTRIBUTION guard.
const DISTRIBUTION_RX = /^DISTRIBUTION\b/i;
// External transfer already captured by the Cash balance update — always
// excluded, same purge category as EXCLUDE_CASH_CYCLE_RX / DISTRIBUTION_RX.
const EXCLUDE_EFT_RECEIVED_RX = /^ELECTRONIC FUNDS TRANSFER RECEIVED/i;
// Core-account cash sweep (sep/2026 -- 5 of the 26 real rows the user had
// sitting in "Unmapped — needs review"): Fidelity moving idle cash INTO
// ("PURCHASE INTO CORE ACCOUNT CASH (nnnnnnnnn) (Cash)") or OUT OF
// ("REDEMPTION FROM CORE ACCOUNT ...") the core position's money market fund.
// Not a portfolio event: the net effect is ALREADY inside the account's
// `available-balance`, which is exactly what computeBalanceCandidates turns
// into the Cash balance candidate -- mapping these rows to anything at all
// would double-count the same dollars.
//
// The `^` anchor is load-bearing, not cosmetic: REDEMPTION_RX below
// (/REDEMPTION PAYOUT|^REDEEMED/i) handles REAL bond/CD maturities, and an
// unanchored /REDEMPTION/ here -- tested first, as it must be -- would
// swallow those before they ever reached it. Anchoring to the start of the
// description keeps the two patterns disjoint.
const EXCLUDE_CORE_SWEEP_RX = /^(PURCHASE INTO|REDEMPTION FROM) CORE ACCOUNT\b/i;
// ADR custody / pass-through fee charged against a specific position (e.g.
// "FEE CHARGED ITAU UNIBANCO HLDG S A SPON ADR REP PFD (ITUB) (Cash)").
// Economically identical to foreign tax withheld: a deduction tied to one
// ticker -- which is precisely what the `kind: "tax"` bondIncome shape
// already models end to end (api/dividends.js keeps
// `kind === 'tax' && ticker && date && amount > 0` and renders it as a
// negative totalReceived in src/Dividends.jsx). So this branch only has to
// emit the right shape; nothing downstream changes.
const FEE_CHARGED_RX = /^FEE CHARGED\b/i;
const FOREIGN_TAX_RX = /FOREIGN TAX/i;
const DIVIDEND_RX = /DIVIDEND/i;
const REINVEST_RX = /REINVEST/i;
const INTEREST_RX = /INTEREST/i;
const REDEMPTION_RX = /REDEMPTION PAYOUT|^REDEEMED/i;
const TRADE_RX = /YOU BOUGHT|YOU SOLD/i;
// Anchored form -- the ONE that decides ownership of a row (set/2026 bugfix).
//
// Fidelity descriptions lead with the Action ("YOU BOUGHT ...", "DIVIDEND
// RECEIVED ...", "FEE CHARGED ..."), and everything after it is the
// SECURITY'S NAME. The income regexes below (DIVIDEND_RX, INTEREST_RX) are
// unanchored keyword searches, so they also match the security name -- and
// several real ETFs have an Action word inside their name. Concretely, this
// is what broke: `YOU BOUGHT SCHWAB STRATEGIC TR US DIVIDEND EQUITY ETF
// (SCHD) (Cash)` and the same for NOBL (ProShares S&P 500 DIVIDEND
// Aristocrats) were claimed by the DIVIDEND branch, which sits above the
// trade branch -- so two ~$1,000 PURCHASES were staged as ~$1,000 of
// DIVIDEND INCOME (reported by the user, sep/2026). Both errors at once:
// phantom income in the Dividends history AND a missing buy in the
// portfolio. Same trap waits for any fund whose name contains INTEREST or
// REDEMPTION.
//
// Fix: an anchored action prefix is authoritative and is tested BEFORE any
// unanchored keyword branch. A row that STARTS with "YOU BOUGHT"/"YOU SOLD"
// is a trade no matter what the fund is called; a real SCHD dividend still
// starts with "DIVIDEND RECEIVED ..." and is unaffected.
const TRADE_ANCHORED_RX = /^(YOU BOUGHT|YOU SOLD)\b/i;
// Direction of a trade row ALWAYS comes from these, never from the sign of
// `amount`: in the user's real sep/2026 data buys arrive POSITIVE
// ($759.16 for a VTI buy) while fees arrive negative, so `amount`'s sign
// carries no reliable direction signal for trade rows -- whatever the Fase 0
// probe concluded looking only at cash/dividend rows. Value is always
// Math.abs(amount).
const TRADE_BUY_RX = /YOU BOUGHT/i;
const TRADE_SELL_RX = /YOU SOLD/i;

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
//
// `consumedTickers` (optional Set, sep/2026) lists tickers reconcileTrades()
// already emitted REAL transactions for in this same account -- see the
// mandatory-suppression note in its header. Omitted/null -> nothing is
// skipped (pre-feature behavior).
function stockPositionDeltas(account, netQtyByTicker = {}, liveTransactions = null, consumedTickers = null) {
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

    // reconcileTrades() already turned this ticker's real trade rows into
    // exact transactions (real date, real total, qty from the feed or from
    // THIS very delta). Emitting the approximate delta candidate too would
    // stage the same trade twice: the server's dupKey is
    // `ticker|side|qty|date` (api/fidelity-pending.js) and the two rows carry
    // DIFFERENT dates (real trade date vs this snapshot's balance-date), so
    // the dedupe there cannot catch it. This suppression is the only thing
    // that prevents the duplicate -- not an optimization.
    if (consumedTickers && consumedTickers.has(ticker)) continue;

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

// ---------------------------------------------------------------------------
// Trade reconciliation (sep/2026) -- turns the "YOU BOUGHT"/"YOU SOLD" rows
// that used to be dumped straight into `unmapped` into real, exact
// transactions. This was 18 of the 26 rows the user had accumulated in
// "Unmapped — needs review".
//
// Two independent pieces of evidence about the SAME trade existed side by
// side and never talked to each other:
//   - the SimpleFin transaction row: REAL trade date + EXACT total amount,
//     but no qty -> always routed to `unmapped`.
//   - stockPositionDeltas() above: REAL qty (holdings snapshot vs the user's
//     known net qty), but `date` is the snapshot's balance-date and `price`
//     is an average-cost / market-value approximation (declared in `notes`).
// Crossing them yields all three exactly: qty from the snapshot delta, date
// from the transaction, price = |amount| / qty.
//
// Resolution order, best evidence first:
//   1. qty and/or price reported ON the transaction itself
//      (extractTradeQtyPrice) -- exact, self-sufficient, no snapshot needed.
//   2. the account's snapshot share delta for that ticker (Cases A/B below).
//   3. `unmapped`, now carrying the raw feed fields for diagnosis
//      (collectRawFields). A qty is NEVER invented.
//
// Sign convention (learned from the real data, sep/2026): buys arrive with a
// POSITIVE `amount` and fees with a negative one, so `amount`'s sign is not a
// usable direction signal here. Direction always comes from the description
// text; value is always Math.abs(amount).
//
// Account isolation is mandatory: `netQtyByTicker` is aggregated across ALL
// accounts, but a holdings snapshot belongs to ONE account, so a trade row is
// only ever matched against the delta of the account it was posted in. A
// trade in account A must never consume a delta in account B.

// Plausible spellings for a per-share qty / price carried on a transaction.
// Compared after normalizeFieldName() (lowercased, `_`/`-`/whitespace
// stripped), so "share_count", "Share-Count" and "sharecount" are one entry.
const TRADE_QTY_FIELDS = new Set(["shares", "quantity", "qty", "units", "sharecount"]);
const TRADE_PRICE_FIELDS = new Set([
  "price", "unitprice", "shareprice", "pricepershare", "executionprice",
  "avgprice", "averageprice",
]);

function normalizeFieldName(k) {
  return String(k == null ? "" : k).toLowerCase().replace(/[\s_-]/g, "");
}

// Looks for a qty/price ON the transaction itself -- `extra` first (the
// SimpleFIN protocol's optional per-transaction object for
// institution-specific data, which is exactly where a share count would live
// if Fidelity sends one), then the top-level fields.
//
// EXPLICITLY UNVERIFIED, BY DESIGN: the Fase 0 probe never observed a single
// buy/sell in ~90 days (docs/plans/simplefin-fidelity-feed.md), so the older
// claim that "SimpleFin never reports qty/price" was an extrapolation from
// the standard schema, not an observation -- and the `?resource=probe`
// endpoint that could have answered it was removed in Fase 3. Since the
// spelling Fidelity would use is unknown, this probes a list of plausible
// names case-insensitively. Finds nothing -> returns null and the caller
// degrades silently to the snapshot-delta fallback, so this costs exactly
// nothing if these fields never materialize. collectRawFields() below is the
// companion diagnostic: it preserves whatever unknown keys DID arrive on the
// rows that stayed unresolved, so a field name nobody guessed here can still
// be discovered from the staged blob instead of being thrown away.
//
// Only strictly-positive finite numbers are accepted; anything else (0, "",
// null, an object) is treated as absent.
function extractTradeQtyPrice(tx) {
  if (!tx || typeof tx !== "object") return null;
  const extra = tx.extra && typeof tx.extra === "object" && !Array.isArray(tx.extra) ? tx.extra : null;
  const sources = extra ? [extra, tx] : [tx];
  let qty = NaN;
  let price = NaN;
  let qtyField = null;
  let priceField = null;
  for (const src of sources) {
    for (const key of Object.keys(src)) {
      const norm = normalizeFieldName(key);
      const n = toNumber(src[key]);
      if (!isFinite(n) || n <= 0) continue;
      if (!isFinite(qty) && TRADE_QTY_FIELDS.has(norm)) {
        qty = n;
        qtyField = key;
      }
      if (!isFinite(price) && TRADE_PRICE_FIELDS.has(norm)) {
        price = n;
        priceField = key;
      }
    }
  }
  if (!isFinite(qty) && !isFinite(price)) return null;
  return {
    qty: isFinite(qty) ? qty : null,
    price: isFinite(price) ? price : null,
    qtyField,
    priceField,
  };
}

// Diagnostic snapshot of the fields a transaction carried that this mapper
// does NOT already understand -- attached to unresolved trade rows only.
// Replaces (at near-zero cost) the `?resource=probe` endpoint removed in Fase
// 3: if Fidelity does send a share count under a name extractTradeQtyPrice
// doesn't guess, today that information is silently discarded and nobody can
// ever find out. Kept deliberately small (primitives only, values truncated,
// key count capped) because this is persisted into the staging blob in Redis.
const RAW_FIELDS_KNOWN = new Set([
  "id", "posted", "transactedat", "amount", "description", "extra",
]);
const RAW_FIELDS_MAX_KEYS = 20;
const RAW_FIELDS_MAX_VALUE_LEN = 200;

function collectRawFields(tx) {
  if (!tx || typeof tx !== "object") return null;
  const out = {};
  let count = 0;
  const add = (key, value) => {
    if (count >= RAW_FIELDS_MAX_KEYS) return;
    if (RAW_FIELDS_KNOWN.has(normalizeFieldName(key))) return;
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") return;
    if (Object.prototype.hasOwnProperty.call(out, key)) return;
    out[key] = t === "string" ? value.slice(0, RAW_FIELDS_MAX_VALUE_LEN) : value;
    count++;
  };
  // `extra` first: it is the highest-value place to look, so it must not be
  // crowded out of the key budget by top-level noise.
  const extra = tx.extra && typeof tx.extra === "object" && !Array.isArray(tx.extra) ? tx.extra : null;
  if (extra) {
    for (const key of Object.keys(extra)) add(`extra.${key}`, extra[key]);
  }
  for (const key of Object.keys(tx)) add(key, tx[key]);
  return count > 0 ? out : null;
}

// True when mapOneTransaction would route this description to its TRADE_RX
// branch -- i.e. it looks like a trade AND none of the earlier,
// higher-priority branches claim it first. The precedence is duplicated here
// (instead of just testing TRADE_RX) so reconcileTrades and mapOneTransaction
// can never disagree about who owns a row: a disagreement would either stage
// the row twice or drop it entirely.
function isTradeDescription(upper) {
  if (!TRADE_ANCHORED_RX.test(upper)) return false;
  // The purge categories still win: they are anchored (or match text no
  // "YOU BOUGHT" row can contain), so they can never steal a real trade.
  if (EXCLUDE_CASH_CYCLE_RX.test(upper)) return false;
  if (DISTRIBUTION_RX.test(upper)) return false;
  if (EXCLUDE_EFT_RECEIVED_RX.test(upper)) return false;
  if (EXCLUDE_CORE_SWEEP_RX.test(upper)) return false;
  // Everything below the trade branch in mapOneTransaction (FEE_CHARGED,
  // FOREIGN_TAX, DIVIDEND, INTEREST, REDEMPTION) is deliberately NOT
  // consulted: since set/2026 the anchored action prefix outranks them all,
  // so consulting them here would re-introduce exactly the SCHD/NOBL bug
  // (see TRADE_ANCHORED_RX).
  return true;
}

// "buy" | "sell" | null (null = ambiguous, the description somehow contains
// both -- never guessed at).
function tradeSide(upper) {
  const bought = TRADE_BUY_RX.test(upper);
  const sold = TRADE_SELL_RX.test(upper);
  if (bought && sold) return null;
  if (bought) return "buy";
  if (sold) return "sell";
  return null;
}

// Reconciles one account's trade transaction rows. Returns
// `{ transactions, unmapped, consumedTickers }` -- the same "never invent,
// surface what can't be resolved" shape as the rest of this file.
// `consumedTickers` MUST be forwarded to stockPositionDeltas (see the
// suppression note there).
function reconcileTrades(account, netQtyByTicker = {}, liveTransactions = null) {
  const accountId = account?.id ?? null;
  const accountName = account?.name ?? null;
  const transactions = [];
  const unmapped = [];
  const consumedTickers = new Set();
  const txs = Array.isArray(account?.transactions) ? account.transactions : [];

  // Anti-regression guard (mandatory). Once the user approves a reconciled
  // trade it lands in `liveTransactions` carrying this same `simplefinId`,
  // `knownQty` catches up to the snapshot and the delta disappears -- at
  // which point the next sync would find the very same SimpleFin row with no
  // delta left to resolve it and push it BACK to `unmapped` forever. So a row
  // whose simplefinId is already live is skipped entirely: no transaction, no
  // unmapped item, and no share of any delta (its qty is already inside
  // `knownQty`, so the remaining delta describes only what is still missing).
  const approvedSimplefinIds = new Set(
    (Array.isArray(liveTransactions) ? liveTransactions : [])
      .filter((t) => t && t.simplefinId)
      .map((t) => String(t.simplefinId))
  );

  const unmappedTrade = (row, reason) => ({
    simplefinId: row.simplefinId,
    accountId,
    accountName,
    date: row.date,
    description: row.description,
    amount: isFinite(row.amountRaw) ? row.amountRaw : null,
    reason,
    // Diagnostic only -- see collectRawFields.
    ...(row.rawFields ? { rawFields: row.rawFields } : {}),
  });

  const makeTrade = (row, qty, price, notes, flags) => ({
    id: newId(),
    date: row.date,
    side: row.side,
    ticker: row.ticker,
    assetClass: inferAssetClassForDelta(row.ticker),
    qty,
    price,
    currency: "USD",
    fee: 0,
    notes,
    source: "simplefin",
    // The transaction's OWN id, one per real trade. Deliberately NOT the
    // delta's `sfstock-delta:<acct>:<ticker>:<sharesNew>`: when two trades of
    // the same ticker share one delta (the real XLRE case) they would all
    // collapse onto that single id and collide in the server's dedupe.
    simplefinId: row.simplefinId,
    reconciledFromTransaction: true,
    ...flags,
    createdAt: new Date().toISOString(),
  });

  // Pass 1: classify every trade row. Feed-reported qty/price wins here and
  // never needs a snapshot; everything else is grouped per ticker for pass 2.
  const groups = new Map();
  // Signed qty already emitted from the feed path, per ticker -- subtracted
  // from the snapshot delta in pass 2 so sibling rows of the same ticker
  // don't get allocated shares the feed path already accounted for.
  const feedQtyByTicker = new Map();

  for (const tx of txs) {
    const description = String(tx?.description || "").trim();
    if (!description) continue;
    const upper = description.toUpperCase();
    if (!isTradeDescription(upper)) continue;

    const date = unixToDateOnly(tx?.posted ?? tx?.transacted_at);
    // A row with no usable date never reaches mapOneTransaction's TRADE
    // branch (it bails earlier with "missing/invalid posted date"), so
    // mapOneTransaction still owns it. Claiming it here too would report the
    // same row twice.
    if (!date) continue;

    const simplefinId = tx?.id != null ? String(tx.id) : null;
    if (simplefinId && approvedSimplefinIds.has(simplefinId)) continue;

    const amountRaw = toNumber(tx?.amount);
    const amountAbs = Math.abs(amountRaw);
    const row = {
      simplefinId,
      date,
      description,
      amountRaw,
      amountAbs,
      side: tradeSide(upper),
      ticker: extractTicker(description, [TRAILING_TICKER_RX]),
      rawFields: collectRawFields(tx),
    };

    if (!row.side) {
      unmapped.push(unmappedTrade(row, "buy/sell recognized but the description names both a buy and a sell -- enter manually"));
      continue;
    }
    if (!row.ticker) {
      unmapped.push(unmappedTrade(row, "buy/sell recognized but no ticker could be extracted from the description -- enter manually"));
      continue;
    }
    if (!isFinite(amountAbs) || amountAbs <= 0) {
      unmapped.push(unmappedTrade(row, "buy/sell recognized but SimpleFin reported no usable amount -- enter manually"));
      continue;
    }

    const feed = extractTradeQtyPrice(tx);
    if (feed && (feed.qty > 0 || feed.price > 0)) {
      let qty;
      let price;
      let notes;
      if (feed.qty > 0) {
        qty = feed.qty;
        // price is always DERIVED from the exact total, never taken from the
        // reported per-share price: it keeps qty x price === |amount| to the
        // cent, which is what every downstream cost-basis consumer assumes.
        price = amountAbs / qty;
        notes = "Trade imported from the SimpleFin transaction: quantity reported by the feed, price = total / quantity. Exact.";
        if (feed.price > 0 && Math.abs(feed.price - price) > 0.01 * price) {
          // >1% apart usually means `amount` bundles a commission/fee that
          // the reported per-share price excludes. Keep the derived price
          // (total stays exact) but record what the feed claimed.
          notes += ` Feed also reported a per-share price of ${feed.price}, which differs from total/quantity -- the total may include fees.`;
        }
      } else {
        qty = amountAbs / feed.price;
        price = feed.price;
        notes = "Trade imported from the SimpleFin transaction: per-share price reported by the feed, quantity = total / price.";
      }
      transactions.push(makeTrade(row, qty, price, notes, { qtyFromFeed: true }));
      consumedTickers.add(row.ticker);
      const signed = (row.side === "buy" ? 1 : -1) * qty;
      feedQtyByTicker.set(row.ticker, (feedQtyByTicker.get(row.ticker) || 0) + signed);
      continue;
    }

    if (!groups.has(row.ticker)) groups.set(row.ticker, []);
    groups.get(row.ticker).push(row);
  }

  // Pass 2: fall back to the holdings snapshot's share delta, per ticker,
  // WITHIN THIS ACCOUNT ONLY.
  const holdingsByTicker = new Map();
  for (const h of stockHoldings(account)) {
    const t = String(h?.symbol || "").trim().toUpperCase();
    if (t && !holdingsByTicker.has(t)) holdingsByTicker.set(t, h);
  }

  for (const [ticker, rows] of groups) {
    const bail = (reason) => {
      for (const row of rows) unmapped.push(unmappedTrade(row, reason));
    };

    // Mixed buys AND sells for one ticker in the same sync: a single net
    // delta cannot be split between opposite directions without inventing the
    // split, so nothing is reconciled and the ticker is NOT consumed --
    // stockPositionDeltas still stages its approximate delta candidate, i.e.
    // exactly the pre-feature behavior.
    const sides = new Set(rows.map((r) => r.side));
    if (sides.size !== 1) {
      bail("buy/sell recognized but this ticker has both buys and sells in the same sync -- the holdings snapshot delta cannot be split between them -- enter manually");
      continue;
    }
    const side = rows[0].side;
    const dir = side === "buy" ? 1 : -1;

    const rawKnown = netQtyByTicker ? netQtyByTicker[ticker] : undefined;
    const knownQty = isFinite(Number(rawKnown)) ? Number(rawKnown) : 0;
    const holding = holdingsByTicker.get(ticker);
    const sharesNew = holding ? toNumber(holding.shares) : NaN;
    const hasSnapshot = !!holding && isFinite(sharesNew) && sharesNew >= 0;

    // Case A: the ticker is in this account's snapshot -> the delta is the
    // same figure stockPositionDeltas would have used (sharesNew - knownQty).
    // Case B: full liquidation -- an explicit "YOU SOLD" row for a ticker
    // that is ABSENT from the snapshot while knownQty > 0 is treated as a
    // sale of the whole position (effective shares = 0). stockPositionDeltas
    // deliberately does NOT detect an absent ticker (see its header: absent
    // could simply mean "held in another Fidelity account"), and that caution
    // is still right THERE -- but here the ambiguity is gone: a confirmed
    // "YOU SOLD" row was posted in THIS account, so the position really did
    // leave it. This also closes the documented hole where a liquidation
    // listed at exactly 0 shares had no market value left to price a sell
    // from and was pushed to `unmapped`.
    let effectiveShares = null;
    if (hasSnapshot) effectiveShares = sharesNew;
    else if (side === "sell" && knownQty > 0) effectiveShares = 0;
    if (effectiveShares === null) {
      bail("buy/sell recognized but SimpleFin reported no qty/price and this account's holdings snapshot has no matching position to derive one -- enter manually");
      continue;
    }

    // Whatever the feed path already resolved for this ticker is part of the
    // delta too, so it is removed before splitting the remainder.
    const delta = effectiveShares - knownQty - (feedQtyByTicker.get(ticker) || 0);
    // Sign consistency: net buys must move the position up, net sells down.
    // If they disagree, the delta describes something these rows do not (a
    // corporate action, another account, a partially recorded trade) --
    // reconcile nothing and keep today's behavior.
    if (!(delta * dir > 1e-9)) {
      bail("buy/sell recognized but the holdings snapshot delta does not match the direction of these trades -- enter manually");
      continue;
    }

    const target = Math.abs(delta);
    const totalAbs = rows.reduce((sum, r) => sum + r.amountAbs, 0);
    if (!(totalAbs > 0)) {
      bail("buy/sell recognized but SimpleFin reported no usable amount -- enter manually");
      continue;
    }

    // Split the delta across the ticker's trades proportionally to each
    // trade's total. For one trade this is exact. For two or more (the real
    // case: XLRE bought on 08-21 AND on 09-04) the per-trade split is an
    // approximation of the intra-ticker allocation, but the SUM of the
    // quantities matches the snapshot exactly -- which is the invariant that
    // matters: the final position and the total cost are both exactly right.
    // The last slice takes the residue so rounding never leaves dust.
    const qtys = [];
    let allocated = 0;
    for (let i = 0; i < rows.length; i++) {
      const qty = i === rows.length - 1 ? target - allocated : (target * rows[i].amountAbs) / totalAbs;
      allocated += qty;
      qtys.push(qty);
    }
    if (qtys.some((q) => !isFinite(q) || q <= 0)) {
      bail("buy/sell recognized but the holdings snapshot delta is too small to split across these trades -- enter manually");
      continue;
    }

    rows.forEach((row, i) => {
      const qty = qtys[i];
      const notes =
        rows.length > 1
          ? "Trade reconciled from the SimpleFin transaction (real date and total) against the holdings snapshot. This ticker has more than one trade sharing a single snapshot delta: the quantity split between them is proportional to each trade's total, so the per-trade quantity is an approximation while the ticker's total quantity and total cost are exact."
          : hasSnapshot
            ? "Trade reconciled from the SimpleFin transaction (real date and total) and the holdings snapshot share delta. Price = total / quantity. Exact."
            : "Full liquidation reconciled from the SimpleFin sell transaction: quantity is your full known position for this ticker, price = total / quantity. Exact.";
      transactions.push(makeTrade(row, qty, row.amountAbs / qty, notes, { reconciledFromDelta: true }));
    });
    consumedTickers.add(ticker);
  }

  return { transactions, unmapped, consumedTickers };
}

// Maps a single SimpleFin transaction to one of:
//   { excluded: "<reason>" }         — intentionally dropped; not staged, but
//                                      counted and described so a drop is
//                                      never invisible (see mapSimplefinPayload's
//                                      `excluded` array)
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
// `tradesHandledElsewhere` (sep/2026) tells this function that
// reconcileTrades() already ran for this account and OWNS every trade row --
// including the ones it could not resolve, which it routes to `unmapped`
// itself. See the TRADE_RX branch at the bottom.
function mapOneTransaction(
  tx,
  account,
  knownBondsByDescKey = new Map(),
  bondBindings = {},
  tradesHandledElsewhere = false
) {
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

  // Intentional drops carry a reason for the same reason `unmapped` rows do:
  // "the feed never sent it" and "we threw it away on purpose" are different
  // answers to "why is this Fidelity row missing from the app?", and before
  // set/2026 the sync response could not tell them apart at all.
  const excludedItem = (reason) => ({
    excluded: reason,
    item: { simplefinId, accountId, accountName, date, description, amount: isFinite(amountNum) ? amountNum : null, reason },
  });

  if (!description) return { unmapped: unmappedItem("missing description") };
  if (!date) return { unmapped: unmappedItem("missing/invalid posted date") };

  if (EXCLUDE_CASH_CYCLE_RX.test(upper)) return excludedItem("core-cash sweep cycle");
  if (DISTRIBUTION_RX.test(upper)) return excludedItem("share distribution (not cash)");
  if (EXCLUDE_EFT_RECEIVED_RX.test(upper))
    return excludedItem("external transfer already in the Cash balance");
  // Core-account cash sweep — tested BEFORE the REDEMPTION_RX branch below,
  // which is why EXCLUDE_CORE_SWEEP_RX is anchored (see its definition).
  if (EXCLUDE_CORE_SWEEP_RX.test(upper)) return excludedItem("core-account cash sweep");

  // Anchored trade — tested BEFORE every unanchored keyword branch below.
  // See TRADE_ANCHORED_RX for the bug this ordering fixes (a fund whose NAME
  // contains "DIVIDEND" had its purchase staged as dividend income).
  if (TRADE_ANCHORED_RX.test(upper)) {
    if (tradesHandledElsewhere) return excludedItem("trade owned by reconcileTrades");
    const rawFieldsT = collectRawFields(tx);
    return {
      unmapped: {
        ...unmappedItem("buy/sell recognized but SimpleFin has no structured qty/price — enter manually"),
        ...(rawFieldsT ? { rawFields: rawFieldsT } : {}),
      },
    };
  }

  // ADR/custody fee charged against a position -> the same `kind: "tax"`
  // income event shape as foreign tax withheld (see FEE_CHARGED_RX above).
  // Checked here, before FOREIGN TAX / DIVIDEND / INTEREST, for the same
  // ordering reason already documented for FOREIGN TAX vs DIVIDEND: the
  // issuer's legal name is embedded in the description and can contain words
  // that collide with those looser, unanchored patterns (the real NVO row
  // reads "FEE CHARGED NOVO NORDISK A/S ADR-EACH CNV INTO 1..."), so the
  // specific anchored pattern has to win.
  if (FEE_CHARGED_RX.test(upper)) {
    const ticker = extractTicker(description, [TRAILING_TICKER_RX]);
    if (!ticker || !isFinite(amountNum) || amountNum === 0) {
      return { unmapped: unmappedItem("fee charged matched but ticker/amount not extractable") };
    }
    // Math.abs: the fee posts as a debit (negative), but the consumer
    // (api/dividends.js) filters on `amount > 0` and applies the negative
    // sign itself when rendering — same convention as the FOREIGN TAX branch.
    return {
      bondIncome: { id: newId(), date, ticker, amount: Math.abs(amountNum), kind: "tax", source: "simplefin", simplefinId },
    };
  }

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

  // Stock buy/sell. When trade reconciliation is active (sep/2026,
  // reconcileTrades) it is the sole owner of these rows — it emits the
  // resolved ones as transactions and pushes the unresolved ones to
  // `unmapped` itself, so returning anything but `excluded` here would make
  // the same line appear twice.
  if (TRADE_RX.test(upper)) {
    if (tradesHandledElsewhere) return excludedItem("trade owned by reconcileTrades");
    // Legacy path (no `netQtyByTicker` passed by the caller): unchanged
    // pre-feature behavior, now also carrying the raw feed fields so an
    // unguessed qty/price field name can still be discovered from the staged
    // blob instead of being discarded.
    const rawFields = collectRawFields(tx);
    return {
      unmapped: {
        ...unmappedItem("buy/sell recognized but SimpleFin has no structured qty/price — enter manually"),
        ...(rawFields ? { rawFields } : {}),
      },
    };
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
// It is ALSO the single switch for trade reconciliation (sep/2026): omit it
// and YOU BOUGHT/YOU SOLD rows keep going straight to `unmapped` exactly like
// before, same "omit the param for pre-feature behavior" convention. The
// feed-reported-qty path inside reconcileTrades does not itself need
// `netQtyByTicker`, but it stays behind the same switch so there is exactly
// one flag deciding who owns trade rows (api/fidelity-pending.js always
// passes it).
// `bondBindings` (optional, descKey -> CUSIP) is forwarded to
// mapOneTransaction as the second INTEREST resolution source — the user's own
// confirmed binds, persisted in the staging blob. Omit it to get the
// pre-feature behavior (knownBondsByDescKey only).
// `liveTransactions` (optional, the RAW array behind `netQtyByTicker` -- not
// the aggregated map) is forwarded to stockPositionDeltas so it can compute a
// settled-as-of-snapshot qty per ticker and guard against the same-day
// snapshot-lag false positive documented above stockPositionDeltas (aug/2026
// bugfix). Omit it to get the pre-fix behavior.
// SimpleFin returns `errors: []` for two very different things: real failures
// ("Connection to <bank> failed", "Account needs re-authentication") and
// purely informational notices about the requested date range. Only the
// former should ever become `lastError`, which src/App.jsx renders as
// "SimpleFin: falha ao sincronizar" and the Transactions tab shows in red.
//
// Before set/2026 there was no such split, and the workaround was to shrink
// the request window below the range SimpleFin advises about (44 days) purely
// so the advisory never fired -- which silently gave up half the available
// history and is why bond coupons older than ~6 weeks never synced. Splitting
// them here is what lets api/fidelity-pending.js ask for the full window
// again. Advisories are surfaced, never swallowed: they just get their own
// field.
//
// Conservative by construction: anything that does not clearly read as a
// date-range notice stays a failure. Mis-hiding a real error is the worse of
// the two mistakes, so the patterns match the range vocabulary specifically
// rather than generic words like "warning".
const SIMPLEFIN_ADVISORY_RX = /date[- ]?range|start[- ]?date|end[- ]?date|\bcapped\b/i;

export function classifySimplefinErrors(errors) {
  const advisories = [];
  const failures = [];
  for (const raw of Array.isArray(errors) ? errors : []) {
    const msg = String(raw ?? "").trim();
    if (!msg) continue;
    (SIMPLEFIN_ADVISORY_RX.test(msg) ? advisories : failures).push(msg);
  }
  return {
    lastError: failures.length ? failures.join("; ") : null,
    lastAdvisory: advisories.length ? advisories.join("; ") : null,
  };
}

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
  // Rows dropped on purpose (cash sweep, share distributions, …). NOT staged
  // and NOT shown as work to do — the caller reports them as counts so an
  // empty sync can be explained instead of just looking broken.
  const excluded = [];
  // What the feed actually delivered for Fidelity, before any classification.
  // This is the other half of the "why is my row missing?" answer: a row that
  // is not in `fetched` was never sent by SimpleFin (window too short, feed
  // lag), which no amount of mapper tuning can fix.
  const fetched = { accounts: 0, transactions: 0 };

  for (const account of accounts) {
    if (!isFidelityOrg(account?.org)) continue;
    fetched.accounts++;
    fetched.transactions += Array.isArray(account.transactions) ? account.transactions.length : 0;

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

    // Trade reconciliation runs BEFORE the holdings diff: it produces the
    // exact trades (real date + real total) and reports which tickers it
    // consumed, so the approximate delta candidate for those same tickers is
    // suppressed instead of being staged as a duplicate (see the note in
    // stockPositionDeltas — the server's dupKey cannot catch it, the dates
    // differ).
    const reconciled =
      netQtyByTicker && typeof netQtyByTicker === "object"
        ? reconcileTrades(
            account,
            netQtyByTicker,
            Array.isArray(liveTransactions) ? liveTransactions : null
          )
        : null;
    if (reconciled) {
      transactions.push(...reconciled.transactions);
      unmapped.push(...reconciled.unmapped);
    }

    // Stock/ETF position deltas discovered in the holdings snapshot become
    // buy/sell transactions the same way — see stockPositionDeltas above.
    if (netQtyByTicker && typeof netQtyByTicker === "object") {
      const deltas = stockPositionDeltas(
        account,
        netQtyByTicker,
        Array.isArray(liveTransactions) ? liveTransactions : null,
        reconciled ? reconciled.consumedTickers : null
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
          : {},
        !!reconciled
      );
      if (mapped.excluded) {
        if (mapped.item) excluded.push(mapped.item);
        continue;
      }
      if (mapped.transaction) transactions.push(mapped.transaction);
      else if (mapped.bondIncome) bondIncome.push(mapped.bondIncome);
      else if (mapped.unmapped) unmapped.push(mapped.unmapped);
    }
  }

  return { transactions, bondIncome, balanceCandidates, unmapped, bondHoldings, excluded, fetched };
}
