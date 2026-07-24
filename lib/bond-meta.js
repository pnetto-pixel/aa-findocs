// lib/bond-meta.js
// Shared bond-description parsing helpers used on BOTH sides of the app:
// the frontend CSV/Fidelity parser (src/lib/parsing.js, src/lib/bankBonds.js,
// src/Transactions.jsx) and the backend SimpleFin mapper (lib/simplefin-map.js,
// api/fidelity-pending.js). Lives at the repo root (not under src/lib) so it
// can be imported from serverless functions without pulling in any
// frontend-only dependency.
//
// IMPORTANT: no papaparse, no React, no DOM here — this file must stay
// importable from plain Node (Vercel functions) as well as from Vite.
//
// No network, no Redis — pure functions only, same "pure module + fixtures"
// convention as src/lib/parsing.js and lib/simplefin-map.js (unit tested
// directly in Node, see test/simplefin-map.test.mjs / test/fidelity-parser.test.mjs).

// Extracts coupon/maturity/issuer metadata from a Fidelity "Symbol Description"
// bond string (e.g. "WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030").
// Returns null when the text doesn't match the coupon%+maturity pattern.
// `descKey` is a stable composite key (issuer|coupon|maturity) used to match
// a bond across rows even when Fidelity omits the CUSIP in Symbol (jul/2026).
export function extractBondMeta(desc) {
  const d = String(desc || "");
  const couponM = d.match(/(\d+(?:\.\d+)?)%/);
  const maturityM = d.match(/(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!couponM || !maturityM) return null;
  const couponRate = parseFloat(couponM[1]);
  const [, mm, dd, yyyy] = maturityM;
  const maturityDate = `${yyyy}-${mm}-${dd}`;
  const nameEnd = d.search(/\d+(?:\.\d+)?%/);
  const shortName = nameEnd > 0 ? d.slice(0, nameEnd).trim().replace(/\s+/g, " ") || null : null;
  const u = d.toUpperCase();
  let bondType;
  if (u.includes("TREASURY") || u.includes("US TREAS")) {
    bondType = "Treasury";
  } else if (
    u.includes("FEDERAL HOME LOAN") || u.includes("FHLB") ||
    u.includes("FEDERAL FARM") || u.includes("FFCB") ||
    u.includes("FNMA") || u.includes("FHLMC") ||
    u.includes("FREDDIE") || u.includes("FANNIE")
  ) {
    bondType = "Agency";
  } else if (
    u.includes(" INC") || u.includes(" CORP") || u.includes(" LLC") ||
    u.includes(" LTD") || u.includes(" PLC") || u.includes(" CO.")
  ) {
    bondType = "Corporate";
  } else {
    bondType = "CD";
  }
  const notes = `${couponRate.toFixed(2)}% | ${mm}/${dd}/${yyyy}`;
  const descKey = `${(shortName || "").toUpperCase()}|${couponRate}|${maturityDate}`;
  return { couponRate, maturityDate, bondType, shortName, couponFreq: "monthly", notes, descKey };
}

// Synthetic Bank Bond ticker generator (jul/2026). Fidelity no longer
// reports CUSIPs for Bank Bond BUY rows in the CSV export, and there is no
// other public source for them (see docs/CONTEXT.md, "BRA Fixed Income" /
// Bank Bonds sourcing notes). Rather than force manual CUSIP entry every
// time, derive a deterministic synthetic ticker from coupon + maturity —
// confirmed format with the user: `<maturity YYYYMMDD><coupon, no dot>`,
// no prefix, no separator. The maturity part is ALWAYS exactly 8 digits
// (zero-padded YYYY/MM/DD), which guarantees no ambiguity between where the
// maturity ends and the coupon begins when the two parts are concatenated.
//
// Coupon encoding: basis points (coupon% x 100) when that value is already a
// whole number — this covers every coupon the user actually has (4.20% ->
// 420, 3.95% -> 395, 2.88% -> 288, ...) and matches the exact IDs confirmed
// with the user, e.g. 3.95% + 2029-05-08 -> "20290508395", 3.80% + same
// maturity -> "20290508380" (different coupon -> different id, same
// maturity prefix). Broken coupons that don't reduce to a whole number of
// basis points (e.g. 4.125%) fall back to x1000 (thousandths of a percent)
// to keep full precision without ever introducing a decimal separator —
// still fully deterministic, just a longer numeral for that rarer case.
//
// This function is ticker-agnostic downstream: buildKnownBondsByDescKey
// (below) and the SimpleFin INTEREST/REDEMPTION auto-resolution path key
// off couponRate/maturityDate/shortName on the transaction, never off the
// ticker's shape, so a bond stamped with a synthetic ticker here still
// auto-resolves against future events without any manual "Bond Matching"
// step. Returns null (not a broken/partial string) when the inputs can't
// support a deterministic id — callers must treat a falsy return as "could
// not generate, fall back to manual entry".
export function generateSyntheticBondTicker(couponRate, maturityDate) {
  const rate = Number(couponRate);
  if (!isFinite(rate) || rate <= 0) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(maturityDate || "").trim());
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  const mmN = parseInt(mm, 10);
  const ddN = parseInt(dd, 10);
  if (mmN < 1 || mmN > 12 || ddN < 1 || ddN > 31) return null;
  // Confirm the date actually exists (catches e.g. 02/30).
  const dt = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  if (
    dt.getUTCFullYear() !== parseInt(yyyy, 10) ||
    dt.getUTCMonth() + 1 !== mmN ||
    dt.getUTCDate() !== ddN
  ) {
    return null;
  }
  const datePart = `${yyyy}${mm}${dd}`; // always 8 digits (YYYY is fixed-width by the regex)

  const bps = Math.round(rate * 100);
  const couponPart =
    Math.abs(bps - rate * 100) < 1e-9 ? String(bps) : String(Math.round(rate * 1000));

  return `${datePart}${couponPart}`;
}

