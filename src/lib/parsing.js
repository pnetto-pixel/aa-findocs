// lib/parsing.js
// Pure CSV / Fidelity "Accounts History" parsing logic, extracted from
// src/Transactions.jsx so it can be unit-tested in Node (see
// test/fidelity-parser.test.mjs). No React, no DOM — keep it that way.

import Papa from "papaparse";
// extractBondMeta moved to ../../lib/bond-meta.js (jul/2026) so it can be
// shared with the backend SimpleFin mapper (lib/simplefin-map.js) without
// pulling papaparse into a serverless function. Re-exported below with the
// same name so every existing call site here and elsewhere keeps working
// unchanged (src/lib/bankBonds.js, test/fidelity-parser.test.mjs).
import { extractBondMeta } from "../../lib/bond-meta.js";

// UUID — falls back if crypto.randomUUID is unavailable.
function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// --- Asset classes ---------------------------------------------------------
// Each entry: { id, currency }. UI uses sorted ids.
const ASSET_CLASSES = [
  { id: "Alternative", currency: "USD" },
  { id: "Bank Bonds", currency: "USD" },
  { id: "Bonds", currency: "USD" },
  { id: "BRA Fixed Income", currency: "BRL" },
  { id: "BRA Stocks", currency: "BRL" },
  { id: "Real Estate", currency: "USD" },
  { id: "Stocks", currency: "USD" },
  { id: "Unallocated BRL", currency: "BRL" },
  { id: "Unallocated USD", currency: "USD" },
];

const ASSET_CLASS_IDS = ASSET_CLASSES.map((a) => a.id);

function currencyForAssetClass(id) {
  const a = ASSET_CLASSES.find((x) => x.id === id);
  return a ? a.currency : null;
}

// Normalize incoming asset class string from CSV (case-insensitive match).
function normalizeAssetClass(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const found = ASSET_CLASSES.find((a) => a.id.toLowerCase() === s);
  return found ? found.id : null;
}

// B3 ticker pattern: 4 letters + 1-2 digits (BBSE3, TAEE11, XPLG11, BOVA11).
const B3_RX = /^[A-Z]{4}\d{1,2}$/;

// CUSIP pattern: 9 alphanumeric chars (e.g. 949764WE0 for CDs / Bank Bonds).
const CUSIP_RX = /^[A-Z0-9]{9}$/;

// Infer currency from ticker. Returns "USD" | "BRL" | null (ambiguous).
// Cash/Tesouro/CD style tickers (with hyphen or non-standard format) -> null.
function inferCurrency(ticker) {
  if (!ticker) return null;
  const t = String(ticker).trim().toUpperCase();
  if (!t) return null;
  if (B3_RX.test(t)) return "BRL";
  // Pure A-Z 1-5 chars looks like a US ticker (AAPL, SPY, BRK).
  if (/^[A-Z]{1,5}$/.test(t)) return "USD";
  return null;
}

// --- ETF auto-classification maps -----------------------------------------

const FIXED_INCOME_ETFS = new Set([
  'BND', 'AGG', 'SCHZ', 'IAGG', 'BNDX', 'VCIT', 'VCSH', 'LQD', 'HYG',
  'TLT', 'IEF', 'SHY', 'GOVT', 'MUB', 'VTEB', 'BSV', 'BIV', 'BLV',
  'VGSH', 'VGIT', 'VGLT', 'SPTL', 'SPIB', 'SPAB', 'FBND',
]);

const REAL_ESTATE_ETFS = new Set([
  'VNQ', 'XLRE', 'IYR', 'SCHH', 'RWR', 'USRT', 'FREL', 'REM', 'MORT', 'KBWY',
]);

// Returns the best-guess asset class for a ticker.
// Known fixed-income / REIT ETFs win; then CUSIP → Bank Bonds;
// then B3 pattern → BRA Stocks; then US pattern → Stocks.
function inferAssetClass(ticker) {
  if (!ticker) return null;
  const t = String(ticker).trim().toUpperCase();
  if (!t) return null;
  if (FIXED_INCOME_ETFS.has(t)) return 'Bonds';
  if (REAL_ESTATE_ETFS.has(t)) return 'Real Estate';
  if (/^tesouro-/i.test(t)) return 'BRA Fixed Income';
  if (CUSIP_RX.test(t)) return 'Bank Bonds';
  const currency = inferCurrency(t);
  if (currency === 'BRL') return 'BRA Stocks';
  if (currency === 'USD') return 'Stocks';
  return null;
}

// --- Bulk import parsing helpers -------------------------------------------

