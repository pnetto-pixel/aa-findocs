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
const EXCLUDE_CASH_CYCLE_RX = /EARNED CASH|REINVESTMENT CASH/i;
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
// Net qty per ticker, duplicated from src/App.jsx's computeNetQty (same
// project convention as other small client/server duplicated helpers — see
// docs/CONTEXT.md) so this can run server-side (api/fidelity-pending.js
// handleSync) without importing a frontend module. Used by reconcileTrades
// below to know each ticker's known position before applying a holdings
// snapshot delta.
//
// Sep/2026: this file used to also derive BUY/SELL candidates directly from
// a holdings-snapshot share delta with no corroborating SimpleFin transaction
// at all (stockPositionDeltas, since removed) — an estimate, priced at
// average cost/market value, never a real trade. The user decided this
// invited exactly the kind of error reconcileTrades exists to avoid: no more
// estimates synthesized purely from a share-count difference, only real
// SimpleFin transaction rows or a CSV/manual entry. reconcileTrades below is
// now the sole producer of trade candidates from a holdings snapshot, and it
// always anchors to a real "YOU BOUGHT"/"YOU SOLD" transaction row.
//
// `beforeDate` (optional, "YYYY-MM-DD") restricts the sum to transactions
// dated STRICTLY before that day. Omitting it preserves the original
// unrestricted behavior, used everywhere else this function is called.
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

// ---------------------------------------------------------------------------
// Trade reconciliation (sep/2026) -- turns the "YOU BOUGHT"/"YOU SOLD" rows
// that used to be dumped straight into `unmapped` into real, exact
// transactions. This was 18 of the 26 rows the user had accumulated in
// "Unmapped — needs review".
//
// Two independent pieces of evidence about the SAME trade exist side by side:
//   - the SimpleFin transaction row: REAL trade date + EXACT total amount,
//     but usually no qty -> would otherwise be routed to `unmapped`.
//   - the account's HOLDINGS snapshot: REAL current share count, which
//     (compared against the user's already-known net qty) yields a REAL qty
//     delta for the ticker, though not tied to any one specific trade date.
// Crossing them yields all three exactly: qty from the snapshot delta, date
// from the transaction, price = |amount| / qty.
//
// Resolution order, best evidence first:
//   1. qty and/or price reported ON the transaction itself
//      (extractTradeQtyPrice) -- exact, self-sufficient, no snapshot needed.
//   2. the account's snapshot share delta for that ticker, but ONLY when
//      exactly one trade row for that ticker is left unresolved in this sync
//      window (Cases A/B below).
//   3. `unmapped`, now carrying the raw feed fields for diagnosis
//      (collectRawFields). A qty is NEVER invented.
//
// No proportional split (sep/2026 bugfix, "the August case"). This function
// used to divide a ticker's snapshot delta across ALL of that ticker's
// unresolved trade rows in the sync window, proportionally to each row's
// total -- e.g. a real single 3-share VT buy on 09-22 got WRONGLY split
// between an already-recorded 08-21 VT buy (staged earlier from the same
// delta, before the 08-21 trade had a real SimpleFin row to match it) and the
// real 09-22 trade, because both happened to land in the same 44-day sync
// window and share a ticker -- even though the 08-21 half was already fully
// accounted for in the user's records. The user decided this kind of
// inference is no longer acceptable: when MORE THAN ONE row for a ticker is
// still unresolved after the "already recorded" coverage rule below runs, the
// snapshot delta cannot tell how many shares each individual row bought, so
// none of them are guessed at -- all go to `unmapped` with a reason pointing
// at the CSV import / manual entry path instead. Only a single leftover row
// per ticker is still resolved from the delta (Cases A/B).
//
// "Already recorded" coverage rule (sep/2026, closes the actual August
// case): a SimpleFin trade row for ticker T dated D is skipped ENTIRELY (no
// candidate, no unmapped row, no share of any delta) when `liveTransactions`
// already has a buy/sell of the same ticker T dated on or after D whose
// simplefinId is null/empty (a CSV/manual row) or starts with
// `sfstock-delta:` (a legacy holdings-diff estimate approved before this
// feature existed). Concretely: the user approved a VT buy back when this
// file still estimated qty from a snapshot delta (simplefinId
// `sfstock-delta:...`, dated 2026-08-22, price = average cost). The next sync
// then saw the REAL SimpleFin "YOU BOUGHT ... (VT) (Cash)" rows for 08-21 and
// 09-22 -- different ids, non-matching totals, so pruneSemanticallyMatchedTrades
// (below, which only matches id-less legacy rows) could not recognize either
// as already-live, and the ticker's one remaining snapshot delta got split
// between them. The coverage rule recognizes that the 08-21 row is already
// covered by the approved (if approximate) 08-22 record and drops it up
// front, leaving only the genuinely new 09-22 row to resolve via the single-
// row Case A/B path above -- with the FULL delta, not a slice of it. Rows
// whose live counterpart carries a REAL SimpleFin transaction id are still
// matched only by that id (the pre-existing `approvedSimplefinIds` check
// below) -- this rule exists only for the id-less/estimate cases that id
// check cannot catch.
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
// does NOT already understand -- attached to every trade row now (both
// resolved candidates and unresolved unmapped ones, sep/2026), not just
// unresolved ones: the user believes Fidelity may now be sending qty/avg
// price ON trade rows and wants to confirm it even for rows that already
// reconciled successfully via some other path. Replaces (at near-zero cost)
// the `?resource=probe` endpoint removed in Fase 3: if Fidelity does send a
// share count under a name extractTradeQtyPrice doesn't guess, today that
// information is silently discarded and nobody can ever find out. Kept
// deliberately small (primitives, plus one level of nested objects/arrays as
// truncated JSON text, values truncated, key count capped) because this is
// persisted into the staging blob in Redis.
const RAW_FIELDS_KNOWN = new Set([
  "id", "posted", "transactedat", "amount", "description", "extra",
]);
const RAW_FIELDS_MAX_KEYS = 30;
const RAW_FIELDS_MAX_VALUE_LEN = 200;

