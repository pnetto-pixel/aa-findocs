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