// Date parsing — accepts YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY.
// Ambiguous slash dates (e.g. 03/04/2024) default to DMY since user is BR-based.
function isValidYMD(y, m, d) {
  const yi = parseInt(y, 10);
  const mi = parseInt(m, 10);
  const di = parseInt(d, 10);
  if (!isFinite(yi) || !isFinite(mi) || !isFinite(di)) return false;
  if (yi < 1900 || yi > 2100) return false;
  if (mi < 1 || mi > 12) return false;
  if (di < 1 || di > 31) return false;
  // Check actual date (catches Feb 30, etc.)
  const dt = new Date(yi, mi - 1, di);
  return (
    dt.getFullYear() === yi &&
    dt.getMonth() === mi - 1 &&
    dt.getDate() === di
  );
}

// Scan raw date strings to infer DMY vs MDY without user input.
// Logic: in A/B/YYYY — if any A > 12 it must be a day → DMY;
// if any B > 12 it must be a day → MDY. Falls back to "dmy" when ambiguous.
function detectDateFormat(dateStrings) {
  let mdyEvidence = 0;
  let dmyEvidence = 0;
  for (const raw of dateStrings) {
    if (!raw) continue;
    const s = String(raw).trim();
    if (/^\d{4}[\-\/]/.test(s)) continue; // ISO YYYY-… — skip, unambiguous
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-]\d{2,4}$/);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 12 && b <= 12) dmyEvidence++;
    else if (a <= 12 && b > 12) mdyEvidence++;
  }
  if (dmyEvidence > 0 && mdyEvidence === 0) return "dmy";
  return "mdy"; // default: MDY (US/Excel)
}

// fmt: "mdy" (default, US/Excel) | "dmy" (BR DD/MM/YYYY)
function parseDate(raw, fmt = "mdy") {
  if (!raw) return { value: null, error: "missing" };
  const s = String(raw).trim();
  // ISO YYYY-MM-DD or YYYY/MM/DD — unambiguous, ignore fmt
  let m = s.match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    const mm = mo.padStart(2, "0");
    const dd = d.padStart(2, "0");
    if (!isValidYMD(y, mm, dd)) return { value: null, error: "bad date" };
    return { value: `${y}-${mm}-${dd}`, error: null };
  }
  // Two-digit / slash date: DD/MM/YYYY (dmy) or MM/DD/YYYY (mdy)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? "19" : "20") + y;
    let d, mo;
    if (fmt === "mdy") {
      mo = a; d = b;
    } else {
      d = a; mo = b;
      // Auto-swap when month part > 12 but day part ≤ 12 (unambiguous MDY).
      if (parseInt(mo, 10) > 12 && parseInt(d, 10) <= 12) {
        [d, mo] = [mo, d];
      }
    }
    d = d.padStart(2, "0");
    mo = mo.padStart(2, "0");
    if (!isValidYMD(y, mo, d)) return { value: null, error: "bad date" };
    return { value: `${y}-${mo}-${d}`, error: null };
  }
  return { value: null, error: "bad date" };
}

function parseSide(raw) {
  if (!raw) return { value: null, error: "missing" };
  const s = String(raw).trim().toLowerCase();
  if (["buy", "compra", "b", "c"].includes(s)) return { value: "buy", error: null };
  if (["sell", "venda", "s", "v"].includes(s)) return { value: "sell", error: null };
  return { value: null, error: "bad side" };
}

function parseCurrency(raw) {
  if (!raw) return { value: "USD", error: null };
  const s = String(raw).trim().toUpperCase();
  if (s === "USD" || s === "$" || s === "US$") return { value: "USD", error: null };
  if (s === "BRL" || s === "R$" || s === "BR") return { value: "BRL", error: null };
  return { value: null, error: "bad currency" };
}

// Number parsing — returns {value, ambiguous}
// ambiguous=true if the string has a comma that could be decimal.
// Default rule: dot is decimal. Comma is treated as thousands separator if both
// present; if only comma, value is parsed without commas (will look wrong if
// it was meant as decimal — flagged ambiguous).
function parseNumberLoose(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return { value: null, ambiguous: false, error: "missing" };
  }
  const s = String(raw).trim().replace(/[$R\s]/g, "");
  if (!s) return { value: null, ambiguous: false, error: "missing" };

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  let cleaned;
  let ambiguous = false;
  if (hasDot && hasComma) {
    // Both present — assume comma = thousands, dot = decimal.
    cleaned = s.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    // Only comma — ambiguous: could be 1,500 (thousands) or 1,5 (decimal BR).
    cleaned = s.replace(/,/g, "");
    ambiguous = true;
  } else {
    cleaned = s;
  }
  const n = parseFloat(cleaned);
  if (!isFinite(n)) return { value: null, ambiguous, error: "not a number" };
  return { value: n, ambiguous, error: null };
}

