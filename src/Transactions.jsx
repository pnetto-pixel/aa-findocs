// src/Transactions.jsx
// Chunk 1B: add form, chronological list, inline edit, direct delete, filters.
// Bulk paste + CSV upload land in 1C.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Pencil, X, Check, Search, Upload, Download } from "lucide-react";
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

async function saveTransactionsToServer(auth, transactions) {
  const res = await fetch("/api/transactions", {
    method: "PUT",
    headers: {
      ...authHeaders(auth),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ transactions }),
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

function TransactionForm({ initial, knownTickers, onSubmit, onCancel, busy }) {
  const isEdit = !!initial;
  const [date, setDate] = useState(initial?.date || todayISO());
  const [side, setSide] = useState(initial?.side || "buy");
  const [ticker, setTicker] = useState(initial?.ticker || "");
  const [qty, setQty] = useState(initial ? String(initial.qty) : "");
  const [price, setPrice] = useState(initial ? String(initial.price) : "");
  const [currency, setCurrency] = useState(initial?.currency || "USD");
  const [fee, setFee] = useState(initial?.fee ? String(initial.fee) : "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [error, setError] = useState("");
  const [showTickerList, setShowTickerList] = useState(false);

  const tickerSuggestions = useMemo(() => {
    const q = ticker.trim().toUpperCase();
    if (!q) return [];
    return knownTickers
      .filter((t) => t.toUpperCase().includes(q) && t.toUpperCase() !== q)
      .slice(0, 6);
  }, [ticker, knownTickers]);

  function handleSubmit() {
    setError("");
    const tkr = ticker.trim().toUpperCase();
    if (!tkr) return setError("Ticker required");
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
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onFocus={() => setShowTickerList(true)}
            onBlur={() => setTimeout(() => setShowTickerList(false), 150)}
            style={{ textTransform: "uppercase" }}
          />
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
          <Label>Currency</Label>
          <div style={{ display: "flex", gap: 6 }}>
            {["USD", "BRL"].map((c) => {
              const active = currency === c;
              return (
                <button
                  key={c}
                  onClick={() => setCurrency(c)}
                  style={{
                    flex: 1,
                    background: active ? "rgba(201, 169, 97, 0.12)" : "transparent",
                    border: `1px solid ${active ? T.gold : T.border}`,
                    color: active ? T.gold : T.textDim,
                    padding: "10px 12px",
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    letterSpacing: "0.15em",
                    cursor: "pointer",
                  }}
                >
                  {c}
                </button>
              );
            })}
          </div>
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

// --- Filters ---------------------------------------------------------------

function FiltersBar({ filters, setFilters }) {
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.borderSoft}`,
        padding: 16,
        marginBottom: 12,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
      }}
    >
      <div style={{ gridColumn: "1 / -1", position: "relative" }}>
        <Label>Search ticker / notes</Label>
        <div style={{ position: "relative" }}>
          <Search
            size={12}
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              transform: "translateY(-50%)",
              color: T.textFaint,
              pointerEvents: "none",
            }}
          />
          <Input
            value={filters.text}
            onChange={(e) => setFilters({ ...filters, text: e.target.value })}
            placeholder="AAPL, dividend, ..."
            style={{ paddingLeft: 34 }}
          />
        </div>
      </div>
      <div>
        <Label>Side</Label>
        <div style={{ display: "flex", gap: 6 }}>
          {["all", "buy", "sell"].map((s) => {
            const active = filters.side === s;
            return (
              <button
                key={s}
                onClick={() => setFilters({ ...filters, side: s })}
                style={{
                  flex: 1,
                  background: active ? "rgba(201, 169, 97, 0.12)" : "transparent",
                  border: `1px solid ${active ? T.gold : T.border}`,
                  color: active ? T.gold : T.textDim,
                  padding: "8px 6px",
                  fontFamily: FONT_MONO,
                  fontSize: 10,
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
      <div>
        <Label>Currency</Label>
        <div style={{ display: "flex", gap: 6 }}>
          {["all", "USD", "BRL"].map((c) => {
            const active = filters.currency === c;
            return (
              <button
                key={c}
                onClick={() => setFilters({ ...filters, currency: c })}
                style={{
                  flex: 1,
                  background: active ? "rgba(201, 169, 97, 0.12)" : "transparent",
                  border: `1px solid ${active ? T.gold : T.border}`,
                  color: active ? T.gold : T.textDim,
                  padding: "8px 6px",
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <Label>From</Label>
        <Input
          type="date"
          value={filters.from}
          onChange={(e) => setFilters({ ...filters, from: e.target.value })}
        />
      </div>
      <div>
        <Label>To</Label>
        <Input
          type="date"
          value={filters.to}
          onChange={(e) => setFilters({ ...filters, to: e.target.value })}
        />
      </div>
    </div>
  );
}

// --- Transaction row -------------------------------------------------------

function TxRow({ tx, onEdit, onDelete, busy }) {
  const isBuy = tx.side === "buy";
  const total = (Number(tx.qty) || 0) * (Number(tx.price) || 0);
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.borderSoft}`,
        padding: 14,
        marginBottom: 8,
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 12,
        alignItems: "center",
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 9,
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          padding: "4px 8px",
          background: isBuy ? "rgba(125, 211, 164, 0.1)" : "rgba(232, 140, 140, 0.1)",
          color: isBuy ? T.green : T.red,
          border: `1px solid ${isBuy ? T.green : T.red}`,
        }}
      >
        {tx.side}
      </div>

      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 16,
            fontWeight: 500,
            marginBottom: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {tx.ticker}
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: T.textDim,
          }}
        >
          {fmtNum(tx.qty)} x {fmtMoney(tx.price, tx.currency)} ={" "}
          <span style={{ color: T.text }}>{fmtMoney(total, tx.currency)}</span>
          {tx.fee ? ` - fee ${fmtMoney(tx.fee, tx.currency)}` : ""}
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: T.textFaint,
            marginTop: 2,
          }}
        >
          {tx.date}
          {tx.notes ? ` - ${tx.notes}` : ""}
        </div>
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        <button
          onClick={() => onEdit(tx)}
          disabled={busy}
          title="Edit"
          style={{
            background: "transparent",
            border: `1px solid ${T.border}`,
            color: T.textDim,
            padding: "6px 8px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
          }}
        >
          <Pencil size={11} />
        </button>
        <button
          onClick={() => onDelete(tx)}
          disabled={busy}
          title="Delete"
          style={{
            background: "transparent",
            border: `1px solid ${T.border}`,
            color: T.red,
            padding: "6px 8px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
          }}
        >
          <Trash2 size={11} />
        </button>
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