function collectRawFields(tx) {
  if (!tx || typeof tx !== "object") return null;
  const out = {};
  let count = 0;
  const add = (key, value) => {
    if (count >= RAW_FIELDS_MAX_KEYS) return;
    if (RAW_FIELDS_KNOWN.has(normalizeFieldName(key))) return;
    if (Object.prototype.hasOwnProperty.call(out, key)) return;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") {
      out[key] = t === "string" ? value.slice(0, RAW_FIELDS_MAX_VALUE_LEN) : value;
      count++;
      return;
    }
    // Nested object/array, ONE level deep only (no further recursion): kept
    // as truncated JSON text rather than expanded into more keys, so an
    // unguessed qty/price field buried inside e.g. `extra.trade: { shares: 3
    // }` is still visible without this diagnostic snowballing in size.
    if (value !== null && t === "object") {
      let json;
      try {
        json = JSON.stringify(value);
      } catch {
        return;
      }
      if (!json) return;
      out[key] = json.slice(0, RAW_FIELDS_MAX_VALUE_LEN);
      count++;
    }
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

// Economic identity for a trade that predates SimpleFin ids (for example a
// CSV/manual import). Fidelity's transaction `amount` has historically been
// observed both with and without fees, so both totals are legitimate match
// candidates: gross qty*price and the canonical cash flow used by analytics
// (buy + fee, sell - fee). Values are compared as integer cents; a one-cent
// tolerance covers independent decimal rounding without turning this into a
// fuzzy/percentage match.
function tradeTotalsInCents(tx) {
  const explicit = toNumber(tx?.economicAmount ?? tx?.amountAbs);
  if (isFinite(explicit) && explicit > 0) {
    const cents = Math.round(Math.abs(explicit) * 100);
    return cents > 0 ? [cents] : [];
  }
  const qty = toNumber(tx?.qty);
  const price = toNumber(tx?.price);
  if (!isFinite(qty) || !isFinite(price)) return [];
  const gross = Math.abs(qty * price);
  const fee = Math.abs(toNumber(tx?.fee) || 0);
  const adjusted = tx?.side === "sell" ? gross - fee : gross + fee;
  return [...new Set([gross, adjusted].filter((n) => isFinite(n) && n > 0).map((n) => Math.round(n * 100)).filter((n) => n > 0))];
}

// ticker+side ONLY -- date is intentionally NOT part of the key (sep/2026
// fix). See the date-gap comment on the matcher below for why: SimpleFin's
// `posted` can be a settlement date while legacy CSV/manual rows carry the
// trade date, so requiring exact equality here made two rows of the exact
// same real trade look like distinct events and never prune.
function semanticTradeKey(tx) {
  const ticker = String(tx?.ticker || "").trim().toUpperCase();
  const side = String(tx?.side || "").toLowerCase();
  return ticker && (side === "buy" || side === "sell") ? `${ticker}|${side}` : null;
}

// Absolute difference in whole calendar days between two "YYYY-MM-DD"
// strings. Invalid/missing input -> Infinity, which always fails the <= 3
// gap check below (never treated as "close enough" by default).
function daysBetween(dateA, dateB) {
  const a = Date.parse(`${dateA}T00:00:00Z`);
  const b = Date.parse(`${dateB}T00:00:00Z`);
  if (!isFinite(a) || !isFinite(b)) return Infinity;
  return Math.abs(a - b) / 86400000;
}

// Removes candidates already represented by live transactions. This is a
// consumable multiset matcher: one live row suppresses at most one candidate.
// A shared simplefinId is authoritative. Legacy rows without an id then match
// by ticker+side+economic total, within a tolerance of at most 3 CALENDAR
// DAYS between the candidate's and the live row's date (sep/2026 fix --
// covers T+1/T+2 settlement plus a weekend, the gap actually observed between
// a SimpleFin `posted` date and a legacy CSV/manual trade date for the SAME
// real purchase). The 1-cent total tolerance is deliberately NOT widened to
// compensate -- an exact-to-the-cent total is what keeps this safe against a
// genuine SECOND purchase of the same ticker/side landing inside the 3-day
// window: this account's recurring buys are roughly two weeks apart, so two
// distinct trades essentially never share both the same total (to the cent)
// AND a date within 3 days of each other. Edge selection still prefers the
// smallest cent difference first (repeated same-day trades pair
// deterministically), then the smallest date gap, then index order.
export function pruneSemanticallyMatchedTrades(candidates, liveTransactions) {
  const pending = Array.isArray(candidates) ? candidates : [];
  const live = Array.isArray(liveTransactions) ? liveTransactions : [];
  const matchedCandidates = new Set();
  const consumedLive = new Set();
  const liveById = new Map();
  live.forEach((tx, index) => {
    if (tx?.simplefinId != null && String(tx.simplefinId)) {
      const id = String(tx.simplefinId);
      if (!liveById.has(id)) liveById.set(id, []);
      liveById.get(id).push(index);
    }
  });

  // Strong id path always runs before (and therefore wins over) semantics.
  pending.forEach((tx, candidateIndex) => {
    if (tx?.simplefinId == null || !String(tx.simplefinId)) return;
    const indexes = liveById.get(String(tx.simplefinId));
    if (!indexes?.length) return;
    matchedCandidates.add(candidateIndex);
    // Every repeated candidate bearing an already-live stable id is stale.
    // Consume one live slot for semantic matching, but never let duplicate
    // staged copies of that same id survive merely because it is a multiset.
    const liveIndex = indexes.find((index) => !consumedLive.has(index));
    if (liveIndex !== undefined) consumedLive.add(liveIndex);
  });

  const edges = [];
  pending.forEach((candidate, candidateIndex) => {
    if (matchedCandidates.has(candidateIndex)) return;
    const key = semanticTradeKey(candidate);
    const candidateTotals = tradeTotalsInCents(candidate);
    if (!key || !candidateTotals.length) return;
    live.forEach((existing, liveIndex) => {
      // A live row with a different stable provider id is a proven distinct
      // event, even when all economic fields happen to be identical. The
      // fallback exists specifically for legacy CSV/manual live rows that
      // have no SimpleFin identity at all.
      if (existing?.simplefinId != null && String(existing.simplefinId)) return;
      if (consumedLive.has(liveIndex) || semanticTradeKey(existing) !== key) return;
      const dateGap = daysBetween(candidate.date, existing.date);
      if (!(dateGap <= 3)) return;
      const liveTotals = tradeTotalsInCents(existing);
      for (const a of candidateTotals) for (const b of liveTotals) {
        const difference = Math.abs(a - b);
        if (difference <= 1) edges.push({ difference, dateGap, candidateIndex, liveIndex });
      }
    });
  });
  edges.sort(
    (a, b) =>
      a.difference - b.difference ||
      a.dateGap - b.dateGap ||
      a.candidateIndex - b.candidateIndex ||
      a.liveIndex - b.liveIndex
  );
  for (const edge of edges) {
    if (matchedCandidates.has(edge.candidateIndex) || consumedLive.has(edge.liveIndex)) continue;
    matchedCandidates.add(edge.candidateIndex);
    consumedLive.add(edge.liveIndex);
  }
  return pending.filter((_, index) => !matchedCandidates.has(index));
}

// Economic-identity key for the append/dedupe path (as opposed to
// semanticTradeKey's fuzzy matching above): ticker+side+qty+date. MUST mirror
// dupKey(tx) in api/fidelity-pending.js -- that copy exists only because this
// module predates the server importing it directly for this purpose; keep
// both in lock-step if either changes.
export function tradeDupKey(tx) {
  const ticker = String(tx?.ticker || "").trim().toUpperCase();
  return `${ticker}|${tx?.side}|${Number(tx?.qty)}|${tx?.date}`;
}

// Reconciles a sync's freshly-mapped trade candidates against what is
// currently staged (sep/2026 bugfix). Staged SimpleFin trade rows are DERIVED
// state, not an append-only log: `freshTx` (this sync's mapSimplefinPayload
// output) is always the best available re-derivation of every trade the feed
// currently reports, so a staged row that this sync could have re-derived
// (its own id was seen among this sync's trade-description transactions, or
// it is one of the always-recomputed synthetic kinds) must be REPLACED by
// whatever fresh produced for it -- never left stale.
//
// The bug this fixes: a multi-row snapshot delta split (e.g. one XLRE/VT buy
// spanning two staged trade candidates because the holdings delta had to be
// divided proportionally across them, see reconcileTrades) becomes WRONG the
// moment one of those two legacy rows is recognized as already-live (matched
// by pruneSemanticallyMatchedTrades's semantic matcher) -- the remaining
// sibling should then get the FULL delta, not its old proportional share.
// The previous append-only handleSync loop only ever ADDED rows whose
// simplefinId wasn't already staged, so the stale, too-small staged copy of
// the sibling survived forever once first written, and the sync reported
// "+0 trades" (correctly, from an append-only point of view) while the
// staging queue stayed wrong.
//
// `seenTradeSourceIds` is mapSimplefinPayload's additive return field: the
// raw SimpleFin transaction ids of every trade-description row it saw this
// sync (see its own header). A staged row whose simplefinId is in that set
// was fully re-derivable this sync -- fresh either re-emitted it (correctly
// this time) or correctly recognized it as already live and omitted it -- so
// it is safe, and necessary, to drop the stale staged copy either way. The
// synthetic-id prefix `sfbond-buy:` is ALSO always re-derivable every sync
// (its whole `mapSimplefinPayload` logic reruns unconditionally from the
// current holdings snapshot, independent of the 44-day transactions window
// `seenTradeSourceIds` is scoped to), so it is dropped unconditionally too,
// regardless of whether it shows up in `seenTradeSourceIds`. The
// `sfstock-delta:` prefix is no longer produced by anything in this file
// (the holdings-diff estimate candidates it identified were removed,
// sep/2026 -- see the comment above computeNetQty), but it is still matched
// and dropped unconditionally here too, purely as cleanup: any row still
// carrying that prefix in a user's existing staged blob is leftover from
// before the removal and should disappear on the very next sync rather than
// linger forever.
//
// Returns `{ transactions, added }`: `transactions` is the new staged trades
// array (replace, not append, in the caller); `added` counts only fresh rows
// whose simplefinId was NOT already present in `stagedTx` before this call --
// i.e. genuinely new trades, not a replacement/correction of one already
// staged -- so the "+N trades" the sync reports to the user stays meaningful
// (a pure correction of an already-visible row is not a new thing to review).
export function mergeStagedTrades(stagedTx, freshTx, { liveTx, seenTradeSourceIds } = {}) {
  const staged = Array.isArray(stagedTx) ? stagedTx : [];
  const fresh = Array.isArray(freshTx) ? freshTx : [];
  const live = Array.isArray(liveTx) ? liveTx : [];
  const seen =
    seenTradeSourceIds instanceof Set
      ? seenTradeSourceIds
      : new Set(Array.isArray(seenTradeSourceIds) ? seenTradeSourceIds.map(String) : []);

  const isReDerivable = (tx) => {
    if (!tx || tx.source !== "simplefin") return false;
    const id = tx.simplefinId != null ? String(tx.simplefinId) : null;
    if (!id) return false;
    if (id.startsWith("sfbond-buy:") || id.startsWith("sfstock-delta:")) return true;
    return seen.has(id);
  };

  // 1) Drop every staged row this sync could have re-derived -- fresh's
  // output for it (below) replaces it, whatever fresh decided (re-emit,
  // split differently, or correctly omit as already-live).
  const kept = staged.filter((tx) => !isReDerivable(tx));

  // 2) Everything else (older than the sync window, non-simplefin/manual,
  // or simply id-less) survives, minus the pre-existing semantic prune
  // against live legacy rows -- unchanged behavior from before this fix,
  // just now applied to `kept` instead of the full `staged` array.
  const prunedKept = pruneSemanticallyMatchedTrades(kept, live);

  const previouslyStagedIds = new Set(
    staged.filter((t) => t?.simplefinId != null).map((t) => String(t.simplefinId))
  );
  const liveSimplefinIds = new Set(live.filter((t) => t?.simplefinId).map((t) => String(t.simplefinId)));
  const liveDupKeys = new Set(live.map(tradeDupKey));
  const keptSimplefinIds = new Set(
    prunedKept.filter((t) => t?.simplefinId != null).map((t) => String(t.simplefinId))
  );
  const keptDupKeys = new Set(prunedKept.map(tradeDupKey));

  // 3) Append fresh rows, same dedupe rules as the pre-fix append-only loop:
  // skip if already live or already kept (by id, then by economic dupKey).
  const transactions = [...prunedKept];
  let added = 0;
  for (const tx of fresh) {
    const id = tx?.simplefinId != null ? String(tx.simplefinId) : null;
    if (id && (liveSimplefinIds.has(id) || keptSimplefinIds.has(id))) continue;
    const k = tradeDupKey(tx);
    if (liveDupKeys.has(k) || keptDupKeys.has(k)) continue;
    keptDupKeys.add(k);
    if (id) keptSimplefinIds.add(id);
    transactions.push(tx);
    if (!(id && previouslyStagedIds.has(id))) added++;
  }

  return { transactions, added };
}

// Reconciles one account's trade transaction rows. Returns
// `{ transactions, unmapped, bondTradeLinks }` -- the same "never invent,
// surface what can't be resolved" shape as the rest of this file.
// `bondTradeLinks` (sep/2026) carries bond/CD BUY
// trade rows whose description has no bracketed ticker (SimpleFin never
// reports a CUSIP) but DOES parse into coupon%+maturity via extractBondMeta
// once the row's trailing parenthetical and action-verb prefix are stripped
// -- e.g. "YOU BOUGHT FACT SHEET TO FOLLOW VERSABANK USA NATL ASSN HOLDIG CD
// 4.85000% 09/24/2032 (Cash)". These used to fall straight into `unmapped`
// ("no ticker could be extracted") even though bondBuyTransactions() already
// synthesizes the SAME bond as a buy from the holdings snapshot, just with an
// approximate date (the snapshot's balance-date) and no exact total. Rather
// than resolve/patch that synthesized row here (bondBuyTransactions runs
// per-account too, but ordering it against this function is the caller's
// job), this function only RECORDS the link -- mapSimplefinPayload is the
// one place that sees both this trade row AND the synthesized buy, and can
// patch the buy's date/qty/price from the link's exact evidence.
function reconcileTrades(account, netQtyByTicker = {}, liveTransactions = null) {
  const accountId = account?.id ?? null;
  const accountName = account?.name ?? null;
  const transactions = [];
  const unmapped = [];
  const bondTradeLinks = [];
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

  // Identify legacy CSV/manual equivalents before either the feed-qty path
  // or delta grouping. Excluding them up front is load-bearing: an already
  // live row must receive neither a second candidate nor a share of the
  // remaining holdings delta.
  const semanticCandidates = [];
  for (const tx of txs) {
    const description = String(tx?.description || "").trim();
    const upper = description.toUpperCase();
    if (!description || !isTradeDescription(upper)) continue;
    const candidate = {
      sourceTx: tx,
      simplefinId: tx?.id != null ? String(tx.id) : null,
      date: unixToDateOnly(tx?.posted ?? tx?.transacted_at),
      side: tradeSide(upper),
      ticker: extractTicker(description, [TRAILING_TICKER_RX]),
      economicAmount: Math.abs(toNumber(tx?.amount)),
    };
    if (semanticTradeKey(candidate) && tradeTotalsInCents(candidate).length) semanticCandidates.push(candidate);
  }
  const unmatchedSourceTransactions = new Set(
    pruneSemanticallyMatchedTrades(semanticCandidates, liveTransactions).map((candidate) => candidate.sourceTx)
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
    // The transaction's OWN id, one per real trade. Deliberately NOT a
    // synthetic delta id: when two trades of the same ticker land in the same
    // sync window they must not collapse onto one id and collide in the
    // server's dedupe.
    simplefinId: row.simplefinId,
    reconciledFromTransaction: true,
    // Diagnostic only -- see collectRawFields. Attached to every trade
    // candidate (not just unmapped rows) so the user can confirm whether
    // Fidelity is sending qty/avg price on trades even when some other path
    // already resolved this row.
    ...(row.rawFields ? { rawFields: row.rawFields } : {}),
    ...flags,
    createdAt: new Date().toISOString(),
  });

  // "Already recorded" coverage rule (sep/2026) -- see the reconcileTrades
  // header comment above for the full August VT example this fixes. A trade
  // row for ticker T dated D is considered already covered by the user's own
  // records when `liveTransactions` has a buy/sell of the SAME ticker dated
  // on or after D whose simplefinId is empty (CSV/manual) or a legacy
  // `sfstock-delta:` holdings-diff estimate approved before this feature
  // existed. A live row carrying a REAL SimpleFin transaction id never
  // matches here -- that case is handled exclusively by the id-based
  // `approvedSimplefinIds` check above, matched exactly, not by date.
  const isAlreadyCoveredByLiveRecord = (ticker, date) => {
    if (!Array.isArray(liveTransactions)) return false;
    return liveTransactions.some((t) => {
      if (!t || (t.side !== "buy" && t.side !== "sell")) return false;
      if (String(t.ticker || "").trim().toUpperCase() !== ticker) return false;
      if (!(typeof t.date === "string" && t.date >= date)) return false;
      const id = t.simplefinId;
      if (id == null || String(id) === "") return true;
      return String(id).startsWith("sfstock-delta:");
    });
  };

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
    if (semanticCandidates.some((candidate) => candidate.sourceTx === tx) && !unmatchedSourceTransactions.has(tx)) continue;

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
      // Bond/CD purchases (sep/2026): no bracketed ticker to extract (no
      // CUSIP in this feed), but the description otherwise carries the
      // bond's own "Symbol Description" text once the trailing parenthetical
      // (e.g. "(Cash)") and the leading action verb (and, for these rows,
      // Fidelity's "FACT SHEET TO FOLLOW" filler) are stripped. Sells of
      // bonds are intentionally left on the pre-feature path below (the
      // synthesized-buy patch this produces only makes sense for a buy).
      if (row.side === "buy") {
        const strippedDescription = description
          .replace(/\s*\([^)]*\)\s*$/, "")
          .replace(/^YOU (BOUGHT|SOLD)\s+(FACT SHEET TO FOLLOW\s+)?/i, "");
        const bondMeta = extractBondMeta(strippedDescription);
        if (bondMeta && bondMeta.couponRate != null && bondMeta.maturityDate) {
          const syntheticTicker = generateSyntheticBondTicker(bondMeta.couponRate, bondMeta.maturityDate);
          if (syntheticTicker) {
            bondTradeLinks.push({
              syntheticTicker,
              couponRate: bondMeta.couponRate,
              maturityDate: bondMeta.maturityDate,
              date: row.date,
              amountAbs: row.amountAbs,
              simplefinId: row.simplefinId,
              rawFields: row.rawFields,
            });
            continue;
          }
        }
      }
      unmapped.push(unmappedTrade(row, "buy/sell recognized but no ticker could be extracted from the description -- enter manually"));
      continue;
    }

    // See isAlreadyCoveredByLiveRecord above / the reconcileTrades header
    // comment for the August VT case this closes. Silent skip -- no
    // candidate, no unmapped row: the user's own records already cover this
    // trade.
    if (isAlreadyCoveredByLiveRecord(row.ticker, row.date)) continue;

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
      transactions.push(
        makeTrade(row, qty, price, notes, {
          qtyFromFeed: true,
          ...(feed.qtyField ? { feedQtyField: feed.qtyField } : {}),
          ...(feed.priceField ? { feedPriceField: feed.priceField } : {}),
        })
      );
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

    // No proportional split (sep/2026 -- see the reconcileTrades header for
    // the August regression this fixes). A holdings snapshot delta describes
    // the NET change for a ticker across the whole sync window; when more
    // than one of that ticker's trade rows is still unresolved at this point
    // there is no way to tell how many shares each individual row bought or
    // sold without inventing a split, so none of them are guessed at.
    if (rows.length > 1) {
      bail("more than one trade for this ticker in the sync window and SimpleFin reported no qty -- the holdings snapshot can't tell how many shares each trade bought; import the Fidelity CSV or enter manually");
      continue;
    }

    const row = rows[0];
    const side = row.side;
    const dir = side === "buy" ? 1 : -1;

    const rawKnown = netQtyByTicker ? netQtyByTicker[ticker] : undefined;
    const knownQty = isFinite(Number(rawKnown)) ? Number(rawKnown) : 0;
    const holding = holdingsByTicker.get(ticker);
    const sharesNew = holding ? toNumber(holding.shares) : NaN;
    const hasSnapshot = !!holding && isFinite(sharesNew) && sharesNew >= 0;

    // Case A: the ticker is in this account's snapshot -> the delta is
    // sharesNew - knownQty. Case B: full liquidation -- an explicit
    // "YOU SOLD" row for a ticker that is ABSENT from the snapshot while
    // knownQty > 0 is treated as a sale of the whole position (effective
    // shares = 0): a confirmed "YOU SOLD" row was posted in THIS account, so
    // the position really did leave it. This also closes the hole where a
    // liquidation listed at exactly 0 shares had no market value left to
    // price a sell from and was pushed to `unmapped`.
    let effectiveShares = null;
    if (hasSnapshot) effectiveShares = sharesNew;
    else if (side === "sell" && knownQty > 0) effectiveShares = 0;
    if (effectiveShares === null) {
      bail("buy/sell recognized but SimpleFin reported no qty/price and this account's holdings snapshot has no matching position to derive one -- enter manually");
      continue;
    }

    // Whatever the feed path already resolved for this ticker is part of the
    // delta too, so it is removed before using the remainder.
    const delta = effectiveShares - knownQty - (feedQtyByTicker.get(ticker) || 0);
    // Sign consistency: a buy must move the position up, a sell down. If
    // they disagree, the delta describes something this row does not (a
    // corporate action, another account, a partially recorded trade) --
    // reconcile nothing and keep today's behavior.
    if (!(delta * dir > 1e-9)) {
      bail("buy/sell recognized but the holdings snapshot delta does not match the direction of these trades -- enter manually");
      continue;
    }

    const qty = Math.abs(delta);
    if (!(row.amountAbs > 0)) {
      bail("buy/sell recognized but SimpleFin reported no usable amount -- enter manually");
      continue;
    }

    const notes = hasSnapshot
      ? "Trade reconciled from the SimpleFin transaction (real date and total) and the holdings snapshot share delta. Price = total / quantity. Exact."
      : "Full liquidation reconciled from the SimpleFin sell transaction: quantity is your full known position for this ticker, price = total / quantity. Exact.";
    transactions.push(makeTrade(row, qty, row.amountAbs / qty, notes, { reconciledFromDelta: true }));
  }

  return { transactions, unmapped, bondTradeLinks };
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

  if (!description) return { unmapped: unmappedItem("missing description") };
  if (!date) return { unmapped: unmappedItem("missing/invalid posted date") };

  if (EXCLUDE_CASH_CYCLE_RX.test(upper)) return { excluded: true };
  if (DISTRIBUTION_RX.test(upper)) return { excluded: true };
  if (EXCLUDE_EFT_RECEIVED_RX.test(upper)) return { excluded: true };
  // Core-account cash sweep — tested BEFORE the REDEMPTION_RX branch below,
  // which is why EXCLUDE_CORE_SWEEP_RX is anchored (see its definition).
  if (EXCLUDE_CORE_SWEEP_RX.test(upper)) return { excluded: true };

  // Anchored trade — tested BEFORE every unanchored keyword branch below.
  // See TRADE_ANCHORED_RX for the bug this ordering fixes (a fund whose NAME
  // contains "DIVIDEND" had its purchase staged as dividend income).
  if (TRADE_ANCHORED_RX.test(upper)) {
    if (tradesHandledElsewhere) return { excluded: true };
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
    if (tradesHandledElsewhere) return { excluded: true };
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
// reconcileTrades so a holdings-snapshot share delta can be used as a
// fallback (single unresolved row per ticker only, see its header) when a
// SimpleFin trade row has no structured qty/price of its own. It is the
// single switch for trade reconciliation (sep/2026): omit it and YOU BOUGHT/
// YOU SOLD rows keep going straight to `unmapped` exactly like before, same
// "omit the param for pre-feature behavior" convention.
// `bondBindings` (optional, descKey -> CUSIP) is forwarded to
// mapOneTransaction as the second INTEREST resolution source — the user's own
// confirmed binds, persisted in the staging blob. Omit it to get the
// pre-feature behavior (knownBondsByDescKey only).
// `liveTransactions` (optional, the RAW array behind `netQtyByTicker` -- not
// the aggregated map) is forwarded to reconcileTrades for its
// `approvedSimplefinIds` and "already recorded" coverage checks (see its
// header). Omit it to get the pre-feature behavior.
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
  // Every raw SimpleFin transaction id (across all accounts in THIS payload)
  // that is a trade description (isTradeDescription) -- additive field
  // returned below for the caller's staged-row merge (mergeStagedTrades /
  // api/fidelity-pending.js handleSync, sep/2026). A trade whose id is in
  // this set was fully re-derivable this sync -- either re-emitted here
  // (possibly with a corrected qty/split) or correctly recognized as already
  // live -- so a stale staged copy of it can safely be dropped and replaced.
  const seenTradeSourceIds = new Set();

  for (const account of accounts) {
    if (!isFidelityOrg(account?.org)) continue;

    const { candidates, skipped } = computeBalanceCandidates(account);
    balanceCandidates.push(...candidates);
    unmapped.push(...skipped);
    bondHoldings.push(...extractBondHoldingsList(account));

    const accountTxs = Array.isArray(account.transactions) ? account.transactions : [];
    for (const tx of accountTxs) {
      const description = String(tx?.description || "").trim();
      if (description && isTradeDescription(description.toUpperCase()) && tx?.id != null) {
        seenTradeSourceIds.add(String(tx.id));
      }
    }

    // Trade reconciliation runs BEFORE bond buy synthesis (sep/2026): it
    // produces the exact trades (real date + real total) AND also
    // `bondTradeLinks` -- bond/CD trade rows with no
    // bracketed ticker whose description parsed into coupon%+maturity. That
    // last one is precisely what bondBuyTransactions (below) needs BEFORE it
    // runs, so its synthesized buy for the same bond can be patched with the
    // trade's real date/total instead of the snapshot's approximate ones.
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

    // New bonds discovered in the holdings snapshot become buy transactions
    // (the third data-entry path alongside manual + CSV import). Only bonds
    // the user doesn't already own are synthesized; existing ones are skipped
    // via knownBondsByDescKey. See bondBuyTransactions() above.
    const bondBuys = bondBuyTransactions(
      account,
      knownBondsByDescKey instanceof Map ? knownBondsByDescKey : new Map()
    );

    // Patch synthesized bond buys with the exact evidence from a matching
    // trade row (sep/2026 -- see reconcileTrades' bondTradeLinks header).
    // Matched by SYNTHETIC TICKER (coupon+maturity), never by descKey/text:
    // the holding's description and the trade's description are not
    // guaranteed to read identically (the real case: "... HOLDIG CD ..." on
    // the trade vs whatever text the holdings snapshot carries).
    const bondTradeLinks = reconciled ? reconciled.bondTradeLinks || [] : [];
    const resolvedLinkTickers = new Set();
    for (const buy of bondBuys) {
      const link = bondTradeLinks.find((l) => l.syntheticTicker === buy.ticker);
      if (!link) continue;
      resolvedLinkTickers.add(link.syntheticTicker);
      buy.date = link.date;
      if (isFinite(link.amountAbs) && link.amountAbs > 0) {
        buy.qty = link.amountAbs / 1000;
        buy.price = 1000;
      }
      buy.notes = `${buy.notes} Date and total amount are taken from the matching SimpleFin trade transaction.`;
      // simplefinId stays `sfbond-buy:<descKey>` (set by bondBuyTransactions)
      // -- NOT the trade's own id -- so the server's existing dedupe/upsert
      // for bond buys (one row per bond, keyed by descKey) is unaffected.
      // Diagnostic only -- see collectRawFields; carried over from the linked
      // trade transaction so this buy is inspectable the same way any other
      // trade candidate is.
      if (link.rawFields) buy.rawFields = link.rawFields;
    }
    transactions.push(...bondBuys);

    // A bond trade link that no synthesized buy claimed above is either (a)
    // already a known position -- bondBuyTransactions() silently skipped
    // synthesizing it because knownBondsByDescKey already has this bond's
    // descKey, i.e. the user already has a Bank Bonds buy for it -- or (b) a
    // genuine gap: the account's holdings snapshot hasn't caught up to this
    // purchase yet (SimpleFin's holdings feed can lag the transactions feed
    // by a sync or two). (a) is resolved silently, matched by coupon+maturity
    // (or the synthetic ticker itself) rather than descKey/text for the same
    // reason as the patch above. (b) is surfaced, never guessed at.
    for (const link of bondTradeLinks) {
      if (resolvedLinkTickers.has(link.syntheticTicker)) continue;
      const alreadyKnown =
        Array.isArray(liveTransactions) &&
        liveTransactions.some(
          (t) =>
            t &&
            t.assetClass === "Bank Bonds" &&
            t.side === "buy" &&
            (String(t.ticker || "").trim().toUpperCase() === link.syntheticTicker ||
              (t.couponRate != null &&
                t.maturityDate &&
                Number(t.couponRate) === link.couponRate &&
                t.maturityDate === link.maturityDate))
        );
      if (alreadyKnown) continue;
      unmapped.push({
        simplefinId: link.simplefinId,
        accountId: account?.id ?? null,
        accountName: account?.name ?? null,
        date: link.date,
        description: null,
        amount: isFinite(link.amountAbs) ? link.amountAbs : null,
        reason: `bond/CD purchase recognized (${link.couponRate}% maturing ${link.maturityDate}) but no matching Bank Bonds holding in this account's snapshot yet -- re-sync later or enter manually`,
      });
    }

    for (const tx of accountTxs) {
      const mapped = mapOneTransaction(
        tx,
        account,
        knownBondsByDescKey instanceof Map ? knownBondsByDescKey : new Map(),
        bondBindings && typeof bondBindings === "object" && !Array.isArray(bondBindings)
          ? bondBindings
          : {},
        !!reconciled
      );
      if (mapped.excluded) continue;
      if (mapped.transaction) transactions.push(mapped.transaction);
      else if (mapped.bondIncome) bondIncome.push(mapped.bondIncome);
      else if (mapped.unmapped) unmapped.push(mapped.unmapped);
    }
  }

  return {
    transactions,
    bondIncome,
    balanceCandidates,
    unmapped,
    bondHoldings,
    seenTradeSourceIds: [...seenTradeSourceIds],
  };
}