// Re-parse with comma-as-decimal applied (used after user confirms in modal).
function parseNumberCommaDecimal(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim().replace(/[$R\s]/g, "");
  if (!s) return null;
  // Replace last comma with dot, strip dots and other commas as thousands sep.
  const lastComma = s.lastIndexOf(",");
  if (lastComma === -1) {
    // No comma — strip thousands dots if pattern like "1.500" with no decimal,
    // but leave normal "175.50" alone. Heuristic: dots followed by exactly 3
    // digits and nothing after suggest thousands.
    const looksLikeThousands = /^\d{1,3}(\.\d{3})+$/.test(s);
    const cleaned = looksLikeThousands ? s.replace(/\./g, "") : s;
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }
  const before = s.slice(0, lastComma).replace(/[,.]/g, "");
  const after = s.slice(lastComma + 1);
  const n = parseFloat(`${before}.${after}`);
  return isFinite(n) ? n : null;
}

// Parse a single row (object from PapaParse OR from paste-detected schema).
// Returns { ok, tx, errors, ambiguous, rawNumbers }
// Canonical key for duplicate detection: same ticker + side + qty + date.
function dupKey(tx) {
  const tk = String(tx.ticker || "").trim().toUpperCase();
  return `${tk}|${tx.side}|${Number(tx.qty)}|${tx.date}`;
}

// knownClassByTicker (optional Map ticker→assetClass): when a ticker already
// exists in saved transactions, reuse its asset class instead of inferring one.
function parseRow(row, defaultCurrency = "USD", knownClassByTicker = null, opts = {}) {
  const errors = [];
  const rawNumbers = {
    qty: row.qty,
    price: row.price,
    fee: row.fee,
  };

  const d = parseDate(row.date, opts.dateFormat || "dmy");
  if (d.error) errors.push(`date: ${d.error}`);

  const sd = parseSide(row.side);
  if (sd.error) errors.push(`side: ${sd.error}`);

  const ticker = String(row.ticker || "").trim().toUpperCase();
  if (!ticker) errors.push("ticker: missing");

  const qty = parseNumberLoose(row.qty);
  if (qty.error) errors.push(`qty: ${qty.error}`);
  else if (qty.value <= 0) errors.push("qty: must be > 0");

  const price = parseNumberLoose(row.price);
  if (price.error) errors.push(`price: ${price.error}`);
  else if (price.value < 0) errors.push("price: must be >= 0");

  let fee = { value: 0, ambiguous: false, error: null };
  if (row.fee !== undefined && row.fee !== "" && row.fee !== null) {
    fee = parseNumberLoose(row.fee);
    if (fee.error) errors.push(`fee: ${fee.error}`);
  }

  // Asset class: explicit field wins; else infer from ticker.
  // If neither resolves, mark needsAssetClass so user picks in preview.
  // Priority: explicit assetClass column → known class from saved transactions
  // for this ticker → inferAssetClass() heuristic → ask the user.
  let assetClass = normalizeAssetClass(row.assetClass);
  let needsAssetClass = false;
  let classFromHistory = false;
  if (!assetClass && ticker) {
    const known = knownClassByTicker && knownClassByTicker.get(ticker);
    if (known) {
      assetClass = known;
      classFromHistory = true;
    } else {
      const inferred = inferAssetClass(ticker);
      if (inferred) assetClass = inferred;
      else needsAssetClass = true;
    }
  } else if (!assetClass) {
    needsAssetClass = true;
  }
  const currency = assetClass ? currencyForAssetClass(assetClass) : defaultCurrency;

  if (row.assetClass && !assetClass) {
    errors.push(`assetClass: unknown "${row.assetClass}"`);
  }

  const ambiguous = qty.ambiguous || price.ambiguous || fee.ambiguous;

  if (errors.length > 0) {
    return { ok: false, tx: null, errors, ambiguous, needsAssetClass, classFromHistory, rawNumbers };
  }

  return {
    ok: !needsAssetClass,
    errors: needsAssetClass ? ["assetClass: pick one"] : [],
    ambiguous,
    needsAssetClass,
    classFromHistory,
    rawNumbers,
    tx: {
      id: newId(),
      date: d.value,
      side: sd.value,
      ticker,
      assetClass: assetClass || null,
      qty: qty.value,
      price: price.value,
      currency,
      fee: fee.value || 0,
      notes: String(row.notes || "").trim(),
      createdAt: new Date().toISOString(),
    },
  };
}

