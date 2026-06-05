// src/Dividends.jsx
// Tab: Dividends / Income
// Item 17: Bar chart — income evolution (Year | 6M | Quarter | Month)
// Item 18: Month × year breakdown table
// Manual income form: coupons (Tesouro, Bank Bonds) + dividends/JCP (BRA Stocks)

import { useState, useEffect, useMemo } from "react";
import { Plus, Trash2, ChevronDown, X } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_BODY = "'Manrope', system-ui, sans-serif";
const FONT_MONO = "'JetBrains Mono', 'Geist Mono', monospace";

const T = {
  bg: "#0b0d10",
  card: "#13161b",
  cardElev: "#191d24",
  border: "#222831",
  borderSoft: "#1a1e25",
  text: "#ece8e0",
  textDim: "#8a8f99",
  textFaint: "#5a5f69",
  gold: "#c9a961",
  goldDim: "#7a6840",
  green: "#7dd3a4",
  red: "#e88c8c",
  greenBg: "rgba(125, 211, 164, 0.08)",
};

const PERIOD_OPTIONS = ["Month", "Quarter", "6M", "Year"];

// Asset classes that make sense for manual income
const MANUAL_ASSET_CLASSES = [
  "BRA Stocks",
  "BRA Fixed Income",
  "Bank Bonds",
  "Stocks",
  "Real Estate",
  "Bonds",
  "Alternative",
];

// Default incomeType per assetClass
const DEFAULT_INCOME_TYPE = {
  "BRA Stocks": "dividend",
  "BRA Fixed Income": "coupon",
  "Bank Bonds": "coupon",
  "Stocks": "dividend",
  "Real Estate": "dividend",
  "Bonds": "dividend",
  "Alternative": "dividend",
};

// Currency per assetClass
const CURRENCY_FOR_CLASS = {
  "BRA Stocks": "BRL",
  "BRA Fixed Income": "BRL",
  "Bank Bonds": "USD",
  "Stocks": "USD",
  "Real Estate": "USD",
  "Bonds": "USD",
  "Alternative": "USD",
};

const INCOME_TYPE_LABELS = {
  dividend: "Dividend",
  jcp: "JCP",
  coupon: "Coupon",
};

const EMPTY_FORM = {
  date: new Date().toISOString().slice(0, 10),
  ticker: "",
  assetClass: "BRA Stocks",
  incomeType: "dividend",
  totalReceived: "",
  currency: "BRL",
  notes: "",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

function fmtUSD(n, hidden) {
  if (hidden) return "$ ••••";
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtBRL(n, hidden) {
  if (hidden) return "R$ ••••";
  if (n == null || isNaN(n)) return "—";
  return `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtAxisUSD(n) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function toUSD(totalReceived, currency, usdBrlRate) {
  if (currency === "BRL" && usdBrlRate > 0) return totalReceived / usdBrlRate;
  return totalReceived;
}

// Returns the first date to include given the current period selector.
function periodFromDate(period) {
  const now = new Date();
  let monthsBack;
  if (period === "Month") monthsBack = 0;
  else if (period === "Quarter") monthsBack = 2;
  else if (period === "6M") monthsBack = 5;
  else monthsBack = 11; // Year
  const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  return d.toISOString().slice(0, 10);
}

// Bar chart data: one bar per month within the period.
function buildBarData(allEventsUSD, fromDate) {
  const byMonth = {};
  for (const e of allEventsUSD) {
    if (e.date < fromDate) continue;
    const m = e.date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + e.totalReceivedUSD;
  }

  // Fill every month in range (even empty ones) for a clean chart.
  const result = [];
  const start = new Date(fromDate.slice(0, 7) + "-01T00:00:00Z");
  const now = new Date();
  const endKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const cur = new Date(start);
  while (true) {
    const key = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`;
    if (key > endKey) break;
    const label = cur.toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });
    result.push({ label, value: byMonth[key] || 0 });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return result;
}

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Month × year table: rows = years desc, cols = Jan-Dec + Total + Avg.
function buildTableData(allEventsUSD) {
  const byYearMonth = {};
  for (const e of allEventsUSD) {
    const y = parseInt(e.date.slice(0, 4), 10);
    const m = parseInt(e.date.slice(5, 7), 10);
    if (!byYearMonth[y]) byYearMonth[y] = {};
    byYearMonth[y][m] = (byYearMonth[y][m] || 0) + e.totalReceivedUSD;
  }
  return Object.keys(byYearMonth)
    .map(Number)
    .sort((a, b) => b - a)
    .map((y) => {
      const months = byYearMonth[y];
      const total = Object.values(months).reduce((s, v) => s + v, 0);
      const count = Object.keys(months).length;
      return { year: y, months, total, avg: count > 0 ? total / count : 0 };
    });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CardToggle({ label, sub, open, onToggle }) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: "14px 20px",
        textAlign: "left",
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: T.gold,
            fontWeight: 600,
          }}
        >
          {label}
        </span>
        {sub && (
          <span style={{ fontFamily: FONT_BODY, fontSize: 12, color: T.textDim }}>
            {sub}
          </span>
        )}
      </span>
      <ChevronDown
        size={16}
        color={T.gold}
        style={{
          transform: open ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 0.2s",
          flexShrink: 0,
        }}
      />
    </button>
  );
}

