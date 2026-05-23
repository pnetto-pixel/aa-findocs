// src/Transactions.jsx
// Chunk 1B: add form, chronological list, inline edit, direct delete, filters.
// Bulk paste + CSV upload land in 1C.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Pencil, X, Check, Search } from "lucide-react";

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

// --- Main view -------------------------------------------------------------

export default function TransactionsView({ auth, onAuthFail, knownTickers = [] }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null); // tx | null
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
    </div>
  );
}