// Re-parse rows treating comma as decimal in numeric fields.
function reparseWithCommaDecimal(rows, defaultCurrency = "USD", knownClassByTicker = null, opts = {}) {
  return rows.map((row) => {
    const patched = {
      ...row,
      qty: parseNumberCommaDecimal(row.qty),
      price: parseNumberCommaDecimal(row.price),
      fee:
        row.fee === undefined || row.fee === null || row.fee === ""
          ? row.fee
          : parseNumberCommaDecimal(row.fee),
    };
    return parseRow(patched, defaultCurrency, knownClassByTicker, opts);
  });
}

// Detect headers from a paste/CSV first row. Returns null if no recognizable
// headers — caller should treat input as headerless and require column order.
const HEADER_ALIASES = {
  date: ["date", "data", "dt"],
  side: ["side", "tipo", "operacao", "operation", "type"],
  ticker: ["ticker", "symbol", "ativo", "asset", "papel"],
  qty: ["qty", "quantity", "quantidade", "qtd", "shares"],
  price: ["price", "preco", "preço", "cotacao", "cotação", "value", "valor"],
  assetClass: ["assetclass", "asset class", "class", "classe", "categoria"],
  fee: ["fee", "fees", "taxa", "tarifa", "corretagem"],
  notes: ["notes", "note", "obs", "observacao", "observação", "memo"],
};

function detectHeaderMap(firstRow) {
  const map = {};
  const seen = new Set();
  for (const h of firstRow) {
    const key = String(h || "").trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key) && !seen.has(field)) {
        map[h] = field;
        seen.add(field);
        break;
      }
    }
  }
  // Need at least date, side, ticker, qty, price to be confident.
  const required = ["date", "side", "ticker", "qty", "price"];
  const present = new Set(Object.values(map));
  if (required.every((r) => present.has(r))) return map;
  return null;
}

// Try to fix a row where comma-as-decimal broke the CSV structure.
// Strategy: anchor by the currency cell (USD/BRL) and merge digit pairs
// around it. Only attempts when exactly 1 extra column is detected; multiple
// broken fields per row return { ok: false } and the user is told to fix the
// source.
const CURRENCY_RX = /^(USD|BRL|US\$|R\$|\$)$/i;
function fixBRSplitRow(arr, expectedLen) {
  if (!Array.isArray(arr) || arr.length <= expectedLen) {
    return { ok: true, arr };
  }
  const extra = arr.length - expectedLen;
  if (extra > 1) return { ok: false, arr }; // too ambiguous

  let currIdx = -1;
  for (let i = 0; i < arr.length; i++) {
    if (CURRENCY_RX.test(String(arr[i] ?? "").trim())) {
      currIdx = i;
      break;
    }
  }
  if (currIdx === -1) return { ok: false, arr };

  // Case 1: currency pushed one to the right (price split into two cells)
  if (currIdx === 6) {
    const a = String(arr[4] ?? "");
    const b = String(arr[5] ?? "");
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      const merged = [...arr];
      merged.splice(4, 2, `${a}.${b}`);
      return { ok: true, arr: merged };
    }
  }
  // Case 2: currency in place but fee split into two cells
  if (currIdx === 5 && arr.length >= 8) {
    const a = String(arr[6] ?? "");
    const b = String(arr[7] ?? "");
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      const merged = [...arr];
      merged.splice(6, 2, `${a}.${b}`);
      return { ok: true, arr: merged };
    }
  }
  return { ok: false, arr };
}