function BarChartTooltip({ active, payload, label, hidden }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: "#191d24",
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        padding: "8px 12px",
        fontFamily: FONT_MONO,
        fontSize: 12,
        color: T.text,
      }}
    >
      <div style={{ color: T.textDim, marginBottom: 4 }}>{label}</div>
      <div style={{ color: T.gold }}>{fmtUSD(payload[0].value, hidden)}</div>
    </div>
  );
}

function KpiCard({ label, value, sub }) {
  return (
    <div
      style={{
        background: T.cardElev,
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        padding: "12px 16px",
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: T.textDim,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 18,
          fontWeight: 600,
          color: T.text,
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginTop: 3 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ── AddIncomeForm ─────────────────────────────────────────────────────────────

function AddIncomeForm({ knownTickers, onSave, onCancel, saving }) {
  const [form, setForm] = useState({ ...EMPTY_FORM });

  function set(key, val) {
    setForm((prev) => {
      const next = { ...prev, [key]: val };
      if (key === "assetClass") {
        next.incomeType = DEFAULT_INCOME_TYPE[val] || "dividend";
        next.currency = CURRENCY_FOR_CLASS[val] || "USD";
      }
      return next;
    });
  }

  function valid() {
    return form.date && form.ticker.trim() && form.assetClass &&
      form.incomeType && parseFloat(form.totalReceived) > 0;
  }

  function handleSave() {
    if (!valid()) return;
    onSave({
      id: crypto.randomUUID(),
      date: form.date,
      ticker: form.ticker.trim().toUpperCase(),
      assetClass: form.assetClass,
      incomeType: form.incomeType,
      totalReceived: parseFloat(form.totalReceived),
      currency: form.currency,
      notes: form.notes.trim(),
      createdAt: new Date().toISOString(),
      source: "manual",
    });
  }

  const inputStyle = {
    background: T.cardElev,
    border: `1px solid ${T.border}`,
    borderRadius: 4,
    color: T.text,
    fontFamily: FONT_MONO,
    fontSize: 13,
    padding: "6px 10px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
    colorScheme: "dark",
  };

  const selectStyle = { ...inputStyle, cursor: "pointer" };

  const labelStyle = {
    fontFamily: FONT_BODY,
    fontSize: 11,
    color: T.textDim,
    marginBottom: 4,
    display: "block",
  };

  return (
    <div
      style={{
        background: T.cardElev,
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        padding: 16,
        marginTop: 12,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: T.gold,
          marginBottom: 14,
        }}
      >
        Add Income
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <label style={labelStyle}>Date</label>
          <input
            type="date"
            value={form.date}
            onChange={(e) => set("date", e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle}>Ticker</label>
          <input
            type="text"
            value={form.ticker}
            onChange={(e) => set("ticker", e.target.value)}
            placeholder="BBSE3, tesouro-ipca…"
            list="div-ticker-list"
            style={inputStyle}
          />
          <datalist id="div-ticker-list">
            {knownTickers.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>

        <div>
          <label style={labelStyle}>Asset Class</label>
          <select
            value={form.assetClass}
            onChange={(e) => set("assetClass", e.target.value)}
            style={selectStyle}
          >
            {MANUAL_ASSET_CLASSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={labelStyle}>Type</label>
          <select
            value={form.incomeType}
            onChange={(e) => set("incomeType", e.target.value)}
            style={selectStyle}
          >
            <option value="dividend">Dividend</option>
            <option value="jcp">JCP</option>
            <option value="coupon">Coupon</option>
          </select>
        </div>

        <div>
          <label style={labelStyle}>
            Amount ({form.currency})
          </label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.totalReceived}
            onChange={(e) => set("totalReceived", e.target.value)}
            placeholder="0.00"
            style={{ ...inputStyle, textAlign: "right" }}
          />
        </div>

        <div>
          <label style={labelStyle}>Currency</label>
          <select
            value={form.currency}
            onChange={(e) => set("currency", e.target.value)}
            style={selectStyle}
          >
            <option value="USD">USD</option>
            <option value="BRL">BRL</option>
          </select>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <label style={labelStyle}>Notes (optional)</label>
        <input
          type="text"
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="e.g. 2nd coupon 2025, 6.25% p.a."
          style={inputStyle}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{
            background: "none",
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            color: T.textDim,
            fontFamily: FONT_BODY,
            fontSize: 13,
            padding: "7px 16px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!valid() || saving}
          style={{
            background: valid() && !saving ? T.gold : T.goldDim,
            border: "none",
            borderRadius: 4,
            color: "#0b0d10",
            fontFamily: FONT_BODY,
            fontWeight: 600,
            fontSize: 13,
            padding: "7px 20px",
            cursor: valid() && !saving ? "pointer" : "default",
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DividendsView({ auth, onAuthFail, valuesHidden }) {
  const [transactions, setTransactions] = useState([]);
  const [manualEntries, setManualEntries] = useState([]);
  const [autoEvents, setAutoEvents] = useState([]);
  const [usdBrlRate, setUsdBrlRate] = useState(null);

  const [loading, setLoading] = useState(true);
  const [autoLoading, setAutoLoading] = useState(false);
  const [error, setError] = useState(null);

  const [period, setPeriod] = useState("Year");
  const [chartOpen, setChartOpen] = useState(true);
  const [tableOpen, setTableOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(true);
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const headers = authHeaders(auth);

  // Load transactions + manual entries on mount; then auto dividends from transactions.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // Step 1: fetch transactions + manual in parallel
        const [txRes, manualRes] = await Promise.all([
          fetch("/api/transactions", { headers }),
          fetch("/api/income-manual", { headers }),
        ]);

        if (txRes.status === 401 || manualRes.status === 401) {
          onAuthFail?.();
          return;
        }
        if (!txRes.ok) throw new Error(`Transactions: ${txRes.status}`);
        if (!manualRes.ok) throw new Error(`Income manual: ${manualRes.status}`);

        const txData = await txRes.json();
        const manualData = await manualRes.json();

        const txs = Array.isArray(txData.transactions) ? txData.transactions : [];
        const manual = Array.isArray(manualData.entries) ? manualData.entries : [];

        if (!cancelled) {
          setTransactions(txs);
          setManualEntries(manual);
          setLoading(false);
        }

        // Step 2: fetch FX if any BRL manual entries exist
        if (manual.some((e) => e.currency === "BRL")) {
          fetch("/api/price?fx=USDBRL", { headers })
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              if (!cancelled && d?.price > 0) setUsdBrlRate(d.price);
            })
            .catch(() => {});
        }

        // Step 3: auto dividends from Yahoo (may take a few seconds)
        if (txs.length) {
          if (!cancelled) setAutoLoading(true);
          try {
            const divRes = await fetch("/api/dividends", {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({ transactions: txs }),
            });
            if (divRes.status === 401) { onAuthFail?.(); return; }
            if (divRes.ok) {
              const divData = await divRes.json();
              if (!cancelled) setAutoEvents(Array.isArray(divData.events) ? divData.events : []);
            }
          } catch {}
          if (!cancelled) setAutoLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Unified events list with USD conversion applied.
  const allEventsUSD = useMemo(() => {
    const manual = manualEntries.map((e) => ({
      ...e,
      totalReceivedUSD: toUSD(e.totalReceived, e.currency, usdBrlRate),
    }));
    const auto = autoEvents.map((e) => ({ ...e, totalReceivedUSD: e.totalReceived }));
    return [...auto, ...manual].sort((a, b) => b.date.localeCompare(a.date));
  }, [autoEvents, manualEntries, usdBrlRate]);

  // KPIs
  const kpis = useMemo(() => {
    const thisYear = new Date().getFullYear();
    const thisMonth = new Date().toISOString().slice(0, 7);
    let allTime = 0, ytd = 0, thisMonthTotal = 0;
    for (const e of allEventsUSD) {
      allTime += e.totalReceivedUSD;
      if (e.date.startsWith(String(thisYear))) ytd += e.totalReceivedUSD;
      if (e.date.startsWith(thisMonth)) thisMonthTotal += e.totalReceivedUSD;
    }
    return { allTime, ytd, thisMonth: thisMonthTotal };
  }, [allEventsUSD]);

  // Bar chart data
  const fromDate = periodFromDate(period);
  const barData = useMemo(() => buildBarData(allEventsUSD, fromDate), [allEventsUSD, fromDate]);
  const tableData = useMemo(() => buildTableData(allEventsUSD), [allEventsUSD]);

  // Known tickers for the add form autocomplete
  const knownTickers = useMemo(
    () => [...new Set(transactions.map((tx) => tx.ticker).filter(Boolean))].sort(),
    [transactions]
  );

  async function saveManual(newEntry) {
    setSaving(true);
    const updated = [...manualEntries, newEntry];
    try {
      const r = await fetch("/api/income-manual", {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ entries: updated }),
      });
      if (r.status === 401) { onAuthFail?.(); return; }
      if (!r.ok) throw new Error(`Save failed: ${r.status}`);
      setManualEntries(updated);
      setAddFormOpen(false);
    } catch (err) {
      alert(`Error saving: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function deleteManual(id) {
    const updated = manualEntries.filter((e) => e.id !== id);
    try {
      const r = await fetch("/api/income-manual", {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ entries: updated }),
      });
      if (r.status === 401) { onAuthFail?.(); return; }
      if (r.ok) setManualEntries(updated);
    } catch {}
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: T.textDim, fontFamily: FONT_BODY }}>
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: T.red, fontFamily: FONT_BODY }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "0 16px 48px" }}>
      {/* Header */}
      <div style={{ padding: "24px 0 16px" }}>
        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 22,
            fontWeight: 600,
            color: T.text,
            margin: 0,
          }}
        >
          Dividends &amp; Income
        </h2>
        <p style={{ fontFamily: FONT_BODY, fontSize: 12, color: T.textDim, margin: "6px 0 0" }}>
          US dividends auto-fetched · BRA income entered manually
          {autoLoading && (
            <span style={{ color: T.gold, marginLeft: 8 }}>Fetching US dividends…</span>
          )}
        </p>
      </div>

      {/* KPI row */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        <KpiCard
          label="All Time"
          value={fmtUSD(kpis.allTime, valuesHidden)}
        />
        <KpiCard
          label="YTD"
          value={fmtUSD(kpis.ytd, valuesHidden)}
        />
        <KpiCard
          label="This Month"
          value={fmtUSD(kpis.thisMonth, valuesHidden)}
        />
      </div>

      {/* Period selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {PERIOD_OPTIONS.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              background: period === p ? T.gold : "transparent",
              border: `1px solid ${period === p ? T.gold : T.border}`,
              borderRadius: 4,
              color: period === p ? "#0b0d10" : T.textDim,
              fontFamily: FONT_MONO,
              fontSize: 12,
              fontWeight: period === p ? 700 : 400,
              padding: "6px 14px",
              cursor: "pointer",
            }}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Income History chart card */}
      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 8,
          marginBottom: 12,
          overflow: "hidden",
        }}
      >
        <CardToggle
          label="Income History"
          sub={`${period} view · ${barData.filter((d) => d.value > 0).length} months with income`}
          open={chartOpen}
          onToggle={() => setChartOpen((v) => !v)}
        />

        {chartOpen && (
          <div style={{ padding: "0 16px 20px" }}>
            {barData.every((d) => d.value === 0) ? (
              <div
                style={{
                  padding: "24px 0",
                  textAlign: "center",
                  color: T.textDim,
                  fontFamily: FONT_BODY,
                  fontSize: 13,
                }}
              >
                No income recorded in this period.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={barData}
                  margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
                >
                  <CartesianGrid vertical={false} stroke={T.border} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: T.textDim, fontSize: 10, fontFamily: FONT_MONO }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={fmtAxisUSD}
                    tick={{ fill: T.textDim, fontSize: 10, fontFamily: FONT_MONO }}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                  />
                  <Tooltip
                    content={<BarChartTooltip hidden={valuesHidden} />}
                    cursor={{ fill: "rgba(201,169,97,0.08)" }}
                  />
                  <Bar dataKey="value" fill={T.gold} radius={[2, 2, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        )}
      </div>

      {/* Monthly Breakdown table card (Item 18) */}
      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 8,
          marginBottom: 12,
          overflow: "hidden",
        }}
      >
        <CardToggle
          label="Monthly Breakdown"
          sub={tableData.length > 0 ? `${tableData.length} year${tableData.length > 1 ? "s" : ""}` : "No data"}
          open={tableOpen}
          onToggle={() => setTableOpen((v) => !v)}
        />

        {tableOpen && (
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            {tableData.length === 0 ? (
              <div
                style={{
                  padding: "20px 20px 24px",
                  color: T.textDim,
                  fontFamily: FONT_BODY,
                  fontSize: 13,
                }}
              >
                No income data yet.
              </div>
            ) : (
              <table
                style={{
                  borderCollapse: "collapse",
                  minWidth: 780,
                  width: "100%",
                  tableLayout: "fixed",
                }}
              >
                <colgroup>
                  <col style={{ width: 54 }} />
                  {MONTHS_SHORT.map((_, i) => (
                    <col key={i} style={{ width: 52 }} />
                  ))}
                  <col style={{ width: 72 }} />
                  <col style={{ width: 64 }} />
                </colgroup>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                    <th
                      style={{
                        padding: "8px 10px",
                        textAlign: "left",
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: T.textDim,
                        fontWeight: 600,
                        position: "sticky",
                        left: 0,
                        background: T.card,
                        letterSpacing: "0.08em",
                      }}
                    >
                      Year
                    </th>
                    {MONTHS_SHORT.map((m) => (
                      <th
                        key={m}
                        style={{
                          padding: "8px 4px",
                          textAlign: "right",
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          color: T.textDim,
                          fontWeight: 600,
                          letterSpacing: "0.06em",
                        }}
                      >
                        {m}
                      </th>
                    ))}
                    <th
                      style={{
                        padding: "8px 10px 8px 4px",
                        textAlign: "right",
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: T.gold,
                        fontWeight: 600,
                        letterSpacing: "0.08em",
                      }}
                    >
                      Total
                    </th>
                    <th
                      style={{
                        padding: "8px 10px 8px 4px",
                        textAlign: "right",
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: T.textDim,
                        fontWeight: 600,
                        letterSpacing: "0.06em",
                      }}
                    >
                      Avg/mo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tableData.map((row, ri) => (
                    <tr
                      key={row.year}
                      style={{ borderBottom: `1px solid ${T.borderSoft}` }}
                    >
                      <td
                        style={{
                          padding: "7px 10px",
                          fontFamily: FONT_MONO,
                          fontSize: 12,
                          fontWeight: 600,
                          color: T.gold,
                          position: "sticky",
                          left: 0,
                          background: ri % 2 === 0 ? T.card : "#111418",
                        }}
                      >
                        {row.year}
                      </td>
                      {MONTHS_SHORT.map((_, mi) => {
                        const val = row.months[mi + 1];
                        return (
                          <td
                            key={mi}
                            style={{
                              padding: "7px 4px",
                              textAlign: "right",
                              fontFamily: FONT_MONO,
                              fontSize: 11,
                              color: val ? T.text : T.textFaint,
                            }}
                          >
                            {val ? (valuesHidden ? "•••" : `$${val.toFixed(0)}`) : "—"}
                          </td>
                        );
                      })}
                      <td
                        style={{
                          padding: "7px 10px 7px 4px",
                          textAlign: "right",
                          fontFamily: FONT_MONO,
                          fontSize: 12,
                          fontWeight: 600,
                          color: T.green,
                        }}
                      >
                        {valuesHidden ? "$ ••••" : `$${row.total.toFixed(0)}`}
                      </td>
                      <td
                        style={{
                          padding: "7px 10px 7px 4px",
                          textAlign: "right",
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          color: T.textDim,
                        }}
                      >
                        {valuesHidden ? "•••" : `$${row.avg.toFixed(0)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Manual Income card */}
      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {/* Header row with Add button */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <CardToggle
              label="Manual Income"
              sub={`${manualEntries.length} entr${manualEntries.length === 1 ? "y" : "ies"} · coupons, BRA dividends`}
              open={manualOpen}
              onToggle={() => setManualOpen((v) => !v)}
            />
          </div>
          <button
            onClick={() => { setManualOpen(true); setAddFormOpen(true); }}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "0 16px",
              color: T.gold,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
            title="Add income entry"
          >
            <Plus size={16} />
          </button>
        </div>

        {manualOpen && (
          <div style={{ padding: "0 16px 16px" }}>
            {addFormOpen && (
              <AddIncomeForm
                knownTickers={knownTickers}
                onSave={saveManual}
                onCancel={() => setAddFormOpen(false)}
                saving={saving}
              />
            )}

            {manualEntries.length === 0 && !addFormOpen ? (
              <div
                style={{
                  padding: "12px 0",
                  color: T.textDim,
                  fontFamily: FONT_BODY,
                  fontSize: 13,
                }}
              >
                No manual entries yet. Add coupons (Tesouro IPCA, Bank Bonds) or BRA dividends here.
              </div>
            ) : (
              <div style={{ marginTop: addFormOpen ? 12 : 0 }}>
                {[...manualEntries]
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .map((entry) => (
                    <div
                      key={entry.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "9px 0",
                        borderBottom: `1px solid ${T.borderSoft}`,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            style={{
                              fontFamily: FONT_MONO,
                              fontSize: 12,
                              fontWeight: 600,
                              color: T.text,
                            }}
                          >
                            {entry.ticker}
                          </span>
                          <span
                            style={{
                              fontFamily: FONT_MONO,
                              fontSize: 10,
                              color: T.textDim,
                              background: T.cardElev,
                              border: `1px solid ${T.border}`,
                              borderRadius: 3,
                              padding: "1px 5px",
                              textTransform: "uppercase",
                              letterSpacing: "0.06em",
                            }}
                          >
                            {INCOME_TYPE_LABELS[entry.incomeType] || entry.incomeType}
                          </span>
                          <span
                            style={{
                              fontFamily: FONT_MONO,
                              fontSize: 12,
                              color: T.green,
                              fontWeight: 600,
                            }}
                          >
                            {entry.currency === "BRL"
                              ? fmtBRL(entry.totalReceived, valuesHidden)
                              : fmtUSD(entry.totalReceived, valuesHidden)}
                          </span>
                          {entry.currency === "BRL" && usdBrlRate > 0 && (
                            <span
                              style={{
                                fontFamily: FONT_MONO,
                                fontSize: 11,
                                color: T.textFaint,
                              }}
                            >
                              ≈ {fmtUSD(entry.totalReceived / usdBrlRate, valuesHidden)}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontFamily: FONT_BODY,
                            fontSize: 11,
                            color: T.textFaint,
                            marginTop: 2,
                          }}
                        >
                          {entry.date} · {entry.assetClass}
                          {entry.notes ? ` · ${entry.notes}` : ""}
                        </div>
                      </div>
                      <button
                        onClick={() => deleteManual(entry.id)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: T.textFaint,
                          padding: 4,
                          flexShrink: 0,
                        }}
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