function parseDate(raw) {
  if (!raw) return { value: null, error: "missing" };
  const s = String(raw).trim();
  // ISO YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    const mm = mo.padStart(2, "0");
    const dd = d.padStart(2, "0");
    if (!isValidYMD(y, mm, dd)) return { value: null, error: "bad date" };
    return { value: `${y}-${mm}-${dd}`, error: null };
  }
  // DD/MM/YYYY or DD-MM-YYYY (BR default for ambiguous)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? "19" : "20") + y;
    d = d.padStart(2, "0");
    mo = mo.padStart(2, "0");
    // If month > 12 but day <= 12, swap (it was MDY).
    if (parseInt(mo, 10) > 12 && parseInt(d, 10) <= 12) {
      [d, mo] = [mo, d];
    }
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
function parseRow(row, defaultCurrency = "USD") {
  const errors = [];
  const rawNumbers = {
    qty: row.qty,
    price: row.price,
    fee: row.fee,
  };

  const d = parseDate(row.date);
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

  let cur = { value: defaultCurrency, error: null };
  if (row.currency) {
    cur = parseCurrency(row.currency);
    if (cur.error) errors.push(`currency: ${cur.error}`);
  }

  const ambiguous = qty.ambiguous || price.ambiguous || fee.ambiguous;

  if (errors.length > 0) {
    return { ok: false, tx: null, errors, ambiguous, rawNumbers };
  }

  return {
    ok: true,
    errors: [],
    ambiguous,
    rawNumbers,
    tx: {
      id: newId(),
      date: d.value,
      side: sd.value,
      ticker,
      qty: qty.value,
      price: price.value,
      currency: cur.value,
      fee: fee.value || 0,
      notes: String(row.notes || "").trim(),
      createdAt: new Date().toISOString(),
    },
  };
}