// Parse paste text or CSV string into {rows, hadHeader, rawRows, structuralBreak, ...}
// When `autoFixBR` is true, applies fixBRSplitRow to data rows.
function parseCSVOrPaste(text, opts = {}) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { rows: [], hadHeader: false, rawRows: [], structuralBreak: false, delimiter: "," };
  }
  const result = Papa.parse(trimmed, {
    skipEmptyLines: true,
    delimitersToGuess: [",", ";", "\t", "|"],
  });
  if (!result.data || result.data.length === 0) {
    return { rows: [], hadHeader: false, rawRows: [], structuralBreak: false, delimiter: "," };
  }
  const allRows = result.data;
  const delimiter = result.meta?.delimiter || ",";
  const headerMap = detectHeaderMap(allRows[0]);
  let dataRows = headerMap ? allRows.slice(1) : allRows;
  const hadHeader = !!headerMap;

  const refLen = allRows[0].length;
  const structuralBreak =
    dataRows.length > 0 && dataRows.some((r) => r.length > refLen);

  let fixedRows = 0;
  let unfixableRows = 0;
  if (opts.autoFixBR && structuralBreak) {
    dataRows = dataRows.map((arr) => {
      if (arr.length <= refLen) return arr;
      const fix = fixBRSplitRow(arr, refLen);
      if (fix.ok) fixedRows++;
      else unfixableRows++;
      return fix.arr;
    });
  }

  const FIELD_ORDER = ["date", "side", "ticker", "qty", "price", "assetClass", "fee", "notes"];

  const rows = dataRows.map((arr) => {
    const obj = {};
    if (headerMap) {
      allRows[0].forEach((h, i) => {
        const field = headerMap[h];
        if (field) obj[field] = arr[i];
      });
    } else {
      FIELD_ORDER.forEach((field, i) => {
        if (arr[i] !== undefined) obj[field] = arr[i];
      });
    }
    return obj;
  });

  return {
    rows,
    hadHeader,
    rawRows: allRows,
    structuralBreak,
    delimiter,
    fixedRows,
    unfixableRows,
  };
}

