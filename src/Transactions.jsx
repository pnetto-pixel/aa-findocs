// src/Transactions.jsx
// Chunk 1B: add form, chronological list, inline edit, direct delete, filters.
// Bulk paste + CSV upload land in 1C.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Pencil, X, Check, Upload, Download, AlertCircle, ChevronDown, RefreshCw } from "lucide-react";
import Papa from "papaparse";

const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_MONO = "'JetBrains Mono', 'Geist Mono', monospace";

// Theme tokens — mirrors App.jsx palette so the new view feels native.
const T = {
  card: "#13161b",
  cardElev: "#191d24",
  border: "#222831",
  borderSoft: "#1a1e25",
  text: "#ece8e0",
  textDim: "#8a8f99",
  textFaint: "#5a5f69",
  gold: "#c9a961",
  green: "#7dd3a4",
  red: "#e88c8c",
};

function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

// Verify a ticker resolves against a price source (api/price).
// Returns "ok" (price found), "error" (source resolved but no such ticker),
// or "unknown" (transient/network failure — don't flag, retry later).
async function verifyTickerResolvable(ticker, auth) {
  try {
    const params = new URLSearchParams({ ticker, quoteOnly: "1" });
    const res = await fetch(`/api/price?${params.toString()}`, {
      headers: authHeaders(auth),
    });
    if (res.status === 401) {
      const err = new Error("Unauthorized");
      err.code = 401;
      throw err;
    }
    // 400/404/502 → the price source could not identify this ticker.
    if (res.status === 400 || res.status === 404 || res.status === 502) {
      return "error";
    }
    if (!res.ok) return "unknown"; // 5xx/transient — retry later
    const d = await res.json();
    if (d && d.error) return "error";
    if (d && d.price != null) return "ok";
    return "error";
  } catch (e) {
    if (e.code === 401) throw e;
    return "unknown"; // network failure — don't flag
  }
}

// Tickers we don't expect a price API to resolve (manual instruments).
// CUSIP-style bank bonds and cash-like classes are user-entered, not market-priced.
function shouldVerifyTicker(tx) {
  const t = (tx?.ticker || "").trim();
  if (!t) return false;
  if (CUSIP_RX.test(t.toUpperCase())) return false;
  if (/^tesouro-/i.test(t)) return false; // no public price source — entered manually
  const cls = (tx?.assetClass || "").toLowerCase();
  if (cls === "cash" || cls.startsWith("unallocated") || cls === "bank bonds" || cls === "bra fixed income") {
    return false;
  }
  return true;
}