// Re-parse rows treating comma as decimal in numeric fields.
function reparseWithCommaDecimal(rows, defaultCurrency = "USD") {
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
    return parseRow(patched, defaultCurrency);
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
  currency: ["currency", "moeda", "ccy"],
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

  const FIELD_ORDER = ["date", "side", "ticker", "qty", "price", "currency", "fee", "notes"];

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
  const headers = ["date", "side", "ticker", "qty", "price", "currency", "fee", "notes"];
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

// --- Import Modal ----------------------------------------------------------

const SAMPLE_CSV = `date,side,ticker,qty,price,currency,fee,notes
2024-03-15,buy,AAPL,10,175.50,USD,0,
2024-03-20,buy,BBSE3,100,38.20,BRL,,monthly buy`;

function ImportModal({ open, onClose, onConfirm, existingCount }) {
  const [tab, setTab] = useState("paste"); // paste | upload
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null); // { results, hadHeader }
  const [decimalPrompt, setDecimalPrompt] = useState(false); // ambiguous comma found
  const [structuralPrompt, setStructuralPrompt] = useState(false); // BR-decimal-in-CSV suspected
  const [mode, setMode] = useState("append"); // append | replace
  const [fileError, setFileError] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setText("");
      setParsed(null);
      setDecimalPrompt(false);
      setStructuralPrompt(false);
      setMode("append");
      setFileError("");
      setTab("paste");
    }
  }, [open]);

  function doParse(rawText) {
    const out = parseCSVOrPaste(rawText);
    if (out.rows.length === 0) {
      setFileError("No rows detected");
      setParsed(null);
      return;
    }
    // If columns mismatch AND delimiter is comma, suspected BR decimal in CSV.
    if (out.structuralBreak && out.delimiter === ",") {
      // Hold the parse result; show prompt offering BR auto-fix.
      const results = out.rows.map((r) => parseRow(r));
      setParsed({ results, hadHeader: out.hadHeader, rawRows: out.rows, sourceText: rawText });
      setStructuralPrompt(true);
      setDecimalPrompt(false);
      setFileError("");
      return;
    }
    const results = out.rows.map((r) => parseRow(r));
    const ambiguousCount = results.filter((r) => r.ambiguous).length;
    setParsed({ results, hadHeader: out.hadHeader, rawRows: out.rows, sourceText: rawText });
    setDecimalPrompt(ambiguousCount > 0);
    setStructuralPrompt(false);
    setFileError("");
  }

  function applyBRReparse(yes) {
    if (!parsed) return;
    setStructuralPrompt(false);
    if (!yes) return;
    // Re-run parse with positional auto-fix enabled.
    const out = parseCSVOrPaste(parsed.sourceText, { autoFixBR: true });
    if (out.rows.length === 0) {
      setFileError("Reparse produced no rows");
      setParsed(null);
      return;
    }
    const results = out.rows.map((r) => parseRow(r));
    const ambiguousCount = results.filter((r) => r.ambiguous).length;
    setParsed({
      results,
      hadHeader: out.hadHeader,
      rawRows: out.rows,
      sourceText: parsed.sourceText,
      reparseNote:
        out.unfixableRows > 0
          ? `${out.fixedRows} row(s) fixed, ${out.unfixableRows} could not be auto-fixed.`
          : null,
    });
    setDecimalPrompt(ambiguousCount > 0);
  }

  function applyCommaDecimal(useComma) {
    if (!parsed) return;
    if (useComma) {
      const next = reparseWithCommaDecimal(parsed.rawRows);
      setParsed({ ...parsed, results: next });
    }
    setDecimalPrompt(false);
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

  function handleConfirm() {
    if (!parsed) return;
    const validTx = parsed.results.filter((r) => r.ok).map((r) => r.tx);
    if (validTx.length === 0) return;
    onConfirm(validTx, mode);
  }

  if (!open) return null;

  const validCount = parsed ? parsed.results.filter((r) => r.ok).length : 0;
  const errorCount = parsed ? parsed.results.filter((r) => !r.ok).length : 0;

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
                  { id: "paste", label: "Paste" },
                  { id: "upload", label: "Upload CSV" },
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

              {tab === "paste" && (
                <div>
                  <Label>Paste CSV or tab-separated data</Label>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={SAMPLE_CSV}
                    rows={10}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      background: T.card,
                      border: `1px solid ${T.border}`,
                      color: T.text,
                      padding: 12,
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      lineHeight: 1.5,
                      resize: "vertical",
                      outline: "none",
                    }}
                  />
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      color: T.textFaint,
                      marginTop: 8,
                      lineHeight: 1.5,
                    }}
                  >
                    Columns: date, side, ticker, qty, price, currency, fee,
                    notes. First row may be a header. Sides: buy/sell or
                    compra/venda.
                  </div>
                  <button
                    onClick={() => doParse(text)}
                    disabled={!text.trim()}
                    style={{
                      marginTop: 12,
                      background: T.gold,
                      border: "none",
                      color: "#0b0d10",
                      padding: "10px 16px",
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      letterSpacing: "0.15em",
                      textTransform: "uppercase",
                      cursor: text.trim() ? "pointer" : "default",
                      opacity: text.trim() ? 1 : 0.4,
                    }}
                  >
                    Parse
                  </button>
                </div>
              )}

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
                      marginTop: 8,
                      lineHeight: 1.5,
                    }}
                  >
                    Same columns as paste. Header row recommended.
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
                      {["#", "date", "side", "ticker", "qty", "price", "cur", ""].map((h) => (
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
                    {parsed.results.map((r, idx) => (
                      <tr
                        key={idx}
                        style={{
                          background: r.ok ? "transparent" : "rgba(232, 140, 140, 0.05)",
                          borderBottom: `1px solid ${T.borderSoft}`,
                        }}
                      >
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
                          {r.ok ? r.tx.currency : "—"}
                        </td>
                        <td style={{ padding: "6px 10px", color: T.red, fontSize: 10 }}>
                          {!r.ok && r.errors.join("; ")}
                        </td>
                      </tr>
                    ))}
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
                  disabled={validCount === 0}
                  style={{
                    background: T.gold,
                    border: "none",
                    color: "#0b0d10",
                    padding: "10px 16px",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    cursor: validCount > 0 ? "pointer" : "default",
                    opacity: validCount > 0 ? 1 : 0.4,
                  }}
                >
                  Import {validCount}
                </button>
                <button
                  onClick={() => {
                    setParsed(null);
                    setDecimalPrompt(false);
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

export default function TransactionsView({ auth, onAuthFail, knownTickers = [] }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null); // tx | null
  const [importOpen, setImportOpen] = useState(false);
  const [filters, setFilters] = useState({
    text: "",
    side: "all",
    currency: "all",
    from: "",
    to: "",
  });
  const onAuthFailRef = useRef(onAuthFail);
  useEffect(() => {
    onAuthFailRef.current = onAuthFail;
  }, [onAuthFail]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTransactionsFromServer(auth)
      .then((data) => {
        if (cancelled) return;
        setTransactions(Array.isArray(data.transactions) ? data.transactions : []);
        setLoading(false);
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

  async function persist(nextList) {
    setSaving(true);
    try {
      await saveTransactionsToServer(auth, nextList);
      setTransactions(nextList);
    } catch (err) {
      setError(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleAdd(tx) {
    await persist([...transactions, tx]);
    setFormOpen(false);
  }

  async function handleUpdate(tx) {
    const next = transactions.map((t) => (t.id === tx.id ? tx : t));
    await persist(next);
    setEditing(null);
  }

  async function handleDelete(tx) {
    const next = transactions.filter((t) => t.id !== tx.id);
    await persist(next);
  }

  async function handleImport(newTxs, mode) {
    const next = mode === "replace" ? newTxs : [...transactions, ...newTxs];
    await persist(next);
    setImportOpen(false);
  }

  function handleExport() {
    const csv = transactionsToCSV(transactions);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCSV(`transactions-${stamp}.csv`, csv);
  }

  // Filter + sort (date desc, then createdAt desc as tiebreaker)
  const visible = useMemo(() => {
    const q = filters.text.trim().toLowerCase();
    let list = transactions.filter((t) => {
      if (filters.side !== "all" && t.side !== filters.side) return false;
      if (filters.currency !== "all" && t.currency !== filters.currency) return false;
      if (filters.from && t.date < filters.from) return false;
      if (filters.to && t.date > filters.to) return false;
      if (q) {
        const hay = `${t.ticker} ${t.notes || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const ac = a.createdAt || "";
      const bc = b.createdAt || "";
      return ac < bc ? 1 : -1;
    });
    return list;
  }, [transactions, filters]);

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
          {visible.length === transactions.length
            ? `${transactions.length} total`
            : `${visible.length} / ${transactions.length} shown`}
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
              Import
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

      {formOpen && !editing && (
        <TransactionForm
          knownTickers={knownTickers}
          onSubmit={handleAdd}
          onCancel={() => setFormOpen(false)}
          busy={saving}
        />
      )}

      {editing && (
        <TransactionForm
          initial={editing}
          knownTickers={knownTickers}
          onSubmit={handleUpdate}
          onCancel={() => setEditing(null)}
          busy={saving}
        />
      )}

      {transactions.length > 0 && (
        <FiltersBar filters={filters} setFilters={setFilters} />
      )}

      {visible.length === 0 ? (
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.borderSoft}`,
            padding: 32,
            textAlign: "center",
            fontFamily: FONT_MONO,
            fontSize: 12,
            color: T.textDim,
            letterSpacing: "0.08em",
          }}
        >
          {transactions.length === 0
            ? "No transactions yet - tap New to add your first."
            : "No matches for current filters."}
        </div>
      ) : (
        <div>
          {visible.map((tx) => (
            <TxRow
              key={tx.id}
              tx={tx}
              onEdit={(t) => {
                setEditing(t);
                setFormOpen(false);
              }}
              onDelete={handleDelete}
              busy={saving}
            />
          ))}
        </div>
      )}

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onConfirm={handleImport}
        existingCount={transactions.length}
      />
    </div>
  );
}