// Fidelity "Accounts History" CSV parser.
// - Skips blank lines / BOM at start
// - Header row contains: Run Date, Action, Symbol, Price ($), Quantity, Fees ($)
// - Keeps only rows where Action startsWith "YOU BOUGHT" or "YOU SOLD"
// - SOLD has negative Quantity → take abs
// - Date format MM/DD/YYYY → ISO
// - All Fidelity transactions are USD; assetClass defaults to "Stocks"
//   (user can edit later)
// `knownBondsByDescKey` (optional Map descKey→CUSIP, built from saved Bank
// Bonds transactions): recovers the real CUSIP for bond rows where Fidelity
// left Symbol blank (jul/2026 export change), by matching the row's
// issuer+coupon+maturity description against bonds already in history.
function parseFidelityCSV(text, knownClassByTicker = null, knownBondsByDescKey = null) {
  console.log("Fidelity parser: processing rows");
  const result = Papa.parse(text, {
    skipEmptyLines: true,
    delimitersToGuess: [",", ";", "\t"],
  });
  if (!result.data || result.data.length === 0) {
    return { results: [], hadHeader: false, rawRows: [], sourceText: text };
  }

  // Find header row (contains "Run Date" and "Action").
  let headerIdx = -1;
  for (let i = 0; i < Math.min(8, result.data.length); i++) {
    const row = result.data[i].map((c) => String(c || "").trim().toLowerCase());
    if (row.includes("run date") && row.includes("action")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { results: [], hadHeader: false, rawRows: [], sourceText: text, error: "Fidelity header not found" };
  }

  const header = result.data[headerIdx].map((c) => String(c || "").trim());
  const colOf = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const idxDate = colOf("Run Date");
  const idxAction = colOf("Action");
  const idxSymbol = colOf("Symbol");
  // Fidelity renamed this column from "Symbol Description" to plain
  // "Description" in its jul/2026 "Accounts History" export — accept either.
  const idxDesc = colOf("Symbol Description") >= 0 ? colOf("Symbol Description") : colOf("Description");
  const idxPrice = colOf("Price ($)");
  const idxQty = colOf("Quantity");
  const idxFees = colOf("Fees ($)");
  const idxAmount = colOf("Amount ($)");

  if (idxDate < 0 || idxAction < 0 || idxSymbol < 0 || idxPrice < 0 || idxQty < 0) {
    return { results: [], hadHeader: true, rawRows: [], sourceText: text, error: "Required Fidelity columns missing" };
  }

  // Parse a Fidelity MM/DD/YYYY (or MM/DD/YY) date string to ISO, or null.
  // Fidelity's "Accounts History" export uses MM-DD-YYYY (dashes) while the
  // "Activity" export uses MM/DD/YYYY (slashes) — accept either separator.
  const toISO = (rawDate) => {
    const mdy = String(rawDate || "").trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    if (!mdy) return null;
    let [, mo, d, y] = mdy;
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? "19" : "20") + y;
    mo = mo.padStart(2, "0");
    d = d.padStart(2, "0");
    const yi = parseInt(y, 10), mi = parseInt(mo, 10), di = parseInt(d, 10);
    if (mi < 1 || mi > 12 || di < 1 || di > 31 || yi < 1900 || yi > 2100) return null;
    const dt = new Date(yi, mi - 1, di);
    if (dt.getFullYear() !== yi || dt.getMonth() !== mi - 1 || dt.getDate() !== di) return null;
    return `${y}-${mo}-${d}`;
  };

  const results = [];
  const rawRows = [];
  // Real interest/coupon payments detected from the Account History (item 36
  // follow-up). Stored separately from buy/sell transactions; never enter the
  // position-math path (computeNetQty/dupKey).
  const incomeEvents = [];
  // Purge list: rows that must NOT be income but that an older parser wrongly
  // captured — share distributions (Type "Shares", e.g. NOBL "DISTRIBUTION ...
  // DIVIDEND ARISTOCRATS") and core-cash/sweep interest ("INTEREST EARNED CASH").
  // Collected here keyed by date|ticker|amount so a re-import removes the exact
  // matching stale income record (see handleImport).
  const distributionEvents = [];
  for (let i = headerIdx + 1; i < result.data.length; i++) {
    const arr = result.data[i];
    if (!arr || arr.length === 0) continue;
    const action = String(arr[idxAction] || "").trim();
    const upper = action.toUpperCase();

    // Interest/coupon payment rows: capture as real income events, not txns.
    // Fidelity labels these "INTEREST" / "INTEREST EARNED" with the amount in
    // the Amount ($) column. Only keep CUSIP-symboled (bond/CD) payments — and
    // exclude core-cash/sweep interest ("INTEREST EARNED CASH", Symbol Description
    // "CASH"), which Fidelity reports separately from dividends and the user wants
    // out of the dividend/income KPI. (The cash symbol, e.g. 315994103, otherwise
    // matches CUSIP_RX since it's 9 digits.)
    if (upper.includes("INTEREST") && idxAmount >= 0) {
      const isoDateI = toISO(arr[idxDate]);
      let symbolI = String(arr[idxSymbol] || "").trim().toUpperCase();
      const descI = idxDesc >= 0 ? String(arr[idxDesc] || "").trim().toUpperCase() : "";
      const isCashSweep = upper.includes("EARNED CASH") || descI === "CASH";
      const amountI = parseFloat(String(arr[idxAmount] || "").replace(/[$,\s]/g, ""));
      // Fidelity sometimes omits Symbol for CD/bond interest rows (jul/2026).
      // Recover the real CUSIP from a bond already seen in saved transactions.
      if (!symbolI && !isCashSweep && knownBondsByDescKey) {
        const metaI = extractBondMeta(idxDesc >= 0 ? String(arr[idxDesc] || "") : "");
        const knownTicker = metaI && knownBondsByDescKey.get(metaI.descKey);
        if (knownTicker) symbolI = knownTicker;
      }
      if (isCashSweep && isoDateI && symbolI && isFinite(amountI) && amountI > 0) {
        // Record core-cash interest for purging — an older parser captured it as
        // bond interest, so re-importing must remove the stale matching record.
        distributionEvents.push({ date: isoDateI, ticker: symbolI, amount: amountI });
      } else if (isoDateI && symbolI && CUSIP_RX.test(symbolI) && isFinite(amountI) && amountI > 0) {
        incomeEvents.push({
          id: newId(),
          date: isoDateI,
          ticker: symbolI,
          amount: amountI,
          kind: "interest",
          source: "fidelity",
        });
      }
      continue;
    }

    // Foreign tax withheld on ADR dividends (e.g. TSM, VALE — foreign issuers filing
    // 20-F). Fidelity reports this as its own row ("FOREIGN TAX PAID" / "FOREIGN TAX
    // WITHHELD"), separate from the DIVIDEND RECEIVED row for the same payment — the
    // dividend row is the gross amount credited, this row is the tax debited right
    // after. Captured for visibility (its own row + KPI in Dividend History); never
    // subtracted from the dividend event's totalReceived, which stays the gross amount
    // Fidelity actually reported.
    if (upper.includes("FOREIGN TAX") && idxAmount >= 0) {
      const isoDateT = toISO(arr[idxDate]);
      const symbolT = String(arr[idxSymbol] || "").trim().toUpperCase();
      const amountT = parseFloat(String(arr[idxAmount] || "").replace(/[$,\s]/g, ""));
      if (isoDateT && symbolT && !CUSIP_RX.test(symbolT) && isFinite(amountT) && amountT !== 0) {
        incomeEvents.push({
          id: newId(),
          date: isoDateT,
          ticker: symbolT,
          amount: Math.abs(amountT),
          kind: "tax",
          source: "fidelity",
        });
      }
      continue;
    }

    // Stock dividend payment rows: capture for non-CUSIP tickers (e.g. VALE, AAPL).
    // Fidelity labels these "DIVIDEND RECEIVED", "CASH DIV", "ORDINARY DIVIDEND", etc.
    // Amount ($) is the total cash received (not per-share). Skip REINVESTMENT rows.
    if ((upper.includes("DIVIDEND") || upper === "CASH DIV") &&
        !upper.startsWith("DISTRIBUTION") && !upper.includes("REINVEST") &&
        !upper.includes("YOU BOUGHT") && !upper.includes("YOU SOLD") && idxAmount >= 0) {
      const isoDateD = toISO(arr[idxDate]);
      const symbolD = String(arr[idxSymbol] || "").trim().toUpperCase();
      const amountD = parseFloat(String(arr[idxAmount] || "").replace(/[$,\s]/g, ""));
      if (isoDateD && symbolD && !CUSIP_RX.test(symbolD) && isFinite(amountD) && amountD > 0) {
        incomeEvents.push({
          id: newId(),
          date: isoDateD,
          ticker: symbolD,
          amount: amountD,
          kind: "dividend",
          source: "fidelity",
        });
      }
      continue;
    }

    // Share distributions (paid in shares, not cash). Record for stale-record
    // purging, then skip — they must never enter the income or transaction path.
    if (upper.startsWith("DISTRIBUTION")) {
      const isoDateX = toISO(arr[idxDate]);
      const symbolX = String(arr[idxSymbol] || "").trim().toUpperCase();
      const amountX = idxAmount >= 0
        ? parseFloat(String(arr[idxAmount] || "").replace(/[$,\s]/g, ""))
        : NaN;
      if (isoDateX && symbolX && isFinite(amountX) && amountX > 0) {
        distributionEvents.push({ date: isoDateX, ticker: symbolX, amount: amountX });
      }
      continue;
    }

    let side = null;
    let isRedemption = false;
    if (upper.includes("YOU BOUGHT")) side = "buy";
    else if (upper.includes("YOU SOLD")) side = "sell";
    else if (upper.includes("REDEMPTION") || upper.startsWith("REDEEMED")) {
      // Bond/CD maturity: Fidelity returns the principal as a REDEMPTION row.
      // Record it as a sell of the CUSIP so the position math removes the
      // matching qty/price bought earlier (zeroes the holding's principal).
      side = "sell";
      isRedemption = true;
    } else continue; // skip dividends, contributions, etc.

    // Fidelity dates are always MM/DD/YYYY (US format). Override the
    // BR-default parseDate which would interpret 05/08/2026 as DMY.
    const isoDate = toISO(arr[idxDate]);
    if (!isoDate) continue; // skip malformed rows silently

    let symbol = String(arr[idxSymbol] || "").trim().toUpperCase();
    const descRaw = idxDesc >= 0 ? String(arr[idxDesc] || "") : "";
    let bondMeta = null;
    let needsTicker = false;
    if (!symbol) {
      // Fidelity sometimes omits Symbol for CD/bond rows (jul/2026 export
      // change) — no CUSIP anywhere else in the row either. Try to recover
      // the real CUSIP from a bond already seen in saved transactions.
      bondMeta = extractBondMeta(descRaw);
      if (bondMeta && knownBondsByDescKey) {
        const knownTicker = knownBondsByDescKey.get(bondMeta.descKey);
        if (knownTicker) symbol = knownTicker;
      }
      if (!symbol) {
        if (bondMeta && side === "buy" && !isRedemption) {
          // Brand-new bond purchase with no CUSIP anywhere in the CSV —
          // surface it for manual entry instead of silently dropping it.
          needsTicker = true;
        } else {
          // Interest/redemption rows for a bond we have no history for, or a
          // non-bond row with a genuinely missing symbol — nothing to do.
          continue;
        }
      }
    }
    // Redemptions only make sense for CUSIP-symboled bonds/CDs.
    if (isRedemption && symbol && !CUSIP_RX.test(symbol)) continue;

    const amountAbs = idxAmount >= 0
      ? Math.abs(parseFloat(String(arr[idxAmount] || "").replace(/[$,\s]/g, "")))
      : NaN;

    let qtyRaw = parseFloat(String(arr[idxQty] || "").replace(/[,\s]/g, ""));
    // Redemption rows sometimes omit Quantity; the Amount ($) equals the face
    // value returned, which is the same unit Fidelity uses for bond Quantity.
    if (isRedemption && (!isFinite(qtyRaw) || qtyRaw === 0) && isFinite(amountAbs) && amountAbs > 0) {
      qtyRaw = amountAbs;
    }
    if (!isFinite(qtyRaw) || qtyRaw === 0) continue;
    const qtyAbs = Math.abs(qtyRaw);

    let priceN = parseFloat(String(arr[idxPrice] || "").replace(/[$,\s]/g, ""));
    // Redemption rows usually have a blank Price ($): the bond is paid back at
    // face. For redemptions Fidelity uses decimal-fraction space (1.0 = par),
    // not percent-of-face (100.0 = par) — so derive in the same decimal space
    // and apply the ×1000 correction below uniformly.
    if (isRedemption && (!isFinite(priceN) || priceN <= 0)) {
      const units = qtyAbs / 1000;
      priceN = isFinite(amountAbs) && amountAbs > 0 && units > 0
        ? amountAbs / units / 1000
        : 1;
    }
    if (!isFinite(priceN) || priceN < 0) continue;

    let fee = 0;
    if (idxFees >= 0) {
      const fn = parseFloat(String(arr[idxFees] || "").replace(/[$,\s]/g, ""));
      if (isFinite(fn) && fn > 0) fee = fn;
    }

    // Reuse a saved asset class for this ticker if known; else infer from the
    // symbol, falling back to "Stocks" for plain US tickers. A row awaiting
    // manual CUSIP entry is already known to be a bond from its description.
    const known = symbol ? knownClassByTicker && knownClassByTicker.get(symbol) : null;
    const assetClass = needsTicker ? "Bank Bonds" : known || inferAssetClass(symbol) || "Stocks";

    // Item 40: Fidelity reports CD/bond Quantity as face value in dollars
    // (e.g. 1000 = one $1,000 CD) and Price ($) as percent-of-face for
    // buys/sells (100.00 → ×10 = $1,000/unit), but as decimal-fraction for
    // redemptions (1.00 → ×1000 = $1,000/unit). Plain tickers untouched.
    const qty = assetClass === "Bank Bonds" ? qtyAbs / 1000 : qtyAbs;
    const price = assetClass === "Bank Bonds"
      ? (isRedemption ? priceN * 1000 : priceN * 10)
      : priceN;

    // Extract bond metadata from the Symbol Description field (reuse the
    // meta already computed above when this row went through CUSIP recovery).
    let meta = null;
    if (assetClass === "Bank Bonds") {
      meta = bondMeta || (idxDesc >= 0 ? extractBondMeta(descRaw) : null) || {};
    }
    const notes = meta?.notes || "";
    const couponRate = meta?.couponRate ?? null;
    const maturityDate = meta?.maturityDate ?? null;
    const bondType = meta?.bondType ?? null;
    const shortName = meta?.shortName ?? null;
    const couponFreq = meta?.couponFreq ?? null;

    const tx = {
      id: newId(),
      date: isoDate,
      side,
      ticker: symbol, // "" when needsTicker — user must fill in the CUSIP
      assetClass,
      qty,
      price,
      currency: "USD",
      fee,
      notes,
      ...(assetClass === "Bank Bonds" && {
        couponRate,
        maturityDate,
        bondType,
        shortName,
        couponFreq,
      }),
      ...(isRedemption && { redemption: true }),
      createdAt: new Date().toISOString(),
    };

    results.push({
      ok: !needsTicker,
      errors: needsTicker ? ["ticker: CUSIP missing — Fidelity didn't report it, enter manually"] : [],
      ambiguous: false,
      needsAssetClass: false,
      needsTicker,
      classFromHistory: !!known,
      rawNumbers: { qty: qtyRaw, price: priceN, fee },
      tx,
    });
    rawRows.push(arr);
  }

  return { results, incomeEvents, distributionEvents, hadHeader: true, rawRows, sourceText: text };
}

export {
  newId,
  ASSET_CLASSES,
  ASSET_CLASS_IDS,
  currencyForAssetClass,
  normalizeAssetClass,
  B3_RX,
  CUSIP_RX,
  inferCurrency,
  FIXED_INCOME_ETFS,
  REAL_ESTATE_ETFS,
  inferAssetClass,
  isValidYMD,
  detectDateFormat,
  parseDate,
  parseSide,
  parseCurrency,
  parseNumberLoose,
  parseNumberCommaDecimal,
  dupKey,
  parseRow,
  reparseWithCommaDecimal,
  HEADER_ALIASES,
  detectHeaderMap,
  fixBRSplitRow,
  parseCSVOrPaste,
  extractBondMeta,
  parseFidelityCSV,
};