// Bond description (issuer|coupon|maturity) -> known CUSIP, built from Bank
// Bonds BUY transactions that carry couponRate/maturityDate/shortName. Those
// fields are only populated when the bond was imported via the Fidelity CSV
// parser (extractBondMeta above) or resolved server-side by the SimpleFin
// mapper — manually-entered bonds won't have them, so they simply won't be
// resolvable here (same as today).
//
// Consolidates two previously-duplicated implementations:
//   - src/lib/bankBonds.js (private, module-scoped)
//   - src/Transactions.jsx's ImportModal (private, inline useMemo)
// Canonical behavior matches the stricter of the two (bankBonds.js): only
// `side === "buy"` rows are considered, and all three of couponRate/
// maturityDate/shortName must be present. In practice this makes no
// observable difference for the sell/redemption rows the looser
// Transactions.jsx version also let through, because those rows' metadata
// (when present at all) is always copied from the same extractBondMeta call
// as the matching buy, so they produce the exact same descKey.
export function buildKnownBondsByDescKey(transactions) {
  const m = new Map();
  for (const tx of transactions || []) {
    if (!tx || tx.assetClass !== "Bank Bonds" || tx.side !== "buy" || !tx.ticker) continue;
    if (tx.couponRate == null || !tx.maturityDate || !tx.shortName) continue;
    const key = `${String(tx.shortName).toUpperCase()}|${tx.couponRate}|${tx.maturityDate}`;
    m.set(key, String(tx.ticker).trim().toUpperCase());
  }
  return m;
}

// Bond metadata backfill (Fase 2 of the "Bond Matching" item, jul/2026).
//
// When a descKey -> CUSIP bind is confirmed in the "Bond Matching" UI
// (src/Transactions.jsx's confirmBondMatch), the SimpleFin holding's
// description carries coupon/maturity/issuer data that the matching CUSIP's
// Bank Bonds transaction(s) may never have received — those transactions
// were either manually entered pre-CUSIP-in-CSV, or resolved by a bind whose
// holding had no CUSIP in the feed at all. Without couponRate/maturityDate/
// shortName/notes, those bonds stay "blind": buildKnownBondsByDescKey can
// never learn their descKey (it requires all three structured fields — see
// above), so future REDEMPTION/INTEREST rows for the same bond can't
// auto-resolve, and computeBankBondsValueAt's interest-accrual regex (src/
// lib/bankBonds.js) has nothing to parse from `notes`, so the bond shows up
// flat (no projected interest) in Composition Evolution.
//
// This function copies coupon/maturity/shortName/notes from the holding's
// description (re-parsed via extractBondMeta, the same parser the Fidelity
// CSV import path uses) onto every live Bank Bonds transaction — buy AND
// sell; metadata belongs to the bond, not to a single row — that carries the
// matching CUSIP as `ticker`. Hard rule (confirmed): NEVER overwrites a
// field that already has a value; only fills what's currently null/empty.
// `notes` is filled with `meta.notes` (e.g. "4.20% | 07/08/2030"), the exact
// same format extractBondMeta already produces for CSV-imported bonds and
// that computeBankBondsValueAt's accrual regex (`/(\d+\.\d+)%/` +
// `/\d{2}\/\d{2}\/\d{4}$/`) expects.
//
// Pure and side-effect-free: returns a NEW array only when at least one
// transaction actually changed; otherwise returns the exact same `transactions`
// reference so callers (Transactions.jsx's reconciliation effect) can detect
// "did anything change?" via `next !== transactions` without a deep-equal
// check, and use that identity to decide whether to persist and to avoid
// re-persisting (and re-rendering) once every matching transaction is
// already filled in.
export function backfillBondMetadata(transactions, cusip, holdingDescription) {
  const meta = extractBondMeta(holdingDescription);
  // No parseable coupon/maturity in the holding's description (e.g. a
  // Treasury holding with a different description format) -> nothing to
  // backfill. No-op, same reference.
  if (!meta) return transactions;
  const targetCusip = String(cusip || "").trim().toUpperCase();
  if (!targetCusip) return transactions;

  let changed = false;
  const next = (transactions || []).map((tx) => {
    if (!tx || tx.assetClass !== "Bank Bonds" || !tx.ticker) return tx;
    if (String(tx.ticker).trim().toUpperCase() !== targetCusip) return tx;

    const patch = {};
    if (tx.couponRate == null && meta.couponRate != null) patch.couponRate = meta.couponRate;
    if (!tx.maturityDate && meta.maturityDate) patch.maturityDate = meta.maturityDate;
    if (!tx.shortName && meta.shortName) patch.shortName = meta.shortName;
    if (!tx.notes && meta.notes) patch.notes = meta.notes;

    if (Object.keys(patch).length === 0) return tx;
    changed = true;
    return { ...tx, ...patch };
  });

  return changed ? next : transactions;
}
