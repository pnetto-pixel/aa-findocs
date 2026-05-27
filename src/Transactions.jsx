// src/Transactions.jsx
// Chunk 1B: add form, chronological list, inline edit, direct delete, filters.
// Bulk paste + CSV upload land in 1C.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Pencil, X, Check, Upload, Download } from "lucide-react";
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

function TransactionForm({ initial, knownTickers, onSubmit, onCancel, busy }) {
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

  const currency = currencyForAssetClass(assetClass) || "USD";

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
                    {tx.ticker}
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

  // Asset class: explicit field wins; else infer from ticker.
  // If neither resolves, mark needsAssetClass so user picks in preview.
  let assetClass = normalizeAssetClass(row.assetClass);
  let needsAssetClass = false;
  if (!assetClass && ticker) {
    const inferred = inferCurrency(ticker);
    if (inferred === "BRL") assetClass = "BRA Stocks";
    else if (inferred === "USD") assetClass = "Stocks";
    else needsAssetClass = true;
  } else if (!assetClass) {
    needsAssetClass = true;
  }
  const currency = assetClass ? currencyForAssetClass(assetClass) : defaultCurrency;

  if (row.assetClass && !assetClass) {
    errors.push(`assetClass: unknown "${row.assetClass}"`);
  }

  const ambiguous = qty.ambiguous || price.ambiguous || fee.ambiguous;

  if (errors.length > 0) {
    return { ok: false, tx: null, errors, ambiguous, needsAssetClass, rawNumbers };
  }

  return {
    ok: !needsAssetClass,
    errors: needsAssetClass ? ["assetClass: pick one"] : [],
    ambiguous,
    needsAssetClass,
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
function parseFidelityCSV(text) {
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
  const idxPrice = colOf("Price ($)");
  const idxQty = colOf("Quantity");
  const idxFees = colOf("Fees ($)");

  if (idxDate < 0 || idxAction < 0 || idxSymbol < 0 || idxPrice < 0 || idxQty < 0) {
    return { results: [], hadHeader: true, rawRows: [], sourceText: text, error: "Required Fidelity columns missing" };
  }

  const results = [];
  const rawRows = [];
  for (let i = headerIdx + 1; i < result.data.length; i++) {
    const arr = result.data[i];
    if (!arr || arr.length === 0) continue;
    const action = String(arr[idxAction] || "").trim();
    const upper = action.toUpperCase();
    let side = null;
    if (upper.startsWith("YOU BOUGHT")) side = "buy";
    else if (upper.startsWith("YOU SOLD")) side = "sell";
    else continue; // skip dividends, contributions, interest, redemptions, etc.

    const rawDate = String(arr[idxDate] || "").trim();
    // Fidelity dates are always MM/DD/YYYY (US format). Override the
    // BR-default parseDate which would interpret 05/08/2026 as DMY.
    const mdy = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    let isoDate = null;
    if (mdy) {
      let [, mo, d, y] = mdy;
      if (y.length === 2) y = (parseInt(y, 10) > 50 ? "19" : "20") + y;
      mo = mo.padStart(2, "0");
      d = d.padStart(2, "0");
      const yi = parseInt(y, 10);
      const mi = parseInt(mo, 10);
      const di = parseInt(d, 10);
      if (mi >= 1 && mi <= 12 && di >= 1 && di <= 31 && yi >= 1900 && yi <= 2100) {
        const dt = new Date(yi, mi - 1, di);
        if (dt.getFullYear() === yi && dt.getMonth() === mi - 1 && dt.getDate() === di) {
          isoDate = `${y}-${mo}-${d}`;
        }
      }
    }
    if (!isoDate) continue; // skip malformed rows silently

    const symbol = String(arr[idxSymbol] || "").trim().toUpperCase();
    if (!symbol) continue;

    const priceN = parseFloat(String(arr[idxPrice] || "").replace(/[$,\s]/g, ""));
    if (!isFinite(priceN) || priceN < 0) continue;

    const qtyRaw = parseFloat(String(arr[idxQty] || "").replace(/[,\s]/g, ""));
    if (!isFinite(qtyRaw) || qtyRaw === 0) continue;
    const qty = Math.abs(qtyRaw);

    let fee = 0;
    if (idxFees >= 0) {
      const fn = parseFloat(String(arr[idxFees] || "").replace(/[$,\s]/g, ""));
      if (isFinite(fn) && fn > 0) fee = fn;
    }

    // Default Fidelity transactions to "Stocks" assetClass. User can edit
    // afterwards if it's a bond (e.g. CD), since CDs come through as symbols
    // like 949764WE0 that we can't reliably classify.
    const tx = {
      id: newId(),
      date: isoDate,
      side,
      ticker: symbol,
      assetClass: "Stocks",
      qty,
      price: priceN,
      currency: "USD",
      fee,
      notes: "",
      createdAt: new Date().toISOString(),
    };

    results.push({
      ok: true,
      errors: [],
      ambiguous: false,
      needsAssetClass: false,
      rawNumbers: { qty: qtyRaw, price: priceN, fee },
      tx,
    });
    rawRows.push(arr);
  }

  return { results, hadHeader: true, rawRows, sourceText: text };
}

function ImportModal({ open, onClose, onConfirm, existingCount }) {
  const [tab, setTab] = useState("upload"); // upload | fidelity
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
      setTab("upload");
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
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      // Strip BOM if present.
      let content = String(ev.target?.result || "");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      setText(content);
      const out = parseFidelityCSV(content);
      if (out.error || out.results.length === 0) {
        setFileError(out.error || "No BUY/SELL transactions found in this Fidelity file");
        setParsed(null);
        return;
      }
      setParsed({
        results: out.results,
        hadHeader: true,
        rawRows: out.rawRows,
        sourceText: content,
        sourceLabel: "Fidelity",
      });
      setDecimalPrompt(false);
      setStructuralPrompt(false);
      setFileError("");
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
  const errorCount = parsed
    ? parsed.results.filter((r) => !r.ok && !r.needsAssetClass).length
    : 0;
  const needsAssetClassCount = parsed
    ? parsed.results.filter((r) => r.needsAssetClass).length
    : 0;

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
                  <Label>Select your Fidelity "Accounts History" CSV</Label>
                  <input
                    type="file"
                    accept=".csv,text/csv,text/plain"
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
                    Imports only YOU BOUGHT / YOU SOLD rows. Dividends,
                    contributions, interest, and redemptions are skipped. All
                    transactions are assigned to USD and Asset Class "Stocks"
                    (you can edit CDs/bonds afterward).
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

export default function TransactionsView({ auth, onAuthFail, knownTickers = [], valuesHidden }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null); // tx | null
  const [importOpen, setImportOpen] = useState(false);
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
        const raw = Array.isArray(data.transactions) ? data.transactions : [];
        // Backfill assetClass on legacy records via inferCurrency.
        const migrated = raw.map((t) => {
          if (t.assetClass) return t;
          const inferred = inferCurrency(t.ticker);
          let cls = null;
          if (inferred === "BRL") cls = "BRA Stocks";
          else if (inferred === "USD") cls = "Stocks";
          else cls = t.currency === "BRL" ? "Unallocated BRL" : "Unallocated USD";
          return { ...t, assetClass: cls };
        });
        setTransactions(migrated);
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

      <TransactionTable
        transactions={transactions}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        onBulkDelete={handleBulkDelete}
        onBulkAssetClass={handleBulkAssetClass}
        busy={saving}
        valuesHidden={valuesHidden}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onConfirm={handleImport}
        existingCount={transactions.length}
      />
    </div>
  );
}