async function fetchTransactionsFromServer(auth) {
  const res = await fetch("/api/transactions", {
    headers: authHeaders(auth),
  });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (res.status === 503) {
    const err = new Error("Storage not configured");
    err.code = 503;
    throw err;
  }
  if (!res.ok) {
    let msg = `Storage ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

export async function saveTransactionsToServer(auth, transactions, bondIncome, splitEvents) {
  // bondIncome / splitEvents are optional; when omitted the server preserves
  // the existing value (read-modify-write), so non-import saves never wipe them.
  const body = { transactions };
  if (Array.isArray(bondIncome)) body.bondIncome = bondIncome;
  if (Array.isArray(splitEvents)) body.splitEvents = splitEvents;
  const res = await fetch("/api/transactions", {
    method: "PUT",
    headers: {
      ...authHeaders(auth),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Save ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

// Fidelity automation staging (item 38): read/clear the `:fidelity-pending` blob
// written by the scraper via the service-token endpoint. Uses normal user auth.
// Fail-silent: a user who never enabled the automation just gets an empty result.
async function fetchPendingFidelity(auth) {
  try {
    const res = await fetch("/api/fidelity-pending", { headers: authHeaders(auth) });
    if (!res.ok) return { transactions: [], bondIncome: [] };
    const d = await res.json();
    return {
      transactions: Array.isArray(d.transactions) ? d.transactions : [],
      bondIncome: Array.isArray(d.bondIncome) ? d.bondIncome : [],
      updatedAt: d.updatedAt || null,
    };
  } catch {
    return { transactions: [], bondIncome: [] };
  }
}

async function clearPendingFidelity(auth) {
  try {
    await fetch("/api/fidelity-pending", { method: "DELETE", headers: authHeaders(auth) });
  } catch {}
}

// UUID — falls back if crypto.randomUUID is unavailable.
function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtNum(n, digits = 4) {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
}

function fmtMoney(n, currency = "USD") {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// Compact price display: "$175.50" / "R$ 38.20".
function fmtPrice(n, currency = "USD") {
  if (n == null || isNaN(n)) return "—";
  const num = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return currency === "BRL" ? `R$ ${num}` : `$${num}`;
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

// --- Styled primitives (kept minimal; reuse App.jsx tokens) ----------------

function Input({ style, onEnter, ...props }) {
  return (
    <input
      {...props}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) onEnter();
      }}
      style={{
        background: T.cardElev,
        border: `1px solid ${T.border}`,
        color: T.text,
        padding: "10px 12px",
        fontSize: 14,
        fontFamily: FONT_MONO,
        borderRadius: 2,
        width: "100%",
        boxSizing: "border-box",
        outline: "none",
        ...style,
      }}
    />
  );
}

function Label({ children }) {
  return (
    <div
      style={{
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: "0.18em",
        color: T.textDim,
        textTransform: "uppercase",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

// --- Add/Edit Form ---------------------------------------------------------

function shouldSkipValidation(ticker, assetClass) {
  if (!ticker) return true;
  if (/^tesouro-/i.test(ticker)) return true;
  if (assetClass === "BRA Fixed Income") return true;
  if (assetClass === "Bank Bonds") return true;
  if (/^[0-9A-Z]{9}[0-9]$/.test(ticker)) return true;
  return false;
}

async function validateTickerViaAPI(ticker, auth) {
  try {
    const res = await fetch(`/api/price?ticker=${encodeURIComponent(ticker)}`, {
      headers: authHeaders(auth),
    });
    if (!res.ok) return { valid: false };
    return { valid: true };
  } catch {
    return { valid: true };
  }
}

function TransactionForm({ initial, knownTickers, onSubmit, onCancel, busy, auth }) {
  const isEdit = !!initial;
  const [date, setDate] = useState(initial?.date || todayISO());
  const [side, setSide] = useState(initial?.side || "buy");
  const [ticker, setTicker] = useState(initial?.ticker || "");
  const [qty, setQty] = useState(initial ? String(initial.qty) : "");
  const [price, setPrice] = useState(initial ? String(initial.price) : "");
  const [assetClass, setAssetClass] = useState(initial?.assetClass || "");
  const [fee, setFee] = useState(initial?.fee ? String(initial.fee) : "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [error, setError] = useState("");
  const [showTickerList, setShowTickerList] = useState(false);
  const [tickerValidating, setTickerValidating] = useState(false);
  const [tickerError, setTickerError] = useState("");

  const currency = currencyForAssetClass(assetClass) || "USD";

  const tickerSuggestions = useMemo(() => {
    const q = ticker.trim().toUpperCase();
    if (!q) return [];
    return knownTickers
      .filter((t) => t.toUpperCase().includes(q) && t.toUpperCase() !== q)
      .slice(0, 6);
  }, [ticker, knownTickers]);

  // Auto-fill asset class from ticker when the field is still empty.
  useEffect(() => {
    if (assetClass) return;
    const inferred = inferAssetClass(ticker.trim());
    if (inferred) setAssetClass(inferred);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  function handleSubmit() {
    setError("");
    if (tickerValidating) { setError("Validating ticker, please wait..."); return; }
    if (tickerError) { setError(tickerError); return; }
    const tkr = ticker.trim().toUpperCase();
    if (!tkr) return setError("Ticker required");
    if (!assetClass) return setError("Asset class required");
    const qn = parseFloat(qty);
    const pn = parseFloat(price);
    if (!isFinite(qn) || qn <= 0) return setError("Qty must be > 0");
    if (!isFinite(pn) || pn < 0) return setError("Price must be >= 0");
    const feeN = fee ? parseFloat(fee) : 0;
    if (fee && (!isFinite(feeN) || feeN < 0)) return setError("Fee invalid");
    if (!date) return setError("Date required");

    const tx = {
      id: initial?.id || newId(),
      date,
      side,
      ticker: tkr,
      assetClass,
      qty: qn,
      price: pn,
      currency,
      fee: feeN,
      notes: notes.trim(),
      createdAt: initial?.createdAt || new Date().toISOString(),
    };
    onSubmit(tx);
  }

  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.borderSoft}`,
        padding: 20,
        marginBottom: 18,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.2em",
          color: T.gold,
          textTransform: "uppercase",
          marginBottom: 14,
        }}
      >
        {isEdit ? "Edit Transaction" : "New Transaction"}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <div>
          <Label>Date</Label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div>
          <Label>Side</Label>
          <div style={{ display: "flex", gap: 6 }}>
            {["buy", "sell"].map((s) => {
              const active = side === s;
              return (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  style={{
                    flex: 1,
                    background: active
                      ? s === "buy"
                        ? "rgba(125, 211, 164, 0.12)"
                        : "rgba(232, 140, 140, 0.12)"
                      : "transparent",
                    border: `1px solid ${
                      active ? (s === "buy" ? T.green : T.red) : T.border
                    }`,
                    color: active ? (s === "buy" ? T.green : T.red) : T.textDim,
                    padding: "10px 12px",
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ gridColumn: "1 / -1", position: "relative" }}>
          <Label>Ticker</Label>
          <Input
            placeholder="AAPL, BBSE3, TESOURO-IPCA-2035..."
            value={ticker}
            onChange={(e) => { setTicker(e.target.value.toUpperCase()); setTickerError(""); }}
            onFocus={() => setShowTickerList(true)}
            onBlur={() => {
              setTimeout(() => setShowTickerList(false), 150);
              const tkr = ticker.trim().toUpperCase();
              if (tkr && !shouldSkipValidation(tkr, assetClass)) {
                setTickerValidating(true);
                setTickerError("");
                validateTickerViaAPI(tkr, auth)
                  .then(({ valid }) => {
                    if (!valid) setTickerError(`Ticker "${tkr}" not found. Check for typos.`);
                  })
                  .finally(() => setTickerValidating(false));
              }
            }}
            style={{ textTransform: "uppercase" }}
          />
          {tickerValidating && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>Checking ticker...</span>
          )}
          {tickerError && !tickerValidating && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.red || "#f87171" }}>{tickerError}</span>
          )}
          {showTickerList && tickerSuggestions.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                background: T.cardElev,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                zIndex: 10,
                maxHeight: 180,
                overflowY: "auto",
              }}
            >
              {tickerSuggestions.map((t) => (
                <button
                  key={t}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setTicker(t);
                    setShowTickerList(false);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: T.text,
                    padding: "8px 12px",
                    fontFamily: FONT_MONO,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <Label>Quantity</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="any"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </div>
        <div>
          <Label>Price</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="any"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>

        <div>
          <Label>
            Asset Class
            {assetClass && (
              <span style={{ color: T.gold, marginLeft: 6, letterSpacing: 0 }}>
                ({currency})
              </span>
            )}
          </Label>
          <select
            value={assetClass}
            onChange={(e) => setAssetClass(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: T.cardElev,
              border: `1px solid ${T.border}`,
              color: assetClass ? T.text : T.textFaint,
              padding: "10px 12px",
              fontSize: 14,
              fontFamily: FONT_MONO,
              borderRadius: 2,
              outline: "none",
              cursor: "pointer",
            }}
          >
            <option value="">— Select —</option>
            {ASSET_CLASS_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Fee (optional)</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="any"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
          />
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <Label>Notes (optional)</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            color: T.red,
            fontFamily: FONT_MONO,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          onClick={handleSubmit}
          disabled={busy}
          style={{
            background: T.gold,
            border: "none",
            color: "#0b0d10",
            padding: "10px 16px",
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Check size={12} />
          {isEdit ? "Save" : "Add"}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            background: "transparent",
            border: `1px solid ${T.border}`,
            color: T.textDim,
            padding: "10px 16px",
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <X size={12} />
          Cancel
        </button>
      </div>
    </div>
  );
}

// --- Helpers: currency inference + table sort/filter -----------------------

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

// --- Filter dropdown popover ----------------------------------------------

// HeaderPopover: unified sort + filter popover anchored to a header cell.
// - Always shows sort buttons (asc/desc).
// - Filter section appears only when `filterable` is true.
// - Date column gets From/To range instead of value checkboxes.
function HeaderPopover({
  anchor,
  onClose,
  // sort
  sortDir, // "asc" | "desc"
  onSort,
  // filter
  filterable,
  options,
  selected,
  onChange,
  optionLabel,
  // date range
  dateRange,
  setDateRange,
}) {
  const ref = useRef(null);
  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", handle);
    document.addEventListener("touchstart", handle);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("touchstart", handle);
    };
  }, [onClose]);

  const rect = anchor?.getBoundingClientRect();
  const POPOVER_W = 240;
  const style = rect
    ? {
        position: "fixed",
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_W - 8)),
        zIndex: 50,
        width: POPOVER_W,
      }
    : { display: "none" };

  const sectionLabel = {
    fontFamily: FONT_MONO,
    fontSize: 9,
    letterSpacing: "0.2em",
    color: T.textFaint,
    textTransform: "uppercase",
    marginBottom: 8,
  };

  function SortBtn({ dir, label }) {
    const active = sortDir === dir;
    return (
      <button
        onClick={() => onSort(dir)}
        style={{
          flex: 1,
          background: active ? "rgba(201, 169, 97, 0.12)" : "transparent",
          border: `1px solid ${active ? T.gold : T.border}`,
          color: active ? T.gold : T.textDim,
          padding: "8px 6px",
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      ref={ref}
      style={{
        ...style,
        background: T.cardElev,
        border: `1px solid ${T.border}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        padding: 12,
        maxHeight: 380,
        overflowY: "auto",
      }}
    >
      {/* Sort section */}
      <div style={sectionLabel}>Sort</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <SortBtn dir="asc" label="↑ Asc" />
        <SortBtn dir="desc" label="↓ Desc" />
      </div>

      {/* Filter section */}
      {filterable && dateRange && (
        <>
          <div
            style={{
              height: 1,
              background: T.border,
              marginBottom: 12,
            }}
          />
          <div style={sectionLabel}>Date range</div>
          <Label>From</Label>
          <Input
            type="date"
            value={dateRange.from}
            onChange={(e) => setDateRange({ ...dateRange, from: e.target.value })}
            style={{ marginBottom: 8 }}
          />
          <Label>To</Label>
          <Input
            type="date"
            value={dateRange.to}
            onChange={(e) => setDateRange({ ...dateRange, to: e.target.value })}
            style={{ marginBottom: 8 }}
          />
          <button
            onClick={() => setDateRange({ from: "", to: "" })}
            style={{
              background: "transparent",
              border: `1px solid ${T.border}`,
              color: T.textDim,
              padding: "6px 10px",
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              cursor: "pointer",
              width: "100%",
            }}
          >
            Clear range
          </button>
        </>
      )}

      {filterable && !dateRange && (
        <>
          <div
            style={{
              height: 1,
              background: T.border,
              marginBottom: 12,
            }}
          />
          <div style={sectionLabel}>Filter</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <button
              onClick={() => onChange(new Set(options))}
              style={{
                background: "transparent",
                border: "none",
                color: T.gold,
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                cursor: "pointer",
                padding: 0,
              }}
            >
              All
            </button>
            <button
              onClick={() => onChange(new Set())}
              style={{
                background: "transparent",
                border: "none",
                color: T.textDim,
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                cursor: "pointer",
                padding: 0,
              }}
            >
              None
            </button>
          </div>
          {options.length === 0 && (
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: T.textFaint,
                padding: 8,
              }}
            >
              No values
            </div>
          )}
          {options.map((opt) => {
            const checked = selected.has(opt);
            return (
              <label
                key={opt}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 4px",
                  cursor: "pointer",
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: T.text,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = new Set(selected);
                    if (checked) next.delete(opt);
                    else next.add(opt);
                    onChange(next);
                  }}
                  style={{ accentColor: T.gold }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {optionLabel ? optionLabel(opt) : opt}
                </span>
              </label>
            );
          })}
        </>
      )}
    </div>
  );
}

// --- TransactionTable ------------------------------------------------------

function TransactionTable({
  transactions,
  onEdit,
  onDelete,
  onUpdate,
  onBulkDelete,
  onBulkAssetClass,
  busy,
  valuesHidden,
  tickerStatus = {},
  checkingTickers,
}) {
  const [openCol, setOpenCol] = useState(null); // column key for popover
  const [anchor, setAnchor] = useState(null);
  const [selected, setSelected] = useState(() => new Set()); // tx ids
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null); // edit buffer
  const [bulkClassMenu, setBulkClassMenu] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  // Each filter: Set of allowed values; if empty, treat as "all" (no filter).
  // Defaults are computed lazily from the data.
  const allValues = useMemo(() => {
    const s = new Set();
    const t = new Set();
    const a = new Set();
    for (const tx of transactions) {
      s.add(tx.side);
      t.add(tx.ticker);
      if (tx.assetClass) a.add(tx.assetClass);
    }
    return {
      side: Array.from(s).sort(),
      ticker: Array.from(t).sort(),
      assetClass: Array.from(a).sort(),
    };
  }, [transactions]);

  const [filters, setFilters] = useState({
    side: new Set(),
    ticker: new Set(),
    assetClass: new Set(),
    dateFrom: "",
    dateTo: "",
  });

  const [sort, setSort] = useState({ col: "date", dir: "desc" });

  function isFiltered(col) {
    if (col === "date") return !!(filters.dateFrom || filters.dateTo);
    const f = filters[col];
    if (!f) return false;
    return f.size > 0 && f.size < allValues[col].length;
  }

  const visible = useMemo(() => {
    let list = transactions.filter((t) => {
      if (filters.side.size > 0 && !filters.side.has(t.side)) return false;
      if (filters.ticker.size > 0 && !filters.ticker.has(t.ticker)) return false;
      if (filters.assetClass.size > 0 && !filters.assetClass.has(t.assetClass)) return false;
      if (filters.dateFrom && t.date < filters.dateFrom) return false;
      if (filters.dateTo && t.date > filters.dateTo) return false;
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const ka = a[sort.col];
      const kb = b[sort.col];
      if (sort.col === "qty" || sort.col === "price" || sort.col === "fee") {
        return ((Number(ka) || 0) - (Number(kb) || 0)) * dir;
      }
      const sa = String(ka ?? "");
      const sb = String(kb ?? "");
      if (sa === sb) return 0;
      return (sa < sb ? -1 : 1) * dir;
    });
    return list;
  }, [transactions, filters, sort]);

  function setSortFor(col, dir) {
    setSort({ col, dir });
  }

  // Returns "asc" | "desc" for the popover to show the currently active dir
  // when this column is the active sort, otherwise a sensible default.
  function sortDirFor(col) {
    if (sort.col === col) return sort.dir;
    return col === "date" ? "desc" : "asc";
  }

  function toggleSelect(id) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function toggleSelectAllVisible() {
    setSelected((cur) => {
      const visibleIds = visible.map((t) => t.id);
      const allSelected = visibleIds.every((id) => cur.has(id));
      const next = new Set(cur);
      if (allSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  function startEdit(tx) {
    setEditingId(tx.id);
    setDraft({
      date: tx.date,
      side: tx.side,
      assetClass: tx.assetClass || "",
      ticker: tx.ticker,
      qty: String(tx.qty),
      price: String(tx.price),
      fee: tx.fee ? String(tx.fee) : "",
      notes: tx.notes || "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  function commitEdit() {
    if (!draft || !editingId) return;
    const original = transactions.find((t) => t.id === editingId);
    if (!original) {
      cancelEdit();
      return;
    }
    const qn = parseFloat(draft.qty);
    const pn = parseFloat(draft.price);
    const feeN = draft.fee ? parseFloat(draft.fee) : 0;
    if (!draft.date) return;
    if (!isFinite(qn) || qn <= 0) return;
    if (!isFinite(pn) || pn < 0) return;
    if (draft.fee && (!isFinite(feeN) || feeN < 0)) return;
    if (!draft.assetClass) return;
    const tkr = draft.ticker.trim().toUpperCase();
    if (!tkr) return;
    const cur = currencyForAssetClass(draft.assetClass) || "USD";
    const updated = {
      ...original,
      date: draft.date,
      side: draft.side,
      assetClass: draft.assetClass,
      ticker: tkr,
      qty: qn,
      price: pn,
      currency: cur,
      fee: feeN,
      notes: draft.notes.trim(),
    };
    if (typeof onUpdate === "function") onUpdate(updated);
    cancelEdit();
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    if (typeof onBulkDelete === "function") {
      await onBulkDelete(Array.from(selected));
    }
    clearSelection();
    setConfirmBulkDelete(false);
  }

  async function handleBulkAssetClass(cls) {
    if (selected.size === 0) return;
    if (typeof onBulkAssetClass === "function") {
      await onBulkAssetClass(Array.from(selected), cls);
    }
    setBulkClassMenu(false);
    clearSelection();
  }

  function HeaderCell({ col, label, align = "left", width }) {
    const filtered = isFiltered(col);
    const sorted = sort.col === col;
    const active = sorted || filtered;
    return (
      <th
        style={{
          padding: 0,
          textAlign: align,
          borderBottom: `1px solid ${T.border}`,
          background: T.card,
          width,
          position: "sticky",
          top: 0,
          zIndex: 2,
        }}
      >
        <button
          onClick={(e) => {
            if (openCol === col) {
              setOpenCol(null);
              setAnchor(null);
            } else {
              setOpenCol(col);
              setAnchor(e.currentTarget);
            }
          }}
          title={`${label} — sort & filter`}
          style={{
            width: "100%",
            background: "transparent",
            border: "none",
            color: active ? T.gold : T.textDim,
            padding: "10px 6px",
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            textAlign: align,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
            justifyContent: align === "right" ? "flex-end" : "flex-start",
          }}
        >
          {label}
          {sorted && (
            <span style={{ fontSize: 9 }}>{sort.dir === "asc" ? "↑" : "↓"}</span>
          )}
          {filtered && !sorted && (
            <span style={{ fontSize: 9, color: T.gold }}>•</span>
          )}
        </button>
      </th>
    );
  }

  function setColFilter(col, next) {
    setFilters((cur) => ({ ...cur, [col]: next }));
  }

  return (
    <div>
      {/* Bulk toolbar */}
      {selected.size > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: T.cardElev,
            border: `1px solid ${T.gold}`,
            padding: "10px 12px",
            marginBottom: 8,
            fontFamily: FONT_MONO,
            fontSize: 11,
            position: "relative",
          }}
        >
          <span style={{ color: T.gold, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            {selected.size} selected
          </span>
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setBulkClassMenu((v) => !v)}
              disabled={busy}
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                color: T.text,
                padding: "6px 10px",
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              Change class ▾
            </button>
            {bulkClassMenu && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 4,
                  background: T.cardElev,
                  border: `1px solid ${T.border}`,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                  zIndex: 30,
                  minWidth: 180,
                }}
              >
                {ASSET_CLASS_IDS.map((id) => (
                  <button
                    key={id}
                    onClick={() => handleBulkAssetClass(id)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: T.text,
                      padding: "8px 12px",
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setConfirmBulkDelete(true)}
            disabled={busy}
            style={{
              background: "transparent",
              border: `1px solid ${T.red}`,
              color: T.red,
              padding: "6px 10px",
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Delete
          </button>
          <button
            onClick={clearSelection}
            style={{
              background: "transparent",
              border: "none",
              color: T.textDim,
              padding: "4px 6px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
            title="Clear selection"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Confirm bulk delete modal */}
      {confirmBulkDelete && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
          onClick={() => setConfirmBulkDelete(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.cardElev,
              border: `1px solid ${T.red}`,
              padding: 20,
              maxWidth: 360,
              width: "100%",
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.2em",
                color: T.red,
                textTransform: "uppercase",
                marginBottom: 10,
              }}
            >
              Confirm delete
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.text, marginBottom: 16, lineHeight: 1.5 }}>
              Delete {selected.size} transaction{selected.size === 1 ? "" : "s"}? This cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleBulkDelete}
                disabled={busy}
                style={{
                  background: T.red,
                  border: "none",
                  color: "#0b0d10",
                  padding: "10px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmBulkDelete(false)}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.border}`,
                  color: T.textDim,
                  padding: "10px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

    <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
    <div style={{ position: "relative", border: `1px solid ${T.borderSoft}` }}>
      <table
        style={{
          width: "100%",
          minWidth: 760,
          borderCollapse: "collapse",
          fontFamily: FONT_MONO,
          fontSize: 11,
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          <col style={{ width: "28px" }} />
          <col style={{ width: "90px" }} />
          <col style={{ width: "36px" }} />
          <col style={{ width: "110px" }} />
          <col style={{ width: "74px" }} />
          <col style={{ width: "56px" }} />
          <col style={{ width: "80px" }} />
          <col style={{ width: "70px" }} />
          <col style={{ width: "auto" }} />
          <col style={{ width: "56px" }} />
        </colgroup>
        <thead>
          <tr>
            <th
              style={{
                padding: "10px 4px",
                borderBottom: `1px solid ${T.border}`,
                background: T.card,
                position: "sticky",
                top: 0,
                zIndex: 2,
                textAlign: "center",
              }}
            >
              <input
                type="checkbox"
                checked={
                  visible.length > 0 &&
                  visible.every((t) => selected.has(t.id))
                }
                onChange={toggleSelectAllVisible}
                style={{ accentColor: T.gold, cursor: "pointer" }}
                title="Select all visible"
              />
            </th>
            <HeaderCell col="date" label="Date" />
            <HeaderCell col="side" label="B/S" />
            <HeaderCell col="assetClass" label="Class" />
            <HeaderCell col="ticker" label="Ticker" />
            <HeaderCell col="qty" label="Qty" align="right" />
            <HeaderCell col="price" label="Price" align="right" />
            <HeaderCell col="fee" label="Fee" align="right" />
            <HeaderCell col="notes" label="Notes" />
            <th
              style={{
                padding: "10px 4px",
                borderBottom: `1px solid ${T.border}`,
                background: T.card,
                position: "sticky",
                top: 0,
                zIndex: 2,
              }}
            />
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td
                colSpan={10}
                style={{
                  padding: 32,
                  textAlign: "center",
                  color: T.textDim,
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                }}
              >
                {transactions.length === 0
                  ? "No transactions yet - tap New to add your first."
                  : "No matches for current filters."}
              </td>
            </tr>
          ) : (
            visible.map((tx) => {
              const isBuy = tx.side === "buy";
              const cur = tx.currency || currencyForAssetClass(tx.assetClass) || "USD";
              const feeStr = tx.fee ? fmtPrice(tx.fee, cur) : "—";
              const isEditing = editingId === tx.id;
              const isSelected = selected.has(tx.id);

              if (isEditing && draft) {
                // Inline edit row
                const cellStyle = {
                  padding: "4px 2px",
                  verticalAlign: "middle",
                };
                const inputStyle = {
                  width: "100%",
                  boxSizing: "border-box",
                  background: T.cardElev,
                  border: `1px solid ${T.gold}`,
                  color: T.text,
                  padding: "4px 4px",
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  outline: "none",
                };
                const onKey = (e) => {
                  if (e.key === "Enter") commitEdit();
                  else if (e.key === "Escape") cancelEdit();
                };
                return (
                  <tr
                    key={tx.id}
                    style={{
                      borderBottom: `1px solid ${T.gold}`,
                      background: "rgba(201, 169, 97, 0.04)",
                    }}
                  >
                    <td style={{ ...cellStyle, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(tx.id)}
                        style={{ accentColor: T.gold, cursor: "pointer" }}
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="date"
                        value={draft.date}
                        onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                        onKeyDown={onKey}
                        style={inputStyle}
                      />
                    </td>
                    <td style={cellStyle}>
                      <select
                        value={draft.side}
                        onChange={(e) => setDraft({ ...draft, side: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, cursor: "pointer" }}
                      >
                        <option value="buy">B</option>
                        <option value="sell">S</option>
                      </select>
                    </td>
                    <td style={cellStyle}>
                      <select
                        value={draft.assetClass}
                        onChange={(e) => setDraft({ ...draft, assetClass: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, cursor: "pointer" }}
                      >
                        {ASSET_CLASS_IDS.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="text"
                        value={draft.ticker}
                        onChange={(e) => setDraft({ ...draft, ticker: e.target.value.toUpperCase() })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, textTransform: "uppercase" }}
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={draft.qty}
                        onChange={(e) => setDraft({ ...draft, qty: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, textAlign: "right" }}
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={draft.price}
                        onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, textAlign: "right" }}
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={draft.fee}
                        onChange={(e) => setDraft({ ...draft, fee: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, textAlign: "right" }}
                        placeholder="0"
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="text"
                        value={draft.notes}
                        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                        onKeyDown={onKey}
                        style={inputStyle}
                        placeholder="notes"
                      />
                    </td>
                    <td style={{ padding: "4px 2px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        onClick={commitEdit}
                        disabled={busy}
                        title="Save (Enter)"
                        style={{
                          background: "transparent",
                          border: `1px solid ${T.green}`,
                          color: T.green,
                          padding: "3px 4px",
                          marginRight: 2,
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <Check size={10} />
                      </button>
                      <button
                        onClick={cancelEdit}
                        title="Cancel (Esc)"
                        style={{
                          background: "transparent",
                          border: `1px solid ${T.border}`,
                          color: T.textDim,
                          padding: "3px 4px",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <X size={10} />
                      </button>
                    </td>
                  </tr>
                );
              }

              return (
                <tr
                  key={tx.id}
                  style={{
                    borderBottom: `1px solid ${T.borderSoft}`,
                    background: isSelected ? "rgba(201, 169, 97, 0.06)" : "transparent",
                  }}
                  onDoubleClick={() => startEdit(tx)}
                  title={
                    tx.notes
                      ? `${tx.assetClass || "—"} · fee ${feeStr}\n${tx.notes}`
                      : `${tx.assetClass || "—"} · fee ${feeStr}`
                  }
                >
                  <td style={{ padding: "8px 4px", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(tx.id)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ accentColor: T.gold, cursor: "pointer" }}
                    />
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: T.text,
                      whiteSpace: "nowrap",
                      fontSize: 10,
                    }}
                  >
                    {tx.date}
                  </td>
                  <td style={{ padding: "8px 4px" }}>
                    <span
                      style={{
                        fontSize: 9,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        padding: "2px 5px",
                        background: isBuy
                          ? "rgba(125, 211, 164, 0.1)"
                          : "rgba(232, 140, 140, 0.1)",
                        color: isBuy ? T.green : T.red,
                        border: `1px solid ${isBuy ? T.green : T.red}`,
                      }}
                    >
                      {tx.side === "buy" ? "B" : "S"}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: T.textDim,
                      fontSize: 10,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tx.assetClass || "—"}
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: T.text,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {tickerStatus[(tx.ticker || "").toUpperCase()] === "error" && (
                        <span
                          title="Price source could not identify this ticker — check for typos or fix the symbol"
                          style={{ display: "inline-flex", flexShrink: 0 }}
                        >
                          <AlertCircle size={12} style={{ color: T.red }} />
                        </span>
                      )}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                        {tx.ticker}
                      </span>
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: T.text,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmtNum(tx.qty, 0)}
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: valuesHidden ? T.textFaint : T.text,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      fontSize: 10,
                    }}
                  >
                    {valuesHidden ? "••••" : fmtPrice(tx.price, cur)}
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: valuesHidden ? T.textFaint : tx.fee ? T.text : T.textFaint,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      fontSize: 10,
                    }}
                  >
                    {valuesHidden ? "••••" : tx.fee ? fmtPrice(tx.fee, cur) : "—"}
                  </td>
                  <td
                    style={{
                      padding: "8px 10px",
                      color: tx.notes ? T.textDim : T.textFaint,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 10,
                    }}
                  >
                    {tx.notes || "—"}
                  </td>
                  <td style={{ padding: "6px 2px", textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      onClick={() => startEdit(tx)}
                      disabled={busy}
                      title="Edit inline"
                      style={{
                        background: "transparent",
                        border: `1px solid ${T.border}`,
                        color: T.textDim,
                        padding: "3px 4px",
                        marginRight: 2,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <Pencil size={9} />
                    </button>
                    <button
                      onClick={() => onDelete(tx)}
                      disabled={busy}
                      title="Delete"
                      style={{
                        background: "transparent",
                        border: `1px solid ${T.border}`,
                        color: T.red,
                        padding: "3px 4px",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <Trash2 size={9} />
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
        {(() => {
          if (visible.length === 0) return null;
          let netQty = 0;
          for (const tx of visible) {
            const q = Number(tx.qty) || 0;
            netQty += tx.side === "sell" ? -q : q;
          }
          const netColor = netQty < 0 ? T.red : T.green;
          const netStr = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(netQty);
          return (
            <tfoot>
              <tr style={{ borderTop: `1px solid ${T.border}` }}>
                <td />
                <td />
                <td />
                <td />
                <td
                  style={{
                    padding: "6px 4px",
                    fontFamily: FONT_MONO,
                    fontSize: 9,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: T.textFaint,
                  }}
                >
                  NET QTY
                </td>
                <td
                  style={{
                    padding: "6px 4px",
                    textAlign: "right",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: netColor,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  {netStr}
                </td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          );
        })()}
      </table>

      {openCol && (() => {
        const filterableCols = ["date", "side", "ticker", "assetClass"];
        const isFilterable = filterableCols.includes(openCol);
        const isDateCol = openCol === "date";
        const close = () => {
          setOpenCol(null);
          setAnchor(null);
        };
        return (
          <HeaderPopover
            anchor={anchor}
            onClose={close}
            sortDir={sortDirFor(openCol)}
            onSort={(dir) => setSortFor(openCol, dir)}
            filterable={isFilterable}
            options={isFilterable && !isDateCol ? allValues[openCol] || [] : []}
            selected={isFilterable && !isDateCol ? filters[openCol] : new Set()}
            onChange={(next) => setColFilter(openCol, next)}
            optionLabel={
              openCol === "side"
                ? (v) => (v === "buy" ? "B (Buy)" : v === "sell" ? "S (Sell)" : v)
                : undefined
            }
            dateRange={
              isDateCol
                ? { from: filters.dateFrom, to: filters.dateTo }
                : null
            }
            setDateRange={
              isDateCol
                ? (r) =>
                    setFilters((cur) => ({
                      ...cur,
                      dateFrom: r.from,
                      dateTo: r.to,
                    }))
                : undefined
            }
          />
        );
      })()}
    </div>
    </div>
    </div>
  );
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

// CSV export
function transactionsToCSV(transactions) {
  const headers = ["date", "side", "ticker", "qty", "price", "assetClass", "fee", "notes"];
  const lines = [headers.join(",")];
  for (const t of transactions) {
    const row = headers.map((h) => {
      const v = t[h];
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    });
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

function downloadCSV(filename, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Split Modal -----------------------------------------------------------
// CUSIP pattern used to block non-stock tickers from splits.
const CUSIP_RX_SPLIT = /^[0-9]{3}[A-Z0-9]{6}[0-9]$/;

// Apply a split/grouping to a transaction list. Adjusts every transaction for
// the ticker dated strictly BEFORE the split date: qty x (num/den), price x
// (den/num), and records an audit trail (originalQty/originalPrice/splitDate).
// Transactions on or after the split date, or for other tickers, pass through.
export function applySplitToTransactions(transactions, { ticker, date, numerator, denominator }) {
  const num = Number(numerator), den = Number(denominator);
  const tkr = String(ticker).toUpperCase();
  return transactions.map((tx) => {
    if ((tx.ticker || "").toUpperCase() !== tkr || tx.date >= date) return tx;
    const origQty = tx.qty, origPrice = tx.price;
    return {
      ...tx,
      qty: parseFloat((origQty * (num / den)).toFixed(6)),
      price: parseFloat((origPrice * (den / num)).toFixed(6)),
      splitAdjusted: true,
      originalQty: origQty,
      originalPrice: origPrice,
      splitDate: date,
    };
  });
}

function SplitModal({ open, onClose, onApply, transactions, knownTickers, busy }) {
  const [form, setForm] = useState({ ticker: "", date: "", type: "split", numerator: "", denominator: "" });
  const [showTickerList, setShowTickerList] = useState(false);

  const todayStr = todayISO();

  function resetForm() {
    setForm({ ticker: "", date: "", type: "split", numerator: "", denominator: "" });
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  const tickerSuggestions = useMemo(() => {
    const q = (form.ticker || "").trim().toUpperCase();
    if (!q) return [];
    return (knownTickers || [])
      .filter((t) => t.toUpperCase().includes(q) && t.toUpperCase() !== q)
      .slice(0, 6);
  }, [form.ticker, knownTickers]);

  // Validation
  const num = parseFloat(form.numerator);
  const den = parseFloat(form.denominator);
  const ticker = (form.ticker || "").trim().toUpperCase();
  const date = (form.date || "").trim();

  const tickerErr = (() => {
    if (!ticker) return null;
    if (CUSIP_RX_SPLIT.test(ticker)) return "CUSIPs cannot be split-adjusted";
    if (/^tesouro-/i.test(ticker)) return "Tesouro tickers cannot be split-adjusted";
    return null;
  })();

  const dateErr = (() => {
    if (!date) return null;
    if (date > todayStr) return "Date cannot be in the future";
    return null;
  })();

  const factorErr = (() => {
    if (!form.numerator || !form.denominator) return null;
    if (!isFinite(num) || num <= 0) return "Numerator must be > 0";
    if (!isFinite(den) || den <= 0) return "Denominator must be > 0";
    if (num === den) return "Factor 1:1 has no effect";
    return null;
  })();

  const hasAllInputs = ticker && date && form.numerator && form.denominator;
  const isValid = hasAllInputs && !tickerErr && !dateErr && !factorErr;

  // Preview: affected transactions
  const affected = useMemo(() => {
    if (!isValid) return [];
    return transactions.filter(
      (tx) => (tx.ticker || "").toUpperCase() === ticker && tx.date < date
    );
  }, [transactions, ticker, date, isValid]);

  const hasNonIntegerQty = affected.some((tx) => {
    const newQty = tx.qty * (num / den);
    return Math.abs(newQty - Math.round(newQty)) > 0.0001;
  });

  function handleApply() {
    if (!isValid || affected.length === 0) return;
    const next = applySplitToTransactions(transactions, {
      ticker,
      date,
      numerator: num,
      denominator: den,
    });
    onApply(next);
    handleClose();
  }

  if (!open) return null;

  const inputStyle = {
    background: T.cardElev,
    border: `1px solid ${T.border}`,
    color: T.text,
    padding: "9px 11px",
    fontSize: 13,
    fontFamily: FONT_MONO,
    borderRadius: 2,
    width: "100%",
    boxSizing: "border-box",
    outline: "none",
  };
  const labelStyle = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.18em",
    color: T.textDim,
    textTransform: "uppercase",
    marginBottom: 6,
  };
  const errStyle = {
    fontFamily: FONT_MONO,
    fontSize: 11,
    color: T.red,
    marginTop: 4,
  };

  const tdH = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.10em",
    textTransform: "uppercase",
    fontWeight: 500,
    padding: "7px 10px",
    borderBottom: `1px solid ${T.border}`,
    color: T.textFaint,
    whiteSpace: "nowrap",
  };
  const tdB = {
    fontFamily: FONT_MONO,
    fontSize: 12,
    padding: "7px 10px",
    borderBottom: `1px solid ${T.borderSoft}`,
    color: T.text,
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        zIndex: 300,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "24px 16px",
        overflowY: "auto",
      }}
      onClick={handleClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.cardElev,
          border: `1px solid ${T.border}`,
          padding: 20,
          maxWidth: 500,
          width: "100%",
          borderRadius: 4,
        }}
      >
        {/* Modal header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.2em",
            color: T.gold,
            textTransform: "uppercase",
          }}>
            Split / Reverse Split
          </div>
          <button
            onClick={handleClose}
            style={{ background: "transparent", border: "none", color: T.textDim, cursor: "pointer", padding: 4 }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Inputs */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          {/* Ticker */}
          <div style={{ gridColumn: "1 / -1", position: "relative" }}>
            <div style={labelStyle}>Ticker</div>
            <input
              type="text"
              value={form.ticker}
              onChange={(e) => setForm((f) => ({ ...f, ticker: e.target.value.toUpperCase() }))}
              onFocus={() => setShowTickerList(true)}
              onBlur={() => setTimeout(() => setShowTickerList(false), 150)}
              placeholder="AAPL"
              style={{ ...inputStyle, textTransform: "uppercase" }}
            />
            {tickerErr && <div style={errStyle}>{tickerErr}</div>}
            {showTickerList && tickerSuggestions.length > 0 && (
              <div style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                background: T.cardElev,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                zIndex: 10,
                maxHeight: 160,
                overflowY: "auto",
              }}>
                {tickerSuggestions.map((t) => (
                  <button
                    key={t}
                    onMouseDown={() => setForm((f) => ({ ...f, ticker: t }))}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: T.gold,
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      padding: "9px 12px",
                      cursor: "pointer",
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Date */}
          <div>
            <div style={labelStyle}>Split Date</div>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              style={inputStyle}
            />
            {dateErr && <div style={errStyle}>{dateErr}</div>}
          </div>

          {/* Type */}
          <div>
            <div style={labelStyle}>Type</div>
            <div style={{ display: "flex", gap: 6 }}>
              {["split", "reverse"].map((t) => {
                const active = form.type === t;
                return (
                  <button
                    key={t}
                    onClick={() => setForm((f) => ({ ...f, type: t }))}
                    style={{
                      flex: 1,
                      background: active ? "rgba(201,169,97,0.12)" : "transparent",
                      border: `1px solid ${active ? T.gold : T.border}`,
                      color: active ? T.gold : T.textDim,
                      padding: "9px 6px",
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      letterSpacing: "0.10em",
                      textTransform: "uppercase",
                      cursor: "pointer",
                    }}
                  >
                    {t === "split" ? "Split" : "Reverse"}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Factor */}
          <div style={{ gridColumn: "1 / -1" }}>
            <div style={labelStyle}>Factor — New : Old</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                value={form.numerator}
                onChange={(e) => setForm((f) => ({ ...f, numerator: e.target.value }))}
                placeholder="10"
                min="0.000001"
                step="any"
                style={{ ...inputStyle, width: "100%" }}
              />
              <span style={{ fontFamily: FONT_MONO, fontSize: 16, color: T.textDim, flexShrink: 0 }}>:</span>
              <input
                type="number"
                value={form.denominator}
                onChange={(e) => setForm((f) => ({ ...f, denominator: e.target.value }))}
                placeholder="1"
                min="0.000001"
                step="any"
                style={{ ...inputStyle, width: "100%" }}
              />
            </div>
            {factorErr && <div style={errStyle}>{factorErr}</div>}
            {isFinite(num) && isFinite(den) && den > 0 && !factorErr && (
              <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, marginTop: 4 }}>
                Each share becomes {(num / den).toFixed(4).replace(/\.?0+$/, "")} shares. Price divided by same factor.
              </div>
            )}
          </div>
        </div>

        {/* Preview */}
        {isValid && (
          <div style={{
            background: T.card,
            border: `1px solid ${T.borderSoft}`,
            borderRadius: 4,
            marginBottom: 16,
            overflow: "hidden",
          }}>
            <div style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: T.textDim,
              padding: "10px 12px",
              borderBottom: `1px solid ${T.borderSoft}`,
            }}>
              Preview
            </div>

            {affected.length === 0 ? (
              <div style={{ padding: "12px", fontFamily: FONT_MONO, fontSize: 12, color: T.textDim }}>
                No transactions found for {ticker} before {date}.
              </div>
            ) : (
              <>
                {hasNonIntegerQty && (
                  <div style={{
                    padding: "8px 12px",
                    background: "rgba(232,140,140,0.08)",
                    borderBottom: `1px solid ${T.borderSoft}`,
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.red,
                  }}>
                    Warning: some resulting quantities are fractional (e.g. 0.5 shares in reverse split).
                  </div>
                )}
                <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                  <table style={{ width: "100%", minWidth: 460, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ ...tdH, textAlign: "left" }}>Date</th>
                        <th style={{ ...tdH, textAlign: "left" }}>Side</th>
                        <th style={{ ...tdH, textAlign: "right" }}>Qty</th>
                        <th style={{ ...tdH, textAlign: "center", color: T.textFaint, fontSize: 12, padding: "7px 4px" }}>{"->"}</th>
                        <th style={{ ...tdH, textAlign: "right" }}>New Qty</th>
                        <th style={{ ...tdH, textAlign: "right" }}>Price</th>
                        <th style={{ ...tdH, textAlign: "center", color: T.textFaint, fontSize: 12, padding: "7px 4px" }}>{"->"}</th>
                        <th style={{ ...tdH, textAlign: "right" }}>New Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {affected.map((tx) => {
                        const newQty = parseFloat((tx.qty * (num / den)).toFixed(6));
                        const newPrice = parseFloat((tx.price * (den / num)).toFixed(6));
                        const isNonInt = Math.abs(newQty - Math.round(newQty)) > 0.0001;
                        return (
                          <tr key={tx.id}>
                            <td style={{ ...tdB, textAlign: "left" }}>{tx.date}</td>
                            <td style={{ ...tdB, textAlign: "left", color: tx.side === "buy" ? T.green : T.red }}>{tx.side[0].toUpperCase()}</td>
                            <td style={{ ...tdB, textAlign: "right" }}>{tx.qty}</td>
                            <td style={{ ...tdB, textAlign: "center", color: T.textFaint }}>{">"}</td>
                            <td style={{ ...tdB, textAlign: "right", color: isNonInt ? T.red : T.gold }}>{newQty}</td>
                            <td style={{ ...tdB, textAlign: "right" }}>{"$"}{tx.price}</td>
                            <td style={{ ...tdB, textAlign: "center", color: T.textFaint }}>{">"}</td>
                            <td style={{ ...tdB, textAlign: "right", color: T.gold }}>{"$"}{newPrice}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: "8px 12px", fontFamily: FONT_MONO, fontSize: 11, color: T.textDim, borderTop: `1px solid ${T.borderSoft}` }}>
                  {affected.length} transaction{affected.length === 1 ? "" : "s"} will be adjusted
                </div>
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={handleApply}
            disabled={!isValid || affected.length === 0 || busy}
            style={{
              background: isValid && affected.length > 0 && !busy ? T.red : T.borderSoft,
              border: "none",
              color: isValid && affected.length > 0 && !busy ? "#0b0d10" : T.textFaint,
              padding: "10px 16px",
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              cursor: isValid && affected.length > 0 && !busy ? "pointer" : "not-allowed",
              opacity: isValid && affected.length > 0 && !busy ? 1 : 0.5,
            }}
          >
            Apply Split
          </button>
          <button
            onClick={handleClose}
            style={{
              background: "transparent",
              border: `1px solid ${T.border}`,
              color: T.textDim,
              padding: "10px 16px",
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Import Modal ----------------------------------------------------------

const SAMPLE_CSV = `date,side,ticker,qty,price,assetClass,fee,notes
2024-03-15,buy,AAPL,10,175.50,Stocks,0,
2024-03-20,buy,BBSE3,100,38.20,BRA Stocks,,monthly buy`;

// Fidelity "Accounts History" CSV parser.
// - Skips blank lines / BOM at start
// - Header row contains: Run Date, Action, Symbol, Price ($), Quantity, Fees ($)
// - Keeps only rows where Action startsWith "YOU BOUGHT" or "YOU SOLD"
// - SOLD has negative Quantity → take abs
// - Date format MM/DD/YYYY → ISO
// - All Fidelity transactions are USD; assetClass defaults to "Stocks"
//   (user can edit later)
function parseFidelityCSV(text, knownClassByTicker = null) {
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
  const idxDesc = colOf("Symbol Description");
  const idxPrice = colOf("Price ($)");
  const idxQty = colOf("Quantity");
  const idxFees = colOf("Fees ($)");
  const idxAmount = colOf("Amount ($)");

  if (idxDate < 0 || idxAction < 0 || idxSymbol < 0 || idxPrice < 0 || idxQty < 0) {
    return { results: [], hadHeader: true, rawRows: [], sourceText: text, error: "Required Fidelity columns missing" };
  }

  // Parse a Fidelity MM/DD/YYYY (or MM/DD/YY) date string to ISO, or null.
  const toISO = (rawDate) => {
    const mdy = String(rawDate || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
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
  for (let i = headerIdx + 1; i < result.data.length; i++) {
    const arr = result.data[i];
    if (!arr || arr.length === 0) continue;
    const action = String(arr[idxAction] || "").trim();
    const upper = action.toUpperCase();

    // Interest/coupon payment rows: capture as real income events, not txns.
    // Fidelity labels these "INTEREST" / "INTEREST EARNED" with the amount in
    // the Amount ($) column. Only keep CUSIP-symboled (bond/CD) payments.
    if (upper.includes("INTEREST") && idxAmount >= 0) {
      const isoDateI = toISO(arr[idxDate]);
      const symbolI = String(arr[idxSymbol] || "").trim().toUpperCase();
      const amountI = parseFloat(String(arr[idxAmount] || "").replace(/[$,\s]/g, ""));
      if (isoDateI && symbolI && CUSIP_RX.test(symbolI) && isFinite(amountI) && amountI > 0) {
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

    // Stock dividend payment rows: capture for non-CUSIP tickers (e.g. VALE, AAPL).
    // Fidelity labels these "DIVIDEND RECEIVED", "CASH DIV", "ORDINARY DIVIDEND", etc.
    // Amount ($) is the total cash received (not per-share). Skip REINVESTMENT rows.
    if ((upper.includes("DIVIDEND") || upper === "CASH DIV") &&
        !upper.includes("REINVEST") && idxAmount >= 0) {
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

    let side = null;
    let isRedemption = false;
    if (upper.startsWith("YOU BOUGHT")) side = "buy";
    else if (upper.startsWith("YOU SOLD")) side = "sell";
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

    const symbol = String(arr[idxSymbol] || "").trim().toUpperCase();
    if (!symbol) continue;
    // Redemptions only make sense for CUSIP-symboled bonds/CDs.
    if (isRedemption && !CUSIP_RX.test(symbol)) continue;

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
    // symbol, falling back to "Stocks" for plain US tickers.
    const known = knownClassByTicker && knownClassByTicker.get(symbol);
    const assetClass = known || inferAssetClass(symbol) || "Stocks";

    // Item 40: Fidelity reports CD/bond Quantity as face value in dollars
    // (e.g. 1000 = one $1,000 CD) and Price ($) as percent-of-face for
    // buys/sells (100.00 → ×10 = $1,000/unit), but as decimal-fraction for
    // redemptions (1.00 → ×1000 = $1,000/unit). Plain tickers untouched.
    const qty = assetClass === "Bank Bonds" ? qtyAbs / 1000 : qtyAbs;
    const price = assetClass === "Bank Bonds"
      ? (isRedemption ? priceN * 1000 : priceN * 10)
      : priceN;

    // Extract bond metadata from the Symbol Description field.
    let notes = "";
    let couponRate = null;    // numeric %, e.g. 5.45
    let maturityDate = null;  // ISO date string, e.g. "2027-03-15"
    let bondType = null;      // "Treasury" | "Agency" | "CD" | "Corporate"
    let shortName = null;     // issuer name extracted from description
    let couponFreq = null;    // "monthly" | "quarterly" | "semi-annual" | "at-maturity"
    if (idxDesc >= 0 && assetClass === "Bank Bonds") {
      const desc = String(arr[idxDesc] || "");
      const couponM = desc.match(/(\d+(?:\.\d+)?)%/);
      const maturityM = desc.match(/(\d{2})\/(\d{2})\/(\d{4})$/);
      if (couponM) {
        couponRate = parseFloat(couponM[1]);
      }
      if (maturityM) {
        const [, mm, dd, yyyy] = maturityM;
        maturityDate = `${yyyy}-${mm}-${dd}`;
      }
      // Short name: everything before the coupon rate pattern, trimmed.
      const nameEnd = desc.search(/\d+(?:\.\d+)?%/);
      if (nameEnd > 0) {
        shortName = desc.slice(0, nameEnd).trim().replace(/\s+/g, " ") || null;
      }
      // Bond type inferred by issuer keywords (display/metadata only).
      const u = desc.toUpperCase();
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
      // Default coupon frequency is monthly; refined later when real interest
      // payments are detected on Account History import.
      couponFreq = "monthly";
      if (couponRate !== null && maturityDate) {
        notes = `${couponRate.toFixed(2)}% | ${maturityM[1]}/${maturityM[2]}/${maturityM[3]}`;
      }
    }

    const tx = {
      id: newId(),
      date: isoDate,
      side,
      ticker: symbol,
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
      ok: true,
      errors: [],
      ambiguous: false,
      needsAssetClass: false,
      classFromHistory: !!known,
      rawNumbers: { qty: qtyRaw, price: priceN, fee },
      tx,
    });
    rawRows.push(arr);
  }

  return { results, incomeEvents, hadHeader: true, rawRows, sourceText: text };
}

function ImportModal({ open, onClose, onConfirm, existingCount, existingTransactions = [] }) {
  const [tab, setTab] = useState("fidelity"); // upload | fidelity
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null); // { results, hadHeader, dateFormat }
  const [decimalPrompt, setDecimalPrompt] = useState(false); // ambiguous comma found
  const [structuralPrompt, setStructuralPrompt] = useState(false); // BR-decimal-in-CSV suspected
  const [mode, setMode] = useState("append"); // append | replace
  const [fileError, setFileError] = useState("");
  const [checkedRows, setCheckedRows] = useState(new Set());
  const [editingIdx, setEditingIdx] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const fileInputRef = useRef(null);

  // Ticker → asset class from saved transactions (last occurrence wins). Used to
  // reuse a known class instead of inferring one for the same ticker.
  const knownClassByTicker = useMemo(() => {
    const m = new Map();
    for (const t of existingTransactions || []) {
      const tk = String(t.ticker || "").trim().toUpperCase();
      if (tk && t.assetClass) m.set(tk, t.assetClass);
    }
    return m;
  }, [existingTransactions]);

  // Set of dup keys for saved transactions, to flag re-imports of the same row.
  const dupKeySet = useMemo(() => {
    const s = new Set();
    for (const t of existingTransactions || []) s.add(dupKey(t));
    return s;
  }, [existingTransactions]);

  // Flag rows that match an already-saved transaction (same ticker/side/qty/date).
  function annotateDuplicates(results) {
    if (dupKeySet.size === 0) return results;
    return results.map((r) =>
      r.tx && dupKeySet.has(dupKey(r.tx)) ? { ...r, duplicate: true } : r
    );
  }

  // Default check state: all rows except detected duplicates.
  function initAllChecked(results) {
    const s = new Set();
    results.forEach((r, i) => {
      if (!r.duplicate) s.add(i);
    });
    setCheckedRows(s);
  }

  useEffect(() => {
    if (!open) {
      setText("");
      setParsed(null);
      setDecimalPrompt(false);
      setStructuralPrompt(false);
      setMode("append");
      setFileError("");
      setTab("fidelity");
      setCheckedRows(new Set());
      setEditingIdx(null);
      setEditDraft(null);
    }
  }, [open]);

  function doParse(rawText) {
    const out = parseCSVOrPaste(rawText);
    if (out.rows.length === 0) {
      setFileError("No rows detected");
      setParsed(null);
      return;
    }
    const fmt = detectDateFormat(out.rows.map((r) => r.date));
    const opts = { dateFormat: fmt };
    // If columns mismatch AND delimiter is comma, suspected BR decimal in CSV.
    if (out.structuralBreak && out.delimiter === ",") {
      const results = annotateDuplicates(out.rows.map((r) => parseRow(r, "USD", knownClassByTicker, opts)));
      setParsed({ results, hadHeader: out.hadHeader, rawRows: out.rows, sourceText: rawText, dateFormat: fmt });
      initAllChecked(results);
      setEditingIdx(null);
      setEditDraft(null);
      setStructuralPrompt(true);
      setDecimalPrompt(false);
      setFileError("");
      return;
    }
    const results = annotateDuplicates(out.rows.map((r) => parseRow(r, "USD", knownClassByTicker, opts)));
    const ambiguousCount = results.filter((r) => r.ambiguous).length;
    setParsed({ results, hadHeader: out.hadHeader, rawRows: out.rows, sourceText: rawText, dateFormat: fmt });
    initAllChecked(results);
    setEditingIdx(null);
    setEditDraft(null);
    setDecimalPrompt(ambiguousCount > 0);
    setStructuralPrompt(false);
    setFileError("");
  }

  function applyBRReparse(yes) {
    if (!parsed) return;
    setStructuralPrompt(false);
    if (!yes) return;
    const out = parseCSVOrPaste(parsed.sourceText, { autoFixBR: true });
    if (out.rows.length === 0) {
      setFileError("Reparse produced no rows");
      setParsed(null);
      return;
    }
    const fmt = parsed.dateFormat || "dmy";
    const opts = { dateFormat: fmt };
    const results = annotateDuplicates(out.rows.map((r) => parseRow(r, "USD", knownClassByTicker, opts)));
    const ambiguousCount = results.filter((r) => r.ambiguous).length;
    setParsed({
      results,
      hadHeader: out.hadHeader,
      rawRows: out.rows,
      sourceText: parsed.sourceText,
      dateFormat: fmt,
      reparseNote:
        out.unfixableRows > 0
          ? `${out.fixedRows} row(s) fixed, ${out.unfixableRows} could not be auto-fixed.`
          : null,
    });
    initAllChecked(results);
    setEditingIdx(null);
    setEditDraft(null);
    setDecimalPrompt(ambiguousCount > 0);
  }

  function applyCommaDecimal(useComma) {
    if (!parsed) return;
    if (useComma) {
      const opts = { dateFormat: parsed.dateFormat || "dmy" };
      const next = annotateDuplicates(
        reparseWithCommaDecimal(parsed.rawRows, "USD", knownClassByTicker, opts)
      );
      setParsed({ ...parsed, results: next });
    }
    setDecimalPrompt(false);
  }

  function pickAssetClass(idx, cls) {
    if (!parsed) return;
    const cur = currencyForAssetClass(cls);
    const next = parsed.results.map((r, i) => {
      if (i !== idx) return r;
      if (!r.tx) return r;
      return {
        ...r,
        ok: true,
        needsAssetClass: false,
        errors: [],
        tx: { ...r.tx, assetClass: cls, currency: cur },
      };
    });
    setParsed({ ...parsed, results: next });
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = String(ev.target?.result || "");
      setText(content);
      doParse(content);
    };
    reader.onerror = () => setFileError("Failed to read file");
    reader.readAsText(file);
  }

  function handleFidelityFile(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const fileContents = [];
    let loaded = 0;
    let readError = false;

    function onAllLoaded() {
      let mergedResults = [];
      let mergedIncome = [];
      let mergedRawRows = [];
      const crossFileKeys = new Set();

      for (const content of fileContents) {
        const out = parseFidelityCSV(content, knownClassByTicker);
        if (out.error && mergedResults.length === 0 && mergedIncome.length === 0) {
          setFileError(out.error);
          setParsed(null);
          return;
        }
        const fileResults = out.results || [];
        const deduped = fileResults.map((r) => {
          if (!r.tx) return r;
          const k = dupKey(r.tx);
          if (crossFileKeys.has(k)) return { ...r, duplicate: true };
          crossFileKeys.add(k);
          return r;
        });
        mergedResults = mergedResults.concat(deduped);
        mergedIncome = mergedIncome.concat(out.incomeEvents || []);
        mergedRawRows = mergedRawRows.concat(out.rawRows || []);
      }

      if (mergedResults.length === 0 && mergedIncome.length === 0) {
        setFileError("No BUY/SELL or interest rows found in this Fidelity file");
        setParsed(null);
        return;
      }

      mergedResults.sort((a, b) => {
        const da = a.tx?.date || "";
        const db = b.tx?.date || "";
        return da < db ? -1 : da > db ? 1 : 0;
      });

      const annotated = annotateDuplicates(mergedResults);
      setParsed({
        results: annotated,
        incomeEvents: mergedIncome,
        hadHeader: true,
        rawRows: mergedRawRows,
        sourceText: "",
        sourceLabel: "Fidelity",
      });
      initAllChecked(annotated);
      setEditingIdx(null);
      setEditDraft(null);
      setDecimalPrompt(false);
      setStructuralPrompt(false);
      setFileError("");
    }

    files.forEach((file, idx) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (readError) return;
        let content = String(ev.target?.result || "");
        if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
        fileContents[idx] = content;
        loaded += 1;
        if (loaded === files.length) onAllLoaded();
      };
      reader.onerror = () => {
        if (!readError) {
          readError = true;
          setFileError("Failed to read file");
        }
      };
      reader.readAsText(file);
    });
  }

  function handleConfirm() {
    if (!parsed) return;
    const validTx = parsed.results
      .filter((r, i) => r.ok && checkedRows.has(i))
      .map((r) => r.tx);
    const income = parsed.incomeEvents || [];
    if (validTx.length === 0 && income.length === 0) return;
    onConfirm(validTx, mode, income);
  }

  function startPreviewEdit(idx) {
    const r = parsed?.results[idx];
    setEditingIdx(idx);
    setEditDraft({
      date: r?.tx?.date || todayISO(),
      side: r?.tx?.side || "buy",
      ticker: r?.tx?.ticker || "",
      assetClass: r?.tx?.assetClass || "",
      qty: r?.tx ? String(r.tx.qty) : "",
      price: r?.tx ? String(r.tx.price) : "",
      fee: r?.tx?.fee ? String(r.tx.fee) : "",
      notes: r?.tx?.notes || "",
    });
  }

  function cancelPreviewEdit() {
    setEditingIdx(null);
    setEditDraft(null);
  }

  function commitPreviewEdit() {
    if (editDraft === null || editingIdx === null || !parsed) return;
    const qn = parseFloat(editDraft.qty);
    const pn = parseFloat(editDraft.price);
    const feeN = editDraft.fee ? parseFloat(editDraft.fee) : 0;
    if (!editDraft.date) return;
    if (!isFinite(qn) || qn <= 0) return;
    if (!isFinite(pn) || pn < 0) return;
    if (editDraft.fee && (!isFinite(feeN) || feeN < 0)) return;
    if (!editDraft.assetClass) return;
    const tkr = editDraft.ticker.trim().toUpperCase();
    if (!tkr) return;
    const existing = parsed.results[editingIdx];
    const cur = currencyForAssetClass(editDraft.assetClass) || "USD";
    const editedTx = {
      id: existing?.tx?.id || newId(),
      date: editDraft.date,
      side: editDraft.side,
      ticker: tkr,
      assetClass: editDraft.assetClass,
      qty: qn,
      price: pn,
      currency: cur,
      fee: feeN,
      notes: editDraft.notes.trim(),
      createdAt: existing?.tx?.createdAt || new Date().toISOString(),
    };
    const updatedResult = {
      ok: true,
      needsAssetClass: false,
      errors: [],
      ambiguous: false,
      duplicate: dupKeySet.has(dupKey(editedTx)),
      rawNumbers: existing?.rawNumbers,
      tx: editedTx,
    };
    const newResults = parsed.results.map((r, i) => (i === editingIdx ? updatedResult : r));
    setParsed({ ...parsed, results: newResults });
    setEditingIdx(null);
    setEditDraft(null);
  }

  if (!open) return null;

  const validCount = parsed ? parsed.results.filter((r) => r.ok).length : 0;
  const checkedValidCount = parsed
    ? parsed.results.filter((r, i) => r.ok && checkedRows.has(i)).length
    : 0;
  const incomeCount = parsed?.incomeEvents?.length || 0;
  const totalCount = parsed ? parsed.results.length : 0;
  const errorCount = parsed
    ? parsed.results.filter((r) => !r.ok && !r.needsAssetClass).length
    : 0;
  const needsAssetClassCount = parsed
    ? parsed.results.filter((r) => r.needsAssetClass).length
    : 0;
  const duplicateCount = parsed
    ? parsed.results.filter((r) => r.duplicate).length
    : 0;
  const reusedClassCount = parsed
    ? parsed.results.filter((r) => r.classFromHistory).length
    : 0;
  const allChecked = parsed ? parsed.results.every((_, i) => checkedRows.has(i)) : false;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        zIndex: 100,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 20,
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.cardElev,
          border: `1px solid ${T.border}`,
          maxWidth: 720,
          width: "100%",
          marginTop: 20,
          marginBottom: 40,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.2em",
              color: T.gold,
              textTransform: "uppercase",
            }}
          >
            Import Transactions
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: T.textDim,
              cursor: "pointer",
              padding: 4,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Structural break prompt (BR decimal in comma-CSV) */}
        {structuralPrompt && (
          <div
            style={{
              padding: 16,
              background: "rgba(232, 140, 140, 0.08)",
              borderBottom: `1px solid ${T.border}`,
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                color: T.red,
                marginBottom: 8,
                lineHeight: 1.5,
              }}
            >
              Column mismatch detected. Likely cause: commas used as decimal
              separator in a comma-delimited file (e.g. "175,50"). Replace
              inline commas with dots and reparse?
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => applyBRReparse(true)}
                style={{
                  background: T.gold,
                  border: "none",
                  color: "#0b0d10",
                  padding: "8px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Yes, reparse
              </button>
              <button
                onClick={() => applyBRReparse(false)}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.border}`,
                  color: T.textDim,
                  padding: "8px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                No, keep
              </button>
            </div>
          </div>
        )}

        {/* Decimal handling prompt */}
        {decimalPrompt && (
          <div
            style={{
              padding: 16,
              background: "rgba(201, 169, 97, 0.08)",
              borderBottom: `1px solid ${T.border}`,
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                color: T.gold,
                marginBottom: 8,
                lineHeight: 1.5,
              }}
            >
              Detected commas in numeric fields. Convert ',' to '.' as decimal
              separator?
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => applyCommaDecimal(true)}
                style={{
                  background: T.gold,
                  border: "none",
                  color: "#0b0d10",
                  padding: "8px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Yes, convert
              </button>
              <button
                onClick={() => applyCommaDecimal(false)}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.border}`,
                  color: T.textDim,
                  padding: "8px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                No, keep
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        <div style={{ padding: 20 }}>
          {!parsed && (
            <>
              {/* Tabs */}
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  borderBottom: `1px solid ${T.border}`,
                  marginBottom: 16,
                }}
              >
                {[
                  { id: "upload", label: "Upload CSV" },
                  { id: "fidelity", label: "Fidelity" },
                ].map((t) => {
                  const active = tab === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: "8px 0",
                        cursor: "pointer",
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        letterSpacing: "0.18em",
                        textTransform: "uppercase",
                        color: active ? T.gold : T.textDim,
                        borderBottom: active
                          ? `1px solid ${T.gold}`
                          : "1px solid transparent",
                        marginBottom: -1,
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>

              {tab === "upload" && (
                <div>
                  <Label>Select a CSV file</Label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    onChange={handleFile}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: 12,
                      background: T.card,
                      border: `1px dashed ${T.border}`,
                      color: T.text,
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                    }}
                  />
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      color: T.textFaint,
                      marginTop: 10,
                      lineHeight: 1.7,
                    }}
                  >
                    <div style={{ color: T.textDim, marginBottom: 4 }}>
                      Required columns:
                    </div>
                    <div style={{ color: T.text }}>
                      date, side, ticker, qty, price
                    </div>
                    <div style={{ color: T.textDim, marginTop: 8, marginBottom: 4 }}>
                      Optional columns:
                    </div>
                    <div style={{ color: T.text }}>
                      assetClass, fee, notes
                    </div>
                    <div style={{ color: T.textFaint, marginTop: 10 }}>
                      Header row recommended. PT aliases accepted (data, tipo,
                      ativo, qtd, preco, classe, taxa, obs). Sides accepted:
                      buy/sell or compra/venda.
                    </div>
                  </div>
                  {fileError && (
                    <div
                      style={{
                        marginTop: 12,
                        color: T.red,
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                      }}
                    >
                      {fileError}
                    </div>
                  )}
                </div>
              )}

              {tab === "fidelity" && (
                <div>
                  <Label>Select one or more Fidelity "Accounts History" CSVs</Label>
                  <input
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    multiple
                    onChange={handleFidelityFile}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: 12,
                      background: T.card,
                      border: `1px dashed ${T.border}`,
                      color: T.text,
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                    }}
                  />
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      color: T.textFaint,
                      marginTop: 8,
                      lineHeight: 1.6,
                    }}
                  >
                    Imports YOU BOUGHT / YOU SOLD rows as transactions, bond
                    INTEREST payments as income, and bond REDEMPTIONS
                    (maturity) as sells. Dividends and contributions are
                    skipped. CUSIP symbols are classified as Bank Bonds with
                    coupon and maturity extracted from the description. All
                    other transactions default to "Stocks".
                  </div>
                  {fileError && (
                    <div
                      style={{
                        marginTop: 12,
                        color: T.red,
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                      }}
                    >
                      {fileError}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {parsed && (
            <>
              {/* Summary */}
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  marginBottom: 14,
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.green,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                >
                  {validCount} valid
                </div>
                {errorCount > 0 && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.red,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    {errorCount} with errors
                  </div>
                )}
                {needsAssetClassCount > 0 && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.gold,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    {needsAssetClassCount} need class
                  </div>
                )}
                {duplicateCount > 0 && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.red,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    {duplicateCount} duplicate
                  </div>
                )}
                {reusedClassCount > 0 && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.textDim,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    {reusedClassCount} class reused
                  </div>
                )}
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.textDim,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                >
                  {parsed.hadHeader ? "header detected" : "no header"}
                </div>
                {parsed.dateFormat === "dmy" && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.gold,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    dates: DD/MM/YYYY detected
                  </div>
                )}
              </div>

              {parsed.reparseNote && (
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.gold,
                    marginBottom: 14,
                    padding: 10,
                    border: `1px solid ${T.gold}`,
                    background: "rgba(201, 169, 97, 0.05)",
                  }}
                >
                  {parsed.reparseNote}
                </div>
              )}

              {parsed.incomeEvents && parsed.incomeEvents.length > 0 && (() => {
                const bondCount = parsed.incomeEvents.filter(e => e.kind !== "dividend").length;
                const divCount  = parsed.incomeEvents.filter(e => e.kind === "dividend").length;
                const parts = [];
                if (bondCount > 0) parts.push(`${bondCount} bond interest payment${bondCount === 1 ? "" : "s"}`);
                if (divCount  > 0) parts.push(`${divCount} stock dividend payment${divCount  === 1 ? "" : "s"}`);
                return (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.green,
                      marginBottom: 14,
                      padding: 10,
                      border: `1px solid ${T.green}`,
                      background: "rgba(125, 211, 164, 0.05)",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {parts.join(" + ")} detected — added to income on import.
                  </div>
                );
              })()}

              {/* Preview table */}
              <div
                style={{
                  maxHeight: 320,
                  overflowY: "auto",
                  border: `1px solid ${T.border}`,
                  marginBottom: 14,
                }}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                  }}
                >
                  <thead>
                    <tr style={{ background: T.card }}>
                      <th
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${T.border}`,
                          position: "sticky",
                          top: 0,
                          background: T.card,
                          textAlign: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={() => {
                            if (allChecked) {
                              setCheckedRows(new Set());
                            } else {
                              setCheckedRows(new Set(parsed.results.map((_, i) => i)));
                            }
                          }}
                          style={{ accentColor: T.gold, cursor: "pointer" }}
                        />
                      </th>
                      {["#", "date", "side", "ticker", "qty", "price", "class", ""].map((h) => (
                        <th
                          key={h}
                          style={{
                            textAlign: "left",
                            padding: "8px 10px",
                            color: T.textDim,
                            fontWeight: 400,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            fontSize: 10,
                            borderBottom: `1px solid ${T.border}`,
                            position: "sticky",
                            top: 0,
                            background: T.card,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.results.map((r, idx) => {
                      const isChecked = checkedRows.has(idx);
                      const isEditingThis = editingIdx === idx;

                      if (isEditingThis && editDraft) {
                        const cellS = { padding: "4px 3px", verticalAlign: "middle" };
                        const inS = {
                          width: "100%",
                          boxSizing: "border-box",
                          background: T.cardElev,
                          border: `1px solid ${T.gold}`,
                          color: T.text,
                          padding: "3px 4px",
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          outline: "none",
                        };
                        const onKey = (e) => {
                          if (e.key === "Enter") commitPreviewEdit();
                          else if (e.key === "Escape") cancelPreviewEdit();
                        };
                        return (
                          <tr
                            key={idx}
                            style={{
                              borderBottom: `1px solid ${T.gold}`,
                              background: "rgba(201, 169, 97, 0.04)",
                            }}
                          >
                            <td style={{ ...cellS, textAlign: "center" }}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() =>
                                  setCheckedRows((cur) => {
                                    const next = new Set(cur);
                                    if (next.has(idx)) next.delete(idx);
                                    else next.add(idx);
                                    return next;
                                  })
                                }
                                onClick={(e) => e.stopPropagation()}
                                style={{ accentColor: T.gold, cursor: "pointer" }}
                              />
                            </td>
                            <td style={{ ...cellS, color: T.textFaint, fontSize: 10 }}>{idx + 1}</td>
                            <td style={cellS}>
                              <input
                                type="date"
                                value={editDraft.date}
                                onChange={(e) => setEditDraft({ ...editDraft, date: e.target.value })}
                                onKeyDown={onKey}
                                style={inS}
                              />
                            </td>
                            <td style={cellS}>
                              <select
                                value={editDraft.side}
                                onChange={(e) => setEditDraft({ ...editDraft, side: e.target.value })}
                                onKeyDown={onKey}
                                style={{ ...inS, cursor: "pointer" }}
                              >
                                <option value="buy">buy</option>
                                <option value="sell">sell</option>
                              </select>
                            </td>
                            <td style={cellS}>
                              <input
                                type="text"
                                value={editDraft.ticker}
                                onChange={(e) => setEditDraft({ ...editDraft, ticker: e.target.value.toUpperCase() })}
                                onKeyDown={onKey}
                                style={{ ...inS, textTransform: "uppercase" }}
                              />
                            </td>
                            <td style={cellS}>
                              <input
                                type="number"
                                step="any"
                                inputMode="decimal"
                                value={editDraft.qty}
                                onChange={(e) => setEditDraft({ ...editDraft, qty: e.target.value })}
                                onKeyDown={onKey}
                                style={{ ...inS, textAlign: "right" }}
                              />
                            </td>
                            <td style={cellS}>
                              <input
                                type="number"
                                step="any"
                                inputMode="decimal"
                                value={editDraft.price}
                                onChange={(e) => setEditDraft({ ...editDraft, price: e.target.value })}
                                onKeyDown={onKey}
                                style={{ ...inS, textAlign: "right" }}
                              />
                            </td>
                            <td style={cellS}>
                              <select
                                value={editDraft.assetClass}
                                onChange={(e) => setEditDraft({ ...editDraft, assetClass: e.target.value })}
                                onKeyDown={onKey}
                                style={{ ...inS, cursor: "pointer" }}
                              >
                                <option value="">— pick —</option>
                                {ASSET_CLASS_IDS.map((id) => (
                                  <option key={id} value={id}>{id}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: "4px 3px", textAlign: "right", whiteSpace: "nowrap" }}>
                              <button
                                onClick={commitPreviewEdit}
                                title="Save (Enter)"
                                style={{
                                  background: "transparent",
                                  border: `1px solid ${T.green}`,
                                  color: T.green,
                                  padding: "2px 4px",
                                  marginRight: 2,
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                }}
                              >
                                <Check size={10} />
                              </button>
                              <button
                                onClick={cancelPreviewEdit}
                                title="Cancel (Esc)"
                                style={{
                                  background: "transparent",
                                  border: `1px solid ${T.border}`,
                                  color: T.textDim,
                                  padding: "2px 4px",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                }}
                              >
                                <X size={10} />
                              </button>
                            </td>
                          </tr>
                        );
                      }

                      return (
                        <tr
                          key={idx}
                          onDoubleClick={() => startPreviewEdit(idx)}
                          style={{
                            background: isEditingThis
                              ? "rgba(201, 169, 97, 0.04)"
                              : r.duplicate
                              ? "rgba(232, 140, 140, 0.09)"
                              : r.ok
                              ? "transparent"
                              : "rgba(232, 140, 140, 0.05)",
                            borderBottom: `1px solid ${T.borderSoft}`,
                            cursor: "default",
                          }}
                        >
                          <td style={{ padding: "6px 8px", textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() =>
                                setCheckedRows((cur) => {
                                  const next = new Set(cur);
                                  if (next.has(idx)) next.delete(idx);
                                  else next.add(idx);
                                  return next;
                                })
                              }
                              onClick={(e) => e.stopPropagation()}
                              style={{ accentColor: T.gold, cursor: "pointer" }}
                            />
                          </td>
                          <td style={{ padding: "6px 10px", color: T.textFaint }}>
                            {idx + 1}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.text }}>
                            {r.ok ? r.tx.date : "—"}
                          </td>
                          <td
                            style={{
                              padding: "6px 10px",
                              color: r.ok
                                ? r.tx.side === "buy"
                                  ? T.green
                                  : T.red
                                : T.textDim,
                            }}
                          >
                            {r.ok ? r.tx.side : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.text }}>
                            {r.ok ? r.tx.ticker : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.text }}>
                            {r.ok ? fmtNum(r.tx.qty) : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.text }}>
                            {r.ok ? fmtNum(r.tx.price, 2) : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.textDim }}>
                            {r.needsAssetClass ? (
                              <select
                                value=""
                                onChange={(e) =>
                                  e.target.value && pickAssetClass(idx, e.target.value)
                                }
                                style={{
                                  background: T.cardElev,
                                  border: `1px solid ${T.gold}`,
                                  color: T.gold,
                                  padding: "2px 4px",
                                  fontFamily: FONT_MONO,
                                  fontSize: 10,
                                  cursor: "pointer",
                                  maxWidth: 130,
                                }}
                              >
                                <option value="">— pick —</option>
                                {ASSET_CLASS_IDS.map((id) => (
                                  <option key={id} value={id}>
                                    {id}
                                  </option>
                                ))}
                              </select>
                            ) : r.ok ? (
                              r.tx.assetClass || "—"
                            ) : (
                              "—"
                            )}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.red, fontSize: 10 }}>
                            {!r.ok && !r.needsAssetClass && r.errors.join("; ")}
                            {r.needsAssetClass && (
                              <span style={{ color: T.gold }}>pick class</span>
                            )}
                            {r.duplicate && (
                              <span
                                style={{ color: T.red, fontWeight: 600 }}
                                title="A saved transaction already has this ticker, side, qty and date. Check the box to import anyway."
                              >
                                Duplicate
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mode toggle — only meaningful when there's existing data */}
              {existingCount > 0 && (
                <>
                  <Label>How to apply</Label>
                  <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                    {[
                      { id: "append", label: `Append (keep ${existingCount} existing)` },
                      { id: "replace", label: `Replace all ${existingCount}` },
                    ].map((m) => {
                      const active = mode === m.id;
                      return (
                        <button
                          key={m.id}
                          onClick={() => setMode(m.id)}
                          style={{
                            flex: 1,
                            background: active
                              ? m.id === "replace"
                                ? "rgba(232, 140, 140, 0.12)"
                                : "rgba(125, 211, 164, 0.12)"
                              : "transparent",
                            border: `1px solid ${
                              active ? (m.id === "replace" ? T.red : T.green) : T.border
                            }`,
                            color: active
                              ? m.id === "replace"
                                ? T.red
                                : T.green
                              : T.textDim,
                            padding: "10px 12px",
                            fontFamily: FONT_MONO,
                            fontSize: 10,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            cursor: "pointer",
                          }}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {mode === "replace" && existingCount > 0 && (
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.red,
                    marginBottom: 14,
                    padding: 10,
                    border: `1px solid ${T.red}`,
                    background: "rgba(232, 140, 140, 0.05)",
                  }}
                >
                  Warning: replacing will delete all {existingCount} existing
                  transactions.
                </div>
              )}

              {/* Actions */}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleConfirm}
                  disabled={checkedValidCount === 0 && incomeCount === 0}
                  style={{
                    background: T.gold,
                    border: "none",
                    color: "#0b0d10",
                    padding: "10px 16px",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    cursor: checkedValidCount > 0 || incomeCount > 0 ? "pointer" : "default",
                    opacity: checkedValidCount > 0 || incomeCount > 0 ? 1 : 0.4,
                  }}
                >
                  Import {checkedValidCount} of {totalCount} rows
                  {incomeCount > 0 ? ` + ${incomeCount} interest` : ""}
                </button>
                <button
                  onClick={() => {
                    setParsed(null);
                    setDecimalPrompt(false);
                    setEditingIdx(null);
                    setEditDraft(null);
                  }}
                  style={{
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    color: T.textDim,
                    padding: "10px 16px",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  Back
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Main view -------------------------------------------------------------

export default function TransactionsView({ auth, onAuthFail, knownTickers = [], valuesHidden, onTransactionsChange, pendingSplits = [], splitEvents = [], splitActionInFlight = null, onApproveSplit, onDismissSplit }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transactions, setTransactions] = useState([]);
  // Bond interest payments (separate income store; not in the transactions
  // array, so position math never sees them). Persisted alongside in the same
  // /api/transactions blob under a `bondIncome` field.
  const [bondIncome, setBondIncome] = useState([]);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null); // tx | null
  const [importOpen, setImportOpen] = useState(false);
  const [splitCardOpen, setSplitCardOpen] = useState(false);
  const [splitHistoryOpen, setSplitHistoryOpen] = useState(false);
  // Fidelity automation (item 38): trades staged by the scraper, awaiting approval.
  const [pendingFid, setPendingFid] = useState([]);
  const [pendingFidBond, setPendingFidBond] = useState([]);
  const [pendingFidOpen, setPendingFidOpen] = useState(true);
  const [pendingFidChecked, setPendingFidChecked] = useState(() => new Set());
  const [approvingFid, setApprovingFid] = useState(false);
  // Ticker resolution status: { [TICKER]: "ok" | "error" } — cached in localStorage
  // so we don't re-hit the price API for already-validated tickers every load.
  const [tickerStatus, setTickerStatus] = useState(() => {
    try {
      const raw = localStorage.getItem("tickerStatus");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [checkingTickers, setCheckingTickers] = useState(() => new Set());
  const onAuthFailRef = useRef(onAuthFail);
  useEffect(() => {
    onAuthFailRef.current = onAuthFail;
  }, [onAuthFail]);

  // Persist ticker status cache.
  useEffect(() => {
    try {
      localStorage.setItem("tickerStatus", JSON.stringify(tickerStatus));
    } catch {}
  }, [tickerStatus]);

  // Verify a set of transactions' tickers against the price API, in small batches
  // (respecting rate limits). `force` re-checks even already-known tickers.
  async function verifyTickers(list, { force = false } = {}) {
    const toCheck = [];
    const seen = new Set();
    for (const tx of list) {
      if (!shouldVerifyTicker(tx)) continue;
      const t = tx.ticker.trim().toUpperCase();
      if (seen.has(t)) continue;
      seen.add(t);
      // Only "ok" is cached permanently; re-check "error"/"unknown" every load
      // (the symbol may have been fixed, or a prior failure was transient).
      if (!force && tickerStatus[t] === "ok") continue;
      toCheck.push(tx.ticker.trim());
    }
    if (toCheck.length === 0) return;

    setCheckingTickers((prev) => {
      const next = new Set(prev);
      toCheck.forEach((t) => next.add(t.toUpperCase()));
      return next;
    });

    const batchSize = 3;
    for (let i = 0; i < toCheck.length; i += batchSize) {
      const batch = toCheck.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (t) => {
          try {
            const status = await verifyTickerResolvable(t, auth);
            return [t.toUpperCase(), status];
          } catch (e) {
            if (e.code === 401 && typeof onAuthFailRef.current === "function") {
              onAuthFailRef.current();
            }
            return [t.toUpperCase(), "unknown"];
          }
        })
      );
      setTickerStatus((prev) => {
        const next = { ...prev };
        for (const [t, status] of results) {
          if (status === "ok" || status === "error") next[t] = status;
        }
        return next;
      });
      setCheckingTickers((prev) => {
        const next = new Set(prev);
        batch.forEach((t) => next.delete(t.toUpperCase()));
        return next;
      });
      if (i + batchSize < toCheck.length) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTransactionsFromServer(auth)
      .then((data) => {
        if (cancelled) return;
        const raw = Array.isArray(data.transactions) ? data.transactions : [];
        // Backfill assetClass on legacy records via inferAssetClass.
        const migrated = raw.map((t) => {
          if (t.assetClass) return t;
          const cls = inferAssetClass(t.ticker) || (t.currency === "BRL" ? "Unallocated BRL" : "Unallocated USD");
          return { ...t, assetClass: cls };
        });
        setTransactions(migrated);
        setBondIncome(Array.isArray(data.bondIncome) ? data.bondIncome : []);
        setLoading(false);
        // Validate tickers against the price API in the background.
        verifyTickers(migrated);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.code === 401 && typeof onAuthFailRef.current === "function") {
          onAuthFailRef.current();
          return;
        }
        setError(err.message || "Failed to load");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  async function persist(nextList, nextIncome) {
    setSaving(true);
    try {
      await saveTransactionsToServer(auth, nextList, nextIncome);
      setTransactions(nextList);
      if (Array.isArray(nextIncome)) setBondIncome(nextIncome);
      onTransactionsChange?.(nextList);
    } catch (err) {
      setError(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // Load Fidelity automation staging on mount. Filters out anything already live
  // (defensive — the server staging endpoint already skips live dups). Fail-silent.
  useEffect(() => {
    let cancelled = false;
    fetchPendingFidelity(auth).then((p) => {
      if (cancelled) return;
      const liveKeys = new Set(transactions.map(dupKey));
      const fresh = (p.transactions || []).filter((t) => !liveKeys.has(dupKey(t)));
      setPendingFid(fresh);
      setPendingFidBond(p.bondIncome || []);
      setPendingFidChecked(new Set(fresh.map((t) => t.id || dupKey(t))));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, transactions]);

  function togglePendingFid(key) {
    setPendingFidChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function approvePendingFid() {
    const keyOf = (t) => t.id || dupKey(t);
    const selected = pendingFid.filter((t) => pendingFidChecked.has(keyOf(t)));
    if (selected.length === 0) return;
    setApprovingFid(true);
    try {
      // Merge selected staged trades into live, deduped by dupKey.
      const liveKeys = new Set(transactions.map(dupKey));
      const toAdd = selected.filter((t) => !liveKeys.has(dupKey(t)));
      const nextTx = [...transactions, ...toAdd];
      // Merge staged bond income, deduped by date|ticker|amount.
      const seen = new Set(bondIncome.map((e) => `${e.date}|${e.ticker}|${e.amount}`));
      const nextIncome = [...bondIncome];
      for (const e of pendingFidBond) {
        const k = `${e.date}|${e.ticker}|${e.amount}`;
        if (seen.has(k)) continue;
        seen.add(k);
        nextIncome.push(e);
      }
      await persist(nextTx, nextIncome);
      await clearPendingFidelity(auth);
      setPendingFid([]);
      setPendingFidBond([]);
      setPendingFidChecked(new Set());
      verifyTickers(toAdd);
    } catch (err) {
      setError(err.message || "Approve failed");
    } finally {
      setApprovingFid(false);
    }
  }

  async function discardPendingFid() {
    setApprovingFid(true);
    try {
      await clearPendingFidelity(auth);
      setPendingFid([]);
      setPendingFidBond([]);
      setPendingFidChecked(new Set());
    } finally {
      setApprovingFid(false);
    }
  }

  async function handleAdd(tx) {
    await persist([...transactions, tx]);
    setFormOpen(false);
    verifyTickers([tx], { force: true });
  }

  async function handleUpdate(tx) {
    const next = transactions.map((t) => (t.id === tx.id ? tx : t));
    await persist(next);
    setEditing(null);
    verifyTickers([tx], { force: true });
  }

  async function handleDelete(tx) {
    const next = transactions.filter((t) => t.id !== tx.id);
    await persist(next);
  }

  async function handleBulkDelete(ids) {
    const idSet = new Set(ids);
    const next = transactions.filter((t) => !idSet.has(t.id));
    await persist(next);
  }

  async function handleBulkAssetClass(ids, cls) {
    const idSet = new Set(ids);
    const cur = currencyForAssetClass(cls) || "USD";
    const next = transactions.map((t) =>
      idSet.has(t.id) ? { ...t, assetClass: cls, currency: cur } : t
    );
    await persist(next);
  }

  async function handleImport(newTxs, mode, newIncome = []) {
    const next = mode === "replace" ? newTxs : [...transactions, ...newTxs];
    // Merge detected interest payments into the income store, deduping by
    // date+ticker+amount. On "replace" the income store is rebuilt from scratch.
    const base = mode === "replace" ? [] : bondIncome;
    const seen = new Set(base.map((e) => `${e.date}|${e.ticker}|${e.amount}`));
    const mergedIncome = [...base];
    for (const e of newIncome) {
      const k = `${e.date}|${e.ticker}|${e.amount}`;
      if (seen.has(k)) continue;
      seen.add(k);
      mergedIncome.push(e);
    }
    await persist(next, mergedIncome);
    setImportOpen(false);
    verifyTickers(newTxs);
  }

  function handleExport() {
    const csv = transactionsToCSV(transactions);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCSV(`transactions-${stamp}.csv`, csv);
  }

  if (loading) {
    return (
      <div
        style={{
          padding: "40px 0",
          textAlign: "center",
          color: T.textDim,
          fontFamily: FONT_MONO,
          fontSize: 12,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        Loading transactions...
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.red}`,
            padding: 12,
            color: T.red,
            fontFamily: FONT_MONO,
            fontSize: 12,
            marginBottom: 12,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Error: {error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: "transparent",
              border: "none",
              color: T.red,
              cursor: "pointer",
              padding: 4,
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Summary + Add button */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: T.textDim,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          {`${transactions.length} total`}
          {saving && " - saving..."}
        </div>
        {!formOpen && !editing && (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => setImportOpen(true)}
              title="Import from CSV or paste"
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                color: T.textDim,
                padding: "8px 12px",
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Upload size={12} />
              Bulk Import
            </button>
            {transactions.length > 0 && (
              <button
                onClick={handleExport}
                title="Export to CSV"
                style={{
                  background: "transparent",
                  border: `1px solid ${T.border}`,
                  color: T.textDim,
                  padding: "8px 12px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Download size={12} />
                Export
              </button>
            )}
            <button
              onClick={() => setFormOpen(true)}
              style={{
                background: T.gold,
                border: "none",
                color: "#0b0d10",
                padding: "8px 14px",
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Plus size={12} />
              New
            </button>
          </div>
        )}
      </div>

      {/* Fidelity Import — staged by the automation, awaiting approval (item 38) */}
      {pendingFid.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setPendingFidOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              background: "rgba(201,169,97,0.06)",
              border: `1px solid ${T.gold}55`,
              borderRadius: pendingFidOpen ? "4px 4px 0 0" : 4,
              padding: "10px 14px",
              cursor: "pointer",
              color: T.gold,
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
            }}
          >
            <ChevronDown
              size={12}
              style={{
                transform: pendingFidOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.2s",
              }}
            />
            Fidelity Import
            <span
              style={{
                marginLeft: 8,
                background: T.gold,
                color: "#0b0d10",
                fontFamily: FONT_MONO,
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 6px",
                borderRadius: 8,
              }}
            >
              {pendingFid.length} new
            </span>
          </button>

          {pendingFidOpen && (
            <div
              style={{
                background: T.card,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                borderRadius: "0 0 4px 4px",
                padding: 14,
              }}
            >
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: T.textDim,
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                Staged by the automated import. Review and approve to add to your
                transactions. Nothing is saved until you approve.
              </div>

              <div style={{ overflowX: "auto", marginBottom: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}>
                        <input
                          type="checkbox"
                          checked={pendingFidChecked.size === pendingFid.length}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setPendingFidChecked(new Set(pendingFid.map((t) => t.id || dupKey(t))));
                            } else {
                              setPendingFidChecked(new Set());
                            }
                          }}
                        />
                      </th>
                      {["Date", "B/S", "Ticker", "Qty", "Price"].map((h) => (
                        <th
                          key={h}
                          style={{
                            textAlign: h === "Qty" || h === "Price" ? "right" : "left",
                            fontFamily: FONT_MONO,
                            fontSize: 9,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            color: T.textFaint,
                            padding: "4px 8px",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pendingFid.map((t) => {
                      const key = t.id || dupKey(t);
                      const cur = t.currency || "USD";
                      return (
                        <tr key={key} style={{ borderTop: `1px solid ${T.border}` }}>
                          <td style={{ padding: "4px 0" }}>
                            <input
                              type="checkbox"
                              checked={pendingFidChecked.has(key)}
                              onChange={() => togglePendingFid(key)}
                            />
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, padding: "4px 8px" }}>
                            {t.date}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: t.side === "sell" ? T.red : T.green, padding: "4px 8px" }}>
                            {t.side === "sell" ? "S" : "B"}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, padding: "4px 8px" }}>
                            {t.ticker}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, textAlign: "right", padding: "4px 8px" }}>
                            {fmtNum(t.qty)}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, textAlign: "right", padding: "4px 8px" }}>
                            {valuesHidden ? "•••" : fmtMoney(t.price, cur)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={approvePendingFid}
                  disabled={approvingFid || pendingFidChecked.size === 0}
                  style={{
                    background: T.gold,
                    color: "#0b0d10",
                    border: "none",
                    borderRadius: 4,
                    padding: "8px 14px",
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    cursor: approvingFid || pendingFidChecked.size === 0 ? "default" : "pointer",
                    opacity: approvingFid || pendingFidChecked.size === 0 ? 0.5 : 1,
                  }}
                >
                  {approvingFid ? "Working…" : `Approve ${pendingFidChecked.size} of ${pendingFid.length}`}
                </button>
                <button
                  onClick={discardPendingFid}
                  disabled={approvingFid}
                  style={{
                    background: "transparent",
                    color: T.textDim,
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    padding: "8px 14px",
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    cursor: approvingFid ? "default" : "pointer",
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Splits / Groupings inline card */}
      {(pendingSplits.length > 0 || splitEvents.length > 0) && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setSplitCardOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              background: pendingSplits.length > 0 ? "rgba(201,169,97,0.06)" : T.card,
              border: `1px solid ${pendingSplits.length > 0 ? T.gold + "55" : T.border}`,
              borderRadius: splitCardOpen ? "4px 4px 0 0" : 4,
              padding: "10px 14px",
              cursor: "pointer",
              color: pendingSplits.length > 0 ? T.gold : T.textDim,
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
            }}
          >
            <ChevronDown
              size={12}
              style={{
                transform: splitCardOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.2s",
              }}
            />
            Splits / Groupings
            {pendingSplits.length > 0 && (
              <span
                style={{
                  marginLeft: 8,
                  background: T.gold,
                  color: "#0b0d10",
                  fontFamily: FONT_MONO,
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "1px 6px",
                  borderRadius: 8,
                }}
              >
                {pendingSplits.length} pending
              </span>
            )}
          </button>

          {splitCardOpen && (
            <div
              style={{
                background: T.card,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                borderRadius: "0 0 4px 4px",
                padding: 14,
              }}
            >
              {/* Pending section */}
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 9,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: T.textFaint,
                  marginBottom: 10,
                }}
              >
                Pending ({pendingSplits.length})
              </div>

              {pendingSplits.length === 0 ? (
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    color: T.textDim,
                    padding: "8px 0 16px",
                    lineHeight: 1.5,
                  }}
                >
                  No pending splits. History is up to date.
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    marginBottom: splitEvents.length > 0 ? 16 : 0,
                  }}
                >
                  {pendingSplits.map((sp) => {
                    const key = `${sp.ticker}|${sp.date}|${sp.numerator}|${sp.denominator}`;
                    const num = Number(sp.numerator);
                    const den = Number(sp.denominator);
                    const isReverse = den > num;
                    const factorLabel = isReverse ? `${num}:${den} reverse` : `${num}:${den}`;
                    const isThisInFlight = splitActionInFlight === key;
                    const anyInFlight = splitActionInFlight !== null;
                    const affected = transactions.filter(
                      (tx) =>
                        (tx.ticker || "").toUpperCase() === sp.ticker &&
                        tx.date < sp.date &&
                        !(tx.splitAdjusted && tx.splitDate === sp.date)
                    );
                    const thStyle = {
                      fontFamily: FONT_MONO,
                      fontSize: 9,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: T.textFaint,
                      padding: "6px 8px",
                      borderBottom: `1px solid ${T.border}`,
                      whiteSpace: "nowrap",
                    };
                    const tdStyle = {
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      padding: "6px 8px",
                      borderBottom: `1px solid ${T.borderSoft}`,
                      color: T.text,
                      whiteSpace: "nowrap",
                    };
                    return (
                      <div
                        key={key}
                        style={{
                          background: T.cardElev,
                          border: `1px solid ${T.borderSoft}`,
                          borderRadius: 4,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 10,
                            flexWrap: "wrap",
                            padding: "8px 12px",
                            borderBottom: `1px solid ${T.borderSoft}`,
                          }}
                        >
                          <span style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 600, color: T.text }}>
                            {sp.ticker}
                          </span>
                          <span
                            style={{
                              fontFamily: FONT_MONO,
                              fontSize: 11,
                              color: isReverse ? T.red : T.green,
                              letterSpacing: "0.08em",
                              textTransform: "uppercase",
                            }}
                          >
                            {factorLabel}
                          </span>
                          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                            {sp.date}
                          </span>
                          <span style={{ marginLeft: "auto", fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint }}>
                            {affected.length} tx affected
                          </span>
                        </div>

                        {affected.length > 0 && (
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", minWidth: 380, borderCollapse: "collapse" }}>
                              <thead>
                                <tr>
                                  <th style={{ ...thStyle, textAlign: "left" }}>Date</th>
                                  <th style={{ ...thStyle, textAlign: "right" }}>Qty {"→"} New</th>
                                  <th style={{ ...thStyle, textAlign: "right" }}>Price {"→"} New</th>
                                </tr>
                              </thead>
                              <tbody>
                                {affected.map((tx) => {
                                  const newQty = parseFloat((tx.qty * (num / den)).toFixed(6));
                                  const newPrice = parseFloat((tx.price * (den / num)).toFixed(6));
                                  return (
                                    <tr key={tx.id}>
                                      <td style={{ ...tdStyle, textAlign: "left" }}>{tx.date}</td>
                                      <td style={{ ...tdStyle, textAlign: "right" }}>
                                        {tx.qty} {"→"} <span style={{ color: T.gold }}>{newQty}</span>
                                      </td>
                                      <td style={{ ...tdStyle, textAlign: "right" }}>
                                        ${tx.price} {"→"} <span style={{ color: T.gold }}>${newPrice}</span>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}

                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            padding: "8px 12px",
                            borderTop: `1px solid ${T.borderSoft}`,
                            alignItems: "center",
                          }}
                        >
                          <button
                            onClick={() => onApproveSplit?.(sp)}
                            disabled={anyInFlight}
                            style={{
                              background: anyInFlight ? "rgba(201,169,97,0.4)" : T.gold,
                              border: "none",
                              color: "#0b0d10",
                              padding: "7px 12px",
                              fontFamily: FONT_MONO,
                              fontSize: 10,
                              letterSpacing: "0.15em",
                              textTransform: "uppercase",
                              cursor: anyInFlight ? "not-allowed" : "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                            }}
                          >
                            {isThisInFlight ? (
                              <>
                                <RefreshCw size={10} className="spin" />
                                Applying…
                              </>
                            ) : (
                              "Approve"
                            )}
                          </button>
                          <button
                            onClick={() => onDismissSplit?.(sp)}
                            disabled={anyInFlight}
                            style={{
                              background: "transparent",
                              border: `1px solid ${anyInFlight ? T.borderSoft : T.border}`,
                              color: anyInFlight ? T.textFaint : T.textDim,
                              padding: "7px 12px",
                              fontFamily: FONT_MONO,
                              fontSize: 10,
                              letterSpacing: "0.15em",
                              textTransform: "uppercase",
                              cursor: anyInFlight ? "not-allowed" : "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                            }}
                          >
                            {isThisInFlight ? (
                              <>
                                <RefreshCw size={10} className="spin" />
                                Dismissing…
                              </>
                            ) : (
                              "Dismiss"
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* History section */}
              {splitEvents.length > 0 && (
                <div>
                  <button
                    onClick={() => setSplitHistoryOpen((v) => !v)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      background: "transparent",
                      border: "none",
                      borderTop: `1px solid ${T.borderSoft}`,
                      padding: "10px 0 0",
                      cursor: "pointer",
                      color: T.textDim,
                      fontFamily: FONT_MONO,
                      fontSize: 9,
                      letterSpacing: "0.15em",
                      textTransform: "uppercase",
                    }}
                  >
                    <ChevronDown
                      size={11}
                      style={{
                        transform: splitHistoryOpen ? "none" : "rotate(-90deg)",
                        transition: "transform 0.2s",
                      }}
                    />
                    History ({splitEvents.length})
                  </button>
                  {splitHistoryOpen && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                      {[...splitEvents].reverse().map((ev, i) => {
                        const isApplied = ev.status === "applied";
                        const num = Number(ev.numerator);
                        const den = Number(ev.denominator);
                        const isReverse = den > num;
                        const factorLabel = isReverse ? `${num}:${den} reverse` : `${num}:${den}`;
                        const appliedDate = ev.appliedAt
                          ? new Date(ev.appliedAt).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })
                          : ev.date;
                        return (
                          <div
                            key={i}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              flexWrap: "wrap",
                              padding: "6px 10px",
                              background: T.cardElev,
                              border: `1px solid ${T.borderSoft}`,
                              borderRadius: 4,
                            }}
                          >
                            <span style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600, color: T.text }}>
                              {ev.ticker}
                            </span>
                            <span
                              style={{
                                fontFamily: FONT_MONO,
                                fontSize: 10,
                                color: isReverse ? T.red : T.green,
                                letterSpacing: "0.08em",
                                textTransform: "uppercase",
                              }}
                            >
                              {factorLabel}
                            </span>
                            <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint }}>
                              {ev.date}
                            </span>
                            <span
                              style={{
                                fontFamily: FONT_MONO,
                                fontSize: 9,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                color: isApplied ? T.green : T.textFaint,
                                background: isApplied ? "rgba(125,211,164,0.1)" : "transparent",
                                border: `1px solid ${isApplied ? T.green + "44" : T.borderSoft}`,
                                padding: "2px 5px",
                                borderRadius: 2,
                              }}
                            >
                              {isApplied ? "Applied" : "Dismissed"}
                            </span>
                            <span
                              style={{
                                marginLeft: "auto",
                                fontFamily: FONT_MONO,
                                fontSize: 9,
                                color: T.textFaint,
                              }}
                            >
                              {appliedDate}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {formOpen && !editing && (
        <TransactionForm
          knownTickers={knownTickers}
          onSubmit={handleAdd}
          onCancel={() => setFormOpen(false)}
          busy={saving}
          auth={auth}
        />
      )}

      {editing && (
        <TransactionForm
          initial={editing}
          knownTickers={knownTickers}
          onSubmit={handleUpdate}
          onCancel={() => setEditing(null)}
          busy={saving}
          auth={auth}
        />
      )}

      <TransactionTable
        transactions={transactions}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        onBulkDelete={handleBulkDelete}
        onBulkAssetClass={handleBulkAssetClass}
        busy={saving}
        valuesHidden={valuesHidden}
        tickerStatus={tickerStatus}
        checkingTickers={checkingTickers}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onConfirm={handleImport}
        existingCount={transactions.length}
        existingTransactions={transactions}
      />

    </div>
  );
}
