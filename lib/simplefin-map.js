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

// Maps a single SimpleFin transaction to one of:
//   { excluded: true }               — intentionally dropped, never surfaced
//   { transaction: {...} }           — a buy/sell transaction candidate
//   { bondIncome: {...} }            — a dividend/interest/tax income event
//   { unmapped: {...} }              — visible-but-unresolved, never silent
function mapOneTransaction(tx, account) {
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
  if (INTEREST_RX.test(upper)) {
    const ticker = extractTicker(description, [TRAILING_TICKER_RX, INTEREST_PREFIX_RX]);
    if (!ticker || !isFinite(amountNum) || amountNum <= 0) {
      return { unmapped: unmappedItem("interest matched but ticker/amount not extractable") };
    }
    return {
      bondIncome: { id: newId(), date, ticker, amount: amountNum, kind: "interest", source: "simplefin", simplefinId },
    };
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
  for (const h of holdings) {
    const symbol = String(h?.symbol ?? "").trim();
    const description = String(h?.description ?? "").trim().toUpperCase();
    // Holdings with a symbol are stocks/ETFs, not bank bonds — not reported
    // here (correct exclusion, not an error worth surfacing). The CASH
    // synthetic holding also has symbol === "" — must be excluded here too,
    // or the cash balance would double-count into Bank Bonds.
    if (symbol !== "" || description === "CASH") continue;
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
export function mapSimplefinPayload(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const transactions = [];
  const bondIncome = [];
  const balanceCandidates = [];
  const unmapped = [];

  for (const account of accounts) {
    if (!isFidelityOrg(account?.org)) continue;

    const { candidates, skipped } = computeBalanceCandidates(account);
    balanceCandidates.push(...candidates);
    unmapped.push(...skipped);

    const txs = Array.isArray(account.transactions) ? account.transactions : [];
    for (const tx of txs) {
      const mapped = mapOneTransaction(tx, account);
      if (mapped.excluded) continue;
      if (mapped.transaction) transactions.push(mapped.transaction);
      else if (mapped.bondIncome) bondIncome.push(mapped.bondIncome);
      else if (mapped.unmapped) unmapped.push(mapped.unmapped);
    }
  }

  return { transactions, bondIncome, balanceCandidates, unmapped };
}
