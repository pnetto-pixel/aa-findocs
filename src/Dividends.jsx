// src/Dividends.jsx
// Tab: Dividends / Income — US assets only (Yahoo Finance, keyless).
// Item 17: Income History — collapsible card with KPIs inside, bar chart
//          with Month | Quarter | Half | Year views + date range filter.
// Item 18: (kept in monthly grouping of the chart)
// Position Dividends: per-ticker total, YTD, Y/Y YTD growth, yield on cost.
// Dividend History: full audit table of every payment.

import { useState, useEffect, useMemo, useRef, Fragment } from "react";
import { ChevronDown, TrendingUp, BarChart2, Receipt } from "lucide-react";
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
  green: "#7dd3a4",
  red: "#e88c8c",
};

const PERIOD_OPTIONS = ["Month", "Quarter", "Half", "Year"];

const TICKER_COL_WIDTH = 92;

// ── Helpers ──────────────────────────────────────────────────────────────────

function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
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

function fmtUSD0(n, hidden) {
  if (hidden) return "$ ••••";
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtAxisUSD(n) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtYoc(n) {
  if (n == null || isNaN(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function fmtPerShare(n, hidden) {
  if (hidden) return "••••";
  if (n == null || isNaN(n)) return "—";
  return `$${n.toFixed(4).replace(/\.?0+$/, "")}`;
}

function fmtQty(n) {
  if (n == null || isNaN(n)) return "—";
  const r = Math.round(n * 10000) / 10000;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(4).replace(/\.?0+$/, "");
}

function growthColor(n) {
  if (n == null || isNaN(n)) return T.textDim;
  if (n > 0) return T.green;
  if (n < 0) return T.red;
  return T.textDim;
}

function fmtDeltaUSD(n, hidden) {
  if (hidden) return "$ ••••";
  if (n == null || isNaN(n)) return "—";
  const prefix = n > 0 ? "+" : "";
  return prefix + new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// ── Bank Bonds estimated accrual (item 36) ────────────────────────────────────
// CDs / US bank bonds pay periodic coupons but there is no free per-CUSIP
// payment history API. We estimate accrued interest on the fly from the
// buy/sell transactions plus the coupon% + maturity stored in `notes` by the
// Fidelity parser ("5.45% | 03/15/2027").
//
// Per CUSIP we replay buy/sell events chronologically tracking the running
// principal, and accrue principal x coupon x (days / 365) over each interval up
// to min(today, maturity). Partial sells reduce the running principal so the
// remaining accrual reflects the outstanding position (planner-accepted model:
// accrual over the net principal vigente per period). Transactions with no
// coupon/maturity in notes are skipped silently.
//
// Returns { byMonth: { "YYYY-MM": amount }, allTime } — all amounts in USD.
// Bucketed by month so KPIs (All Time / YTD / This Month) can reuse the same
// date-prefix logic as real dividend events.
// Prefers dedicated fields added by the Fidelity parser (couponRate, maturityDate);
// falls back to parsing the legacy notes string "5.45% | 03/15/2027".
function parseBondNotes(tx) {
  // New dedicated fields (parser v2+)
  if (tx.couponRate != null && tx.maturityDate) {
    const couponPct = Number(tx.couponRate);
    if (isFinite(couponPct) && couponPct > 0 && /^\d{4}-\d{2}-\d{2}$/.test(tx.maturityDate)) {
      return { couponPct, maturityISO: tx.maturityDate };
    }
  }
  // Legacy fallback: parse from notes string
  const notes = tx.notes || "";
  if (!notes) return null;
  const m = String(notes).match(/(\d+(?:\.\d+)?)\s*%\s*\|\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const couponPct = parseFloat(m[1]);
  if (!isFinite(couponPct) || couponPct <= 0) return null;
  const maturityISO = `${m[4]}-${m[2]}-${m[3]}`;
  return { couponPct, maturityISO };
}

function daysBetweenISO(a, b) {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  if (isNaN(da) || isNaN(db)) return 0;
  return Math.max(0, (db - da) / 86400000);
}

function minISO(a, b) {
  return a < b ? a : b;
}

function computeBankBondsAccrual(transactions, todayISO) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  // Group Bank Bonds transactions by CUSIP/ticker.
  const byCusip = {};
  for (const tx of transactions || []) {
    if (!tx || (tx.assetClass || "") !== "Bank Bonds") continue;
    const meta = parseBondNotes(tx);
    if (!meta) continue; // no coupon/maturity -> skip silently
    const t = (tx.ticker || "").toUpperCase();
    if (!t) continue;
    const qty = Number(tx.qty);
    const price = Number(tx.price);
    if (!isFinite(qty) || !isFinite(price)) continue;
    if (!byCusip[t]) byCusip[t] = { events: [], coupon: meta.couponPct, maturityISO: meta.maturityISO };
    // Use the latest non-null coupon/maturity we see for this CUSIP.
    byCusip[t].coupon = meta.couponPct;
    byCusip[t].maturityISO = meta.maturityISO;
    byCusip[t].events.push({
      date: tx.date,
      principalDelta: (tx.side === "sell" ? -1 : 1) * qty * price,
    });
  }

  const byMonth = {};
  let allTime = 0;

  for (const t of Object.keys(byCusip)) {
    const { events, coupon, maturityISO } = byCusip[t];
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Accrual horizon for this CUSIP ends at maturity or today, whichever first.
    const endISO = minISO(maturityISO, today);
    const rate = coupon / 100;

    let principal = 0;
    for (let i = 0; i < events.length; i++) {
      // Apply this event's principal change at its date.
      principal += events[i].principalDelta;
      if (principal < 0) principal = 0; // never accrue on negative principal
      const segStart = events[i].date;
      const segEnd = i + 1 < events.length ? events[i + 1].date : endISO;
      if (segEnd <= segStart || principal <= 0) continue;
      // Clamp the segment to the accrual horizon.
      const clampedEnd = minISO(segEnd, endISO);
      if (clampedEnd <= segStart) continue;
      accrueSegment(byMonth, segStart, clampedEnd, principal, rate);
    }
  }

  for (const k of Object.keys(byMonth)) allTime += byMonth[k];
  return { byMonth, allTime };
}

// Spread principal x rate x days/365 across the calendar months the interval
// touches, attributing each month's portion to that month's bucket.
function accrueSegment(byMonth, startISO, endISO, principal, rate) {
  let cursor = startISO;
  while (cursor < endISO) {
    // First day of next month after `cursor`.
    const [y, m] = cursor.split("-");
    const yi = parseInt(y, 10);
    const mi = parseInt(m, 10);
    const nextMonth = mi === 12 ? `${yi + 1}-01-01` : `${yi}-${String(mi + 1).padStart(2, "0")}-01`;
    const chunkEnd = minISO(nextMonth, endISO);
    const days = daysBetweenISO(cursor, chunkEnd);
    if (days > 0) {
      const key = cursor.slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + principal * rate * (days / 365);
    }
    cursor = chunkEnd;
  }
}

// Full history grouped by the chosen granularity, optional date filter.
function buildChartData(events, groupBy, selectedYears) {
  const filtered = events.filter((e) => {
    if (!e.date) return false;
    if (selectedYears.size > 0 && !selectedYears.has(e.date.slice(0, 4))) return false;
    return true;
  });
  if (!filtered.length) return [];

  const byKey = {};
  for (const e of filtered) {
    const [yStr, mStr] = e.date.slice(0, 7).split("-");
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    let key;
    if (groupBy === "Month") key = `${yStr}-${mStr}`;
    else if (groupBy === "Quarter") key = `${y}-Q${Math.ceil(m / 3)}`;
    else if (groupBy === "Half") key = `${y}-H${m <= 6 ? 1 : 2}`;
    else key = yStr;
    byKey[key] = (byKey[key] || 0) + e.totalReceived;
  }

  return Object.keys(byKey)
    .sort()
    .map((key) => {
      let label;
      if (groupBy === "Month") {
        const [y, mStr] = key.split("-");
        const d = new Date(parseInt(y, 10), parseInt(mStr, 10) - 1, 1);
        label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      } else if (groupBy === "Quarter") {
        const [y, q] = key.split("-");
        label = `${q} '${y.slice(2)}`;
      } else if (groupBy === "Half") {
        const [y, h] = key.split("-");
        label = `${h} '${y.slice(2)}`;
      } else {
        label = key;
      }
      return { label, value: byKey[key] };
    });
}

// Net cost basis per US ticker (avg-cost method), derived from transactions.
function computeCostBasis(transactions) {
  const sorted = [...transactions].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  const pos = {};
  for (const tx of sorted) {
    const ticker = tx.ticker?.toUpperCase();
    if (!ticker || isBrazilianTicker(ticker)) continue;
    if (!pos[ticker]) pos[ticker] = { qty: 0, cost: 0 };
    const p = pos[ticker];
    const qty = Number(tx.qty) || 0;
    const price = Number(tx.price) || 0;
    if (tx.side === "buy") {
      p.qty += qty;
      p.cost += qty * price + (Number(tx.fee) || 0);
    } else if (tx.side === "sell") {
      const avg = p.qty > 0 ? p.cost / p.qty : 0;
      p.qty -= qty;
      p.cost -= avg * qty;
      if (p.qty < 0.0001) { p.qty = 0; p.cost = 0; }
    }
  }
  const out = {};
  for (const [t, p] of Object.entries(pos)) out[t] = p.cost;
  return out;
}

// Per-ticker dividend aggregates: total, YTD, prior-YTD, TTM.
function buildPositionRows(events, costBasis) {
  const now = new Date();
  const curYear = now.getFullYear();
  const mmdd = now.toISOString().slice(5, 10); // MM-DD today
  const ttmCutoff = new Date(now.getTime() - 365 * 86400000)
    .toISOString()
    .slice(0, 10);

  const byTicker = {};
  for (const e of events) {
    const t = e.ticker;
    if (!byTicker[t]) byTicker[t] = { ticker: t, total: 0, ytd: 0, priorYtd: 0, ttm: 0 };
    const row = byTicker[t];
    row.total += e.totalReceived;
    const y = parseInt(e.date.slice(0, 4), 10);
    const eMmdd = e.date.slice(5, 10);
    if (y === curYear) row.ytd += e.totalReceived;
    if (y === curYear - 1 && eMmdd <= mmdd) row.priorYtd += e.totalReceived;
    if (e.date >= ttmCutoff) row.ttm += e.totalReceived;
  }

  return Object.values(byTicker).map((row) => {
    const cost = costBasis[row.ticker] || 0;
    return {
      ...row,
      cost,
      yoyPct: row.priorYtd > 0 ? (row.ytd / row.priorYtd - 1) * 100 : null,
      yoc: cost > 0 ? (row.ttm / cost) * 100 : null,        // trailing-12m yield on cost
      recovered: cost > 0 ? (row.total / cost) * 100 : null, // cumulative dividends / cost
    };
  });
}

function aggPositions(rows) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const ytd = rows.reduce((s, r) => s + r.ytd, 0);
  const priorYtd = rows.reduce((s, r) => s + r.priorYtd, 0);
  const ttm = rows.reduce((s, r) => s + r.ttm, 0);
  const cost = rows.reduce((s, r) => s + (r.cost || 0), 0);
  return {
    total,
    ytd,
    yoyPct: priorYtd > 0 ? (ytd / priorYtd - 1) * 100 : null,
    yoc: cost > 0 ? (ttm / cost) * 100 : null,
    recovered: cost > 0 ? (total / cost) * 100 : null,
  };
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function cardHeaderStyle(open) {
  return {
    width: "100%",
    background: T.card,
    border: `1px solid ${T.borderSoft}`,
    borderRadius: open ? "4px 4px 0 0" : 4,
    padding: "14px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    color: T.text,
    cursor: "pointer",
  };
}

const cardBodyStyle = {
  background: T.card,
  border: `1px solid ${T.borderSoft}`,
  borderTop: "none",
  borderRadius: "0 0 4px 4px",
  padding: 20,
  marginTop: -1,
};

function CardTitle({ icon, children }) {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontFamily: FONT_MONO,
        fontSize: 11,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: T.gold,
      }}
    >
      {icon}
      {children}
    </span>
  );
}

function KpiCard({ label, value, color, yoy, sub }) {
  return (
    <div
      style={{
        background: T.cardElev,
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 4,
        padding: "16px 18px",
        flex: "1 1 0",
        minWidth: 120,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: T.textDim,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 22,
          fontWeight: 700,
          color: color || T.text,
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </div>
      {yoy != null && (
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, marginTop: 6 }}>
          <span style={{ color: growthColor(yoy) }}>{fmtPct(yoy)}</span>
          <span style={{ color: T.textFaint }}> vs prior year</span>
        </div>
      )}
      {sub && (
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, marginTop: 6 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function BarTooltip({ active, payload, label, hidden }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: T.cardElev,
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

// ── Asset class grouping helper ───────────────────────────────────────────────

function buildAssetClassRows(rows, transactions) {
  const tickerToClass = {};
  const sorted = [...transactions].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  for (const tx of sorted) {
    const t = tx.ticker?.toUpperCase();
    if (!t) continue;
    tickerToClass[t] = tx.assetClass || "Unknown";
  }

  const byClass = {};
  for (const row of rows) {
    const cls = tickerToClass[row.ticker] || "Unknown";
    if (!byClass[cls]) byClass[cls] = { ticker: cls, total: 0, ytd: 0, priorYtd: 0, ttm: 0, cost: 0, _isClass: true };
    const g = byClass[cls];
    g.total += row.total;
    g.ytd += row.ytd;
    g.priorYtd += row.priorYtd;
    g.ttm += row.ttm;
    g.cost += row.cost || 0;
  }

  return Object.values(byClass).map((g) => ({
    ...g,
    yoyPct: g.priorYtd > 0 ? (g.ytd / g.priorYtd - 1) * 100 : null,
    yoc: g.cost > 0 ? (g.ttm / g.cost) * 100 : null,
    recovered: g.cost > 0 ? (g.total / g.cost) * 100 : null,
  }));
}

// ── Position Dividends table ──────────────────────────────────────────────────

function PositionDividendsTable({ rows, transactions, valuesHidden, open, onToggle }) {
  const [sortCol, setSortCol] = useState("total");
  const [sortDir, setSortDir] = useState("desc");
  const [groupMode, setGroupMode] = useState("class");

  function handleSort(col) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  const displayRows = useMemo(() => {
    if (groupMode === "class") return buildAssetClassRows(rows, transactions);
    return rows;
  }, [rows, transactions, groupMode]);

  const sortedRows = useMemo(() => {
    return [...displayRows].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      const an = av ?? (sortDir === "asc" ? Infinity : -Infinity);
      const bn = bv ?? (sortDir === "asc" ? Infinity : -Infinity);
      return sortDir === "asc" ? an - bn : bn - an;
    });
  }, [displayRows, sortCol, sortDir]);

  const totals = useMemo(() => aggPositions(displayRows), [displayRows]);

  const COLS = [
    { key: "ticker", label: groupMode === "class" ? "Class" : "Ticker", align: "left" },
    { key: "total", label: "Total", align: "right" },
    { key: "ytd", label: "YTD", align: "right" },
    { key: "yoyPct", label: "Y/Y YTD", align: "right" },
    { key: "yoc", label: "YoC", align: "right" },
    { key: "recovered", label: "Recovered", align: "right" },
  ];

  const thBase = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    fontWeight: 500,
    padding: "8px 12px",
    borderBottom: `1px solid ${T.border}`,
    whiteSpace: "nowrap",
    cursor: "pointer",
    userSelect: "none",
  };
  const tdBase = {
    fontFamily: FONT_MONO,
    fontSize: 12,
    padding: "9px 12px",
    textAlign: "right",
    borderBottom: `1px solid ${T.borderSoft}`,
    color: T.text,
    whiteSpace: "nowrap",
  };

  function stickyCol(bg, zIndex = 1) {
    return {
      position: "sticky",
      left: 0,
      zIndex,
      background: bg,
      width: TICKER_COL_WIDTH,
      minWidth: TICKER_COL_WIDTH,
      borderRight: `1px solid ${T.border}`,
    };
  }

  function sortIndicator(col) {
    if (col !== sortCol) return " ↕";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  function renderCell(row, col) {
    switch (col.key) {
      case "ticker":
        return (
          <td key={col.key} style={{ ...tdBase, ...stickyCol(T.card), textAlign: "left", color: T.gold, letterSpacing: "0.06em", fontWeight: 600 }}>
            {row.ticker}
          </td>
        );
      case "total":  return <td key={col.key} style={tdBase}>{fmtUSD(row.total, valuesHidden)}</td>;
      case "ytd":    return <td key={col.key} style={tdBase}>{fmtUSD(row.ytd, valuesHidden)}</td>;
      case "yoyPct": return <td key={col.key} style={{ ...tdBase, color: growthColor(row.yoyPct), fontWeight: 600 }}>{fmtPct(row.yoyPct)}</td>;
      case "yoc":    return <td key={col.key} style={tdBase}>{fmtYoc(row.yoc)}</td>;
      case "recovered": return <td key={col.key} style={{ ...tdBase, color: T.gold }}>{fmtYoc(row.recovered)}</td>;
      default: return <td key={col.key} style={tdBase}>—</td>;
    }
  }

  function renderTotalRow() {
    const summaryTd = { ...tdBase, background: T.cardElev, fontWeight: 600, borderBottom: `1px solid ${T.border}`, borderTop: `1px solid ${T.border}` };
    return COLS.map((col) => {
      switch (col.key) {
        case "ticker":
          return (
            <td key={col.key} style={{ ...summaryTd, ...stickyCol(T.cardElev, 2), textAlign: "left", color: T.text, letterSpacing: "0.08em", fontSize: 11 }}>
              TOTAL
            </td>
          );
        case "total":  return <td key={col.key} style={summaryTd}>{fmtUSD(totals.total, valuesHidden)}</td>;
        case "ytd":    return <td key={col.key} style={summaryTd}>{fmtUSD(totals.ytd, valuesHidden)}</td>;
        case "yoyPct": return <td key={col.key} style={{ ...summaryTd, color: growthColor(totals.yoyPct) }}>{fmtPct(totals.yoyPct)}</td>;
        case "yoc":    return <td key={col.key} style={summaryTd}>{fmtYoc(totals.yoc)}</td>;
        case "recovered": return <td key={col.key} style={{ ...summaryTd, color: T.gold }}>{fmtYoc(totals.recovered)}</td>;
        default: return <td key={col.key} style={summaryTd} />;
      }
    });
  }

  return (
    <div style={{ marginTop: 16 }}>
      <button onClick={onToggle} style={cardHeaderStyle(open)}>
        <CardTitle icon={<BarChart2 size={14} strokeWidth={2} />}>Position Dividends</CardTitle>
        <ChevronDown size={16} style={{ color: T.textDim, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
      </button>

      {open && (
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.borderSoft}`,
            borderTop: "none",
            borderRadius: "0 0 4px 4px",
            marginTop: -1,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", gap: 8, padding: "14px 16px 0" }}>
            {[["ticker", "By Ticker"], ["class", "By Asset Class"]].map(([mode, label]) => {
              const active = groupMode === mode;
              return (
                <button
                  key={mode}
                  onClick={() => setGroupMode(mode)}
                  style={{
                    background: active ? T.gold : T.cardElev,
                    border: `1px solid ${active ? T.gold : T.border}`,
                    borderRadius: 4,
                    color: active ? T.bg : T.textDim,
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    letterSpacing: "0.08em",
                    padding: "5px 12px",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {displayRows.length === 0 ? (
            <div style={{ padding: "20px", fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
              No dividends recorded yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", minWidth: 680, borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {COLS.map((col) => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key)}
                        style={{
                          ...thBase,
                          ...(col.key === "ticker" ? stickyCol(T.card, 3) : null),
                          textAlign: col.align,
                          color: col.key === sortCol ? T.textDim : T.textFaint,
                        }}
                      >
                        {col.label}
                        <span style={{ opacity: col.key === sortCol ? 0.9 : 0.35 }}>{sortIndicator(col.key)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>{renderTotalRow()}</tr>
                  {sortedRows.map((row) => (
                    <tr key={row.ticker}>{COLS.map((col) => renderCell(row, col))}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              color: T.textFaint,
              padding: "10px 16px 14px",
              letterSpacing: "0.04em",
            }}
          >
            YoC = trailing-12-month dividends ÷ cost basis. Recovered = all-time dividends ÷ cost basis. Y/Y YTD compares this year to the same period last year.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Year vs Year comparator ───────────────────────────────────────────────────

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function buildYoyData(events) {
  const curYear = new Date().getFullYear();
  const priorYear = curYear - 1;

  // Only include events from the two relevant years
  const relevant = events.filter((e) => {
    if (!e.date) return false;
    const y = parseInt(e.date.slice(0, 4), 10);
    return y === curYear || y === priorYear;
  });

  const tickerSet = new Set();
  const monthSet = new Set();
  // cur[ticker][month] and prior[ticker][month]
  const cur = {};
  const prior = {};

  for (const e of relevant) {
    const y = parseInt(e.date.slice(0, 4), 10);
    const m = parseInt(e.date.slice(5, 7), 10);
    const t = e.ticker;
    tickerSet.add(t);
    monthSet.add(m);
    if (y === curYear) {
      if (!cur[t]) cur[t] = {};
      cur[t][m] = (cur[t][m] || 0) + e.totalReceived;
    } else {
      if (!prior[t]) prior[t] = {};
      prior[t][m] = (prior[t][m] || 0) + e.totalReceived;
    }
  }

  const tickers = [...tickerSet].sort();
  const months = [...monthSet].sort((a, b) => a - b);

  const rows = tickers.map((ticker) => ({
    ticker,
    currentYear: cur[ticker] || {},
    priorYear: prior[ticker] || {},
  }));

  return { tickers, months, rows, curYear, priorYear };
}

function fmtYoyCell(n, hidden) {
  if (hidden) return "$ ••••";
  if (n == null || n === 0) return null;
  // Format: $X.XX or $X,XXX.XX
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function YearVsYearTable({ events, transactions, valuesHidden, open, onToggle }) {
  const curYear = new Date().getFullYear();
  const priorYear = curYear - 1;

  const { months, rows } = useMemo(() => buildYoyData(events), [events]);

  const [selectedMonth, setSelectedMonth] = useState(null);
  const [groupMode, setGroupMode] = useState("class");
  const [collapsedClasses, setCollapsedClasses] = useState(() => new Set());

  function toggleClass(cls) {
    setCollapsedClasses(prev => {
      const next = new Set(prev);
      next.has(cls) ? next.delete(cls) : next.add(cls);
      return next;
    });
  }

  const effectiveMonth = useMemo(() => {
    if (selectedMonth !== null) return selectedMonth;
    if (!months.length) return null;
    const currentMonth = new Date().getMonth() + 1; // 1-12
    if (months.includes(currentMonth)) return currentMonth;
    return months[months.length - 1];
  }, [selectedMonth, months]);

  const tickerToClass = useMemo(() => {
    const map = {};
    for (const tx of transactions) {
      const t = tx.ticker?.toUpperCase();
      if (t) map[t] = tx.assetClass || "Unknown";
    }
    return map;
  }, [transactions]);

  const tickerRows = useMemo(() => {
    if (effectiveMonth == null) return [];
    return rows
      .map(r => ({
        ticker: r.ticker,
        py: r.priorYear[effectiveMonth] || 0,
        cy: r.currentYear[effectiveMonth] || 0,
      }))
      .filter(r => r.py > 0 || r.cy > 0);
  }, [rows, effectiveMonth]);

  const classGroups = useMemo(() => {
    if (groupMode !== "class") return null;
    const byClass = {};
    for (const row of tickerRows) {
      const cls = tickerToClass[row.ticker] || "Unknown";
      if (!byClass[cls]) byClass[cls] = { label: cls, py: 0, cy: 0, tickers: [] };
      byClass[cls].py += row.py;
      byClass[cls].cy += row.cy;
      byClass[cls].tickers.push(row);
    }
    return Object.values(byClass).sort((a, b) => (b.cy + b.py) - (a.cy + a.py));
  }, [tickerRows, groupMode, tickerToClass]);

  const totalPY = groupMode === "class" && classGroups
    ? classGroups.reduce((s, g) => s + g.py, 0)
    : tickerRows.reduce((s, r) => s + r.py, 0);
  const totalCY = groupMode === "class" && classGroups
    ? classGroups.reduce((s, g) => s + g.cy, 0)
    : tickerRows.reduce((s, r) => s + r.cy, 0);

  function dColor(n) {
    if (n == null || isNaN(n) || n === 0) return T.textDim;
    return n > 0 ? T.green : T.red;
  }

  const monthLabel = effectiveMonth != null
    ? new Date(curYear, effectiveMonth - 1, 1).toLocaleDateString("en-US", { month: "long" })
    : "";

  const thStyle = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    fontWeight: 500,
    padding: "8px 12px",
    borderBottom: `1px solid ${T.border}`,
    whiteSpace: "nowrap",
    color: T.textFaint,
    textAlign: "right",
  };
  const tdStyle = {
    fontFamily: FONT_MONO,
    fontSize: 12,
    padding: "9px 12px",
    textAlign: "right",
    borderBottom: `1px solid ${T.borderSoft}`,
    whiteSpace: "nowrap",
    color: T.text,
  };

  function stickyTh() {
    return {
      ...thStyle,
      position: "sticky",
      left: 0,
      zIndex: 3,
      background: T.card,
      textAlign: "left",
      width: TICKER_COL_WIDTH,
      minWidth: TICKER_COL_WIDTH,
      borderRight: `1px solid ${T.border}`,
    };
  }

  function stickyLabelTd(isTotal) {
    return {
      ...tdStyle,
      position: "sticky",
      left: 0,
      zIndex: 1,
      background: isTotal ? T.cardElev : T.card,
      textAlign: "left",
      width: TICKER_COL_WIDTH,
      minWidth: TICKER_COL_WIDTH,
      borderRight: `1px solid ${T.border}`,
      color: isTotal ? T.text : T.gold,
      fontWeight: isTotal ? 700 : 600,
      letterSpacing: "0.06em",
      fontSize: isTotal ? 11 : 12,
      ...(isTotal ? { borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` } : {}),
    };
  }

  function numTd(isTotal, extraStyle = {}) {
    return {
      ...tdStyle,
      ...(isTotal ? {
        background: T.cardElev,
        fontWeight: 600,
        borderTop: `1px solid ${T.border}`,
        borderBottom: `1px solid ${T.border}`,
      } : {}),
      ...extraStyle,
    };
  }

  function renderDataRow(label, py, cy, isTotal) {
    const dUSD = cy - py;
    const dPct = py > 0 ? ((cy / py) - 1) * 100 : null;
    return (
      <tr key={label}>
        <td style={stickyLabelTd(isTotal)}>{label}</td>
        <td style={numTd(isTotal, { color: T.textDim })}>{fmtUSD(py, valuesHidden)}</td>
        <td style={numTd(isTotal)}>{fmtUSD(cy, valuesHidden)}</td>
        <td style={numTd(isTotal, { color: dColor(dUSD), fontWeight: 600 })}>{fmtDeltaUSD(dUSD, valuesHidden)}</td>
        <td style={numTd(isTotal, { color: dColor(dPct), fontWeight: 600 })}>{fmtPct(dPct)}</td>
      </tr>
    );
  }

  function renderGroupHeaderRow(label, py, cy) {
    const collapsed = collapsedClasses.has(label);
    const dUSD = cy - py;
    const dPct = py > 0 ? ((cy / py) - 1) * 100 : null;
    const groupTd = {
      ...tdStyle,
      background: T.cardElev,
      fontWeight: 600,
      borderTop: `1px solid ${T.border}`,
      borderBottom: `1px solid ${T.border}`,
    };
    return (
      <tr key={`group-${label}`} style={{ cursor: "pointer" }} onClick={() => toggleClass(label)}>
        <td style={{
          ...groupTd,
          position: "sticky",
          left: 0,
          zIndex: 1,
          textAlign: "left",
          width: TICKER_COL_WIDTH,
          minWidth: TICKER_COL_WIDTH,
          borderRight: `1px solid ${T.border}`,
          color: T.gold,
          letterSpacing: "0.06em",
        }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ChevronDown
              size={12}
              style={{
                color: T.gold,
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.2s",
                flexShrink: 0,
              }}
            />
            {label}
          </span>
        </td>
        <td style={{ ...groupTd, color: T.textDim }}>{fmtUSD(py, valuesHidden)}</td>
        <td style={groupTd}>{fmtUSD(cy, valuesHidden)}</td>
        <td style={{ ...groupTd, color: dColor(dUSD), fontWeight: 600 }}>{fmtDeltaUSD(dUSD, valuesHidden)}</td>
        <td style={{ ...groupTd, color: dColor(dPct), fontWeight: 600 }}>{fmtPct(dPct)}</td>
      </tr>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      <button onClick={onToggle} style={cardHeaderStyle(open)}>
        <CardTitle icon={<BarChart2 size={14} strokeWidth={2} />}>Dividends Monthly Y/Y</CardTitle>
        <ChevronDown size={16} style={{ color: T.textDim, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
      </button>

      {open && (
        <div style={{
          background: T.card,
          border: `1px solid ${T.borderSoft}`,
          borderTop: "none",
          borderRadius: "0 0 4px 4px",
          marginTop: -1,
          overflow: "hidden",
        }}>
          {rows.length === 0 ? (
            <div style={{ padding: "20px", fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
              No dividend data for {curYear} or {priorYear}.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", flexWrap: "wrap" }}>
                <select
                  value={effectiveMonth ?? ""}
                  onChange={e => setSelectedMonth(Number(e.target.value))}
                  style={{
                    background: T.cardElev,
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    color: T.text,
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    padding: "6px 10px",
                    cursor: "pointer",
                    outline: "none",
                    appearance: "auto",
                  }}
                >
                  {months.map(m => (
                    <option key={m} value={m}>
                      {new Date(curYear, m - 1, 1).toLocaleDateString("en-US", { month: "long" })}
                    </option>
                  ))}
                </select>

                <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                  {[["class", "By Class"], ["ticker", "By Ticker"]].map(([mode, label]) => {
                    const active = groupMode === mode;
                    return (
                      <button
                        key={mode}
                        onClick={() => {
                          if (mode === "class") {
                            setGroupMode("class");
                            const allClasses = new Set(tickerRows.map(r => tickerToClass[r.ticker] || "Unknown"));
                            setCollapsedClasses(allClasses);
                          } else {
                            setGroupMode("ticker");
                            setCollapsedClasses(new Set());
                          }
                        }}
                        style={{
                          background: active ? T.gold : T.cardElev,
                          border: `1px solid ${active ? T.gold : T.border}`,
                          borderRadius: 4,
                          color: active ? T.bg : T.textDim,
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          letterSpacing: "0.08em",
                          padding: "5px 12px",
                          cursor: "pointer",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {tickerRows.length === 0 ? (
                <div style={{ padding: "0 16px 20px", fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
                  No dividends in {monthLabel}.
                </div>
              ) : (
                <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                  <table style={{ width: "100%", minWidth: 480, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={stickyTh()}>{groupMode === "class" ? "Class" : "Ticker"}</th>
                        <th style={thStyle}>{priorYear}</th>
                        <th style={thStyle}>{curYear}</th>
                        <th style={thStyle}>Δ $</th>
                        <th style={thStyle}>Δ %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {renderDataRow("TOTAL", totalPY, totalCY, true)}
                      {groupMode === "class" && classGroups
                        ? classGroups.map(group => (
                            <Fragment key={group.label}>
                              {renderGroupHeaderRow(group.label, group.py, group.cy)}
                              {!collapsedClasses.has(group.label) && group.tickers.map(r => renderDataRow(r.ticker, r.py, r.cy, false))}
                            </Fragment>
                          ))
                        : tickerRows
                            .slice()
                            .sort((a, b) => (b.cy + b.py) - (a.cy + a.py))
                            .map(r => renderDataRow(r.ticker, r.py, r.cy, false))
                      }
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, padding: "10px 16px 14px", letterSpacing: "0.04em" }}>
                {curYear} vs {priorYear} · {monthLabel}. Δ = CY minus PY.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Dividend History (audit) table ────────────────────────────────────────────

function DivHistPopover({ anchor, onClose, sortDir, onSort, filterable, options, selected, onChange, dateRange, setDateRange }) {
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
  const POPOVER_W = 220;
  const posStyle = rect
    ? { position: "fixed", top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_W - 8)), zIndex: 50, width: POPOVER_W }
    : { display: "none" };

  const secLabel = { fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "0.2em", color: T.textFaint, textTransform: "uppercase", marginBottom: 8 };
  const inputStyle = { width: "100%", background: T.card, border: `1px solid ${T.border}`, color: T.text, padding: "6px 8px", fontFamily: FONT_MONO, fontSize: 11, marginBottom: 8, boxSizing: "border-box" };
  const linkBtn = (color) => ({ background: "transparent", border: "none", color, fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", cursor: "pointer", padding: 0 });

  function SortBtn({ dir, label }) {
    const active = sortDir === dir;
    return (
      <button onClick={() => onSort(dir)} style={{ flex: 1, background: active ? "rgba(201,169,97,0.12)" : "transparent", border: `1px solid ${active ? T.gold : T.border}`, color: active ? T.gold : T.textDim, padding: "8px 6px", fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", cursor: "pointer" }}>
        {label}
      </button>
    );
  }

  return (
    <div ref={ref} style={{ ...posStyle, background: T.cardElev, border: `1px solid ${T.border}`, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", padding: 12, maxHeight: 360, overflowY: "auto" }}>
      <div style={secLabel}>Sort</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <SortBtn dir="asc" label="↑ Asc" />
        <SortBtn dir="desc" label="↓ Desc" />
      </div>

      {filterable && dateRange && (
        <>
          <div style={{ height: 1, background: T.border, marginBottom: 12 }} />
          <div style={secLabel}>Date range</div>
          <div style={{ marginBottom: 4, fontFamily: FONT_MONO, fontSize: 10, color: T.textDim }}>From</div>
          <input type="date" value={dateRange.from} onChange={e => setDateRange({ ...dateRange, from: e.target.value })} style={inputStyle} />
          <div style={{ marginBottom: 4, fontFamily: FONT_MONO, fontSize: 10, color: T.textDim }}>To</div>
          <input type="date" value={dateRange.to} onChange={e => setDateRange({ ...dateRange, to: e.target.value })} style={inputStyle} />
          <button onClick={() => setDateRange({ from: "", to: "" })} style={{ ...linkBtn(T.textDim), border: `1px solid ${T.border}`, padding: "6px 10px", width: "100%" }}>Clear range</button>
        </>
      )}

      {filterable && !dateRange && options && (
        <>
          <div style={{ height: 1, background: T.border, marginBottom: 12 }} />
          <div style={secLabel}>Filter</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <button onClick={() => onChange(new Set(options))} style={linkBtn(T.gold)}>All</button>
            <button onClick={() => onChange(new Set())} style={linkBtn(T.textDim)}>None</button>
          </div>
          {options.map(opt => (
            <label key={opt} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={selected.has(opt)} onChange={() => { const n = new Set(selected); n.has(opt) ? n.delete(opt) : n.add(opt); onChange(n); }} style={{ accentColor: T.gold }} />
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text }}>{opt}</span>
            </label>
          ))}
        </>
      )}
    </div>
  );
}

function DividendHistoryTable({ events, valuesHidden, open, onToggle }) {
  const [openCol, setOpenCol] = useState(null);
  const [anchor, setAnchor] = useState(null);
  const [sort, setSort] = useState({ col: "date", dir: "desc" });
  const [filters, setFilters] = useState({ ticker: new Set(), dateFrom: "", dateTo: "" });

  const allTickers = useMemo(() => [...new Set(events.map(e => e.ticker))].sort(), [events]);

  function isFiltered(col) {
    if (col === "date") return !!(filters.dateFrom || filters.dateTo);
    if (col === "ticker") return filters.ticker.size > 0 && filters.ticker.size < allTickers.length;
    return false;
  }

  const visible = useMemo(() => {
    let list = events.filter(e => {
      if (filters.ticker.size > 0 && !filters.ticker.has(e.ticker)) return false;
      if (filters.dateFrom && e.date < filters.dateFrom) return false;
      if (filters.dateTo && e.date > filters.dateTo) return false;
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const key = { date: "date", ticker: "ticker", amountPerShare: "amountPerShare", qtyHeld: "qtyHeld", totalReceived: "totalReceived" }[sort.col] || sort.col;
      if (key === "amountPerShare" || key === "qtyHeld" || key === "totalReceived") {
        return ((Number(a[key]) || 0) - (Number(b[key]) || 0)) * dir;
      }
      const sa = String(a[key] ?? "");
      const sb = String(b[key] ?? "");
      return (sa < sb ? -1 : sa > sb ? 1 : 0) * dir;
    });
    return list;
  }, [events, filters, sort]);

  const totalReceived = useMemo(() => visible.reduce((s, e) => s + (e.totalReceived || 0), 0), [visible]);

  function openPopover(col, e) { setOpenCol(col); setAnchor(e.currentTarget); }
  function closePopover() { setOpenCol(null); setAnchor(null); }
  function sortDirFor(col) { return sort.col === col ? sort.dir : col === "date" ? "desc" : "asc"; }

  const thBase = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    fontWeight: 500,
    padding: "8px 12px",
    borderBottom: `1px solid ${T.border}`,
    whiteSpace: "nowrap",
    cursor: "pointer",
    userSelect: "none",
    position: "sticky",
    top: 0,
    background: T.card,
  };
  const tdBase = {
    fontFamily: FONT_MONO,
    fontSize: 12,
    padding: "8px 12px",
    textAlign: "right",
    borderBottom: `1px solid ${T.borderSoft}`,
    color: T.text,
    whiteSpace: "nowrap",
  };

  function thColor(col) { return (sort.col === col || isFiltered(col)) ? T.gold : T.textFaint; }
  function thSuffix(col) {
    if (sort.col === col) return sort.dir === "asc" ? " ↑" : " ↓";
    if (isFiltered(col)) return " •";
    return "";
  }

  const isDateCol = openCol === "date";
  const isTickerCol = openCol === "ticker";

  return (
    <div style={{ marginTop: 16 }}>
      <button onClick={onToggle} style={cardHeaderStyle(open)}>
        <CardTitle icon={<Receipt size={14} strokeWidth={2} />}>Dividend History</CardTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, letterSpacing: "0.06em" }}>
            {visible.length !== events.length ? `${visible.length} / ${events.length}` : `${events.length}`} payment{events.length === 1 ? "" : "s"}
          </span>
          <ChevronDown size={16} style={{ color: T.textDim, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </div>
      </button>

      {open && (
        <div style={{ background: T.card, border: `1px solid ${T.borderSoft}`, borderTop: "none", borderRadius: "0 0 4px 4px", marginTop: -1, overflow: "hidden" }}>
          {events.length === 0 ? (
            <div style={{ padding: "20px", fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
              No dividend payments recorded yet.
            </div>
          ) : (
            <div style={{ maxHeight: 420, overflowY: "auto", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", minWidth: 480, borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th onClick={e => openPopover("date", e)} style={{ ...thBase, textAlign: "left", color: thColor("date") }}>Date{thSuffix("date")}</th>
                    <th onClick={e => openPopover("ticker", e)} style={{ ...thBase, textAlign: "left", color: thColor("ticker") }}>Ticker{thSuffix("ticker")}</th>
                    <th onClick={e => openPopover("amountPerShare", e)} style={{ ...thBase, color: thColor("amountPerShare") }}>$/Share{thSuffix("amountPerShare")}</th>
                    <th onClick={e => openPopover("qtyHeld", e)} style={{ ...thBase, color: thColor("qtyHeld") }}>Qty{thSuffix("qtyHeld")}</th>
                    <th onClick={e => openPopover("totalReceived", e)} style={{ ...thBase, color: thColor("totalReceived") }}>Total{thSuffix("totalReceived")}</th>
                  </tr>
                </thead>
                <tbody>
                  {/* TOTAL row — sums only visible (filtered) rows */}
                  <tr style={{ background: "rgba(201,169,97,0.06)" }}>
                    <td style={{ ...tdBase, textAlign: "left", color: T.gold, fontWeight: 700, fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase" }}>Total</td>
                    <td style={{ ...tdBase, textAlign: "left", color: T.textFaint }}>{visible.length} rows</td>
                    <td style={tdBase}>—</td>
                    <td style={tdBase}>—</td>
                    <td style={{ ...tdBase, color: T.green, fontWeight: 700 }}>{fmtUSD(totalReceived, valuesHidden)}</td>
                  </tr>
                  {visible.map((e, i) => (
                    <tr key={`${e.ticker}-${e.date}-${i}`}>
                      <td style={{ ...tdBase, textAlign: "left", color: T.textDim }} title={e.exDate ? `Ex-date: ${e.exDate}${e.payDate ? "" : " (pay date n/a — showing ex-date)"}` : undefined}>{e.date}</td>
                      <td style={{ ...tdBase, textAlign: "left", color: T.gold, fontWeight: 600, letterSpacing: "0.06em" }}>{e.ticker}</td>
                      <td style={tdBase}>{fmtPerShare(e.amountPerShare, valuesHidden)}</td>
                      <td style={tdBase}>{fmtQty(e.qtyHeld)}</td>
                      <td style={{ ...tdBase, color: T.green, fontWeight: 600 }}>{fmtUSD(e.totalReceived, valuesHidden)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {openCol && (
        <DivHistPopover
          anchor={anchor}
          onClose={closePopover}
          sortDir={sortDirFor(openCol)}
          onSort={dir => { setSort({ col: openCol, dir }); closePopover(); }}
          filterable={isDateCol || isTickerCol}
          options={isTickerCol ? allTickers : null}
          selected={isTickerCol ? filters.ticker : new Set()}
          onChange={next => setFilters(f => ({ ...f, ticker: next }))}
          dateRange={isDateCol ? { from: filters.dateFrom, to: filters.dateTo } : null}
          setDateRange={isDateCol ? r => setFilters(f => ({ ...f, dateFrom: r.from, dateTo: r.to })) : undefined}
        />
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DividendsView({ auth, onAuthFail, valuesHidden }) {
  const [transactions, setTransactions] = useState([]);
  const [events, setEvents] = useState([]);
  const [state, setState] = useState("loading"); // loading | done | error
  const [error, setError] = useState(null);

  const [groupBy, setGroupBy] = useState("Month");
  const [selectedYears, setSelectedYears] = useState(new Set());

  const [incomeOpen, setIncomeOpen] = useState(true);
  const [posOpen, setPosOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [yoyOpen, setYoyOpen] = useState(false);

  const headers = authHeaders(auth);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState("loading");
      setError(null);
      try {
        const txRes = await fetch("/api/transactions", { headers });
        if (txRes.status === 401) { onAuthFail?.(); return; }
        if (!txRes.ok) throw new Error(`Transactions: ${txRes.status}`);
        const txData = await txRes.json();
        const txs = Array.isArray(txData.transactions) ? txData.transactions : [];
        if (!cancelled) setTransactions(txs);

        if (!txs.length) {
          if (!cancelled) { setEvents([]); setState("done"); }
          return;
        }

        const divRes = await fetch("/api/dividends", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ transactions: txs }),
        });
        if (divRes.status === 401) { onAuthFail?.(); return; }
        if (!divRes.ok) throw new Error(`Dividends: ${divRes.status}`);
        const divData = await divRes.json();
        if (!cancelled) {
          setEvents(Array.isArray(divData.events) ? divData.events : []);
          setState("done");
        }
      } catch (err) {
        if (!cancelled) { setError(err.message); setState("error"); }
      }
    })();

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // KPIs
  const kpis = useMemo(() => {
    const now = new Date();
    const curYear = now.getFullYear();
    const thisYear = String(curYear);
    const thisMonth = now.toISOString().slice(0, 7);
    const mmdd = now.toISOString().slice(5, 10);
    const priorYear = String(curYear - 1);
    const priorYearMonth = `${priorYear}-${now.toISOString().slice(5, 7)}`;

    // Previous calendar month (e.g. May 2026 when today is June 2026)
    const prevMonthDate = new Date(curYear, now.getMonth() - 1, 1);
    const prevMonthStr = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}`;

    let allTime = 0, ytd = 0, month = 0, priorYtd = 0, priorMonth = 0, prevCalMonth = 0;
    for (const e of events) {
      allTime += e.totalReceived;
      if (e.date.startsWith(thisYear)) ytd += e.totalReceived;
      if (e.date.startsWith(thisMonth)) month += e.totalReceived;
      if (e.date.startsWith(priorYear) && e.date.slice(5, 10) <= mmdd) priorYtd += e.totalReceived;
      if (e.date.startsWith(priorYearMonth)) priorMonth += e.totalReceived;
      if (e.date.startsWith(prevMonthStr)) prevCalMonth += e.totalReceived;
    }
    const yoyYtd = priorYtd > 0 ? (ytd / priorYtd - 1) * 100 : null;
    const yoyMonth = priorMonth > 0 ? (month / priorMonth - 1) * 100 : null;

    // Month-over-month delta: this month vs previous calendar month
    const momDelta = prevCalMonth > 0 ? (month / prevCalMonth - 1) * 100 : null;

    // Human-readable month labels
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const thisMonthLabel = `${MONTHS[now.getMonth()]} ${curYear}`;
    const prevMonthLabel = `${MONTHS[prevMonthDate.getMonth()]} ${prevMonthDate.getFullYear()}`;

    return {
      allTime, ytd, month, priorYtd, priorMonth, yoyYtd, yoyMonth,
      prevCalMonth, momDelta, thisMonthLabel, prevMonthLabel,
    };
  }, [events]);

  const availableYears = useMemo(() => {
    const ys = [...new Set(events.map((e) => e.date.slice(0, 4)))].sort((a, b) => b - a);
    return ys;
  }, [events]);

  const chartData = useMemo(
    () => buildChartData(events, groupBy, selectedYears),
    [events, groupBy, selectedYears]
  );
  const hasChartData = chartData.some((d) => d.value > 0);
  const xInterval = chartData.length > 12 ? Math.ceil(chartData.length / 10) - 1 : 0;

  // Item 36: estimated accrued interest on US Bank Bonds, derived on the fly
  // from buy/sell transactions + coupon/maturity in notes. Bucketed by month.
  const bondAccrual = useMemo(() => computeBankBondsAccrual(transactions), [transactions]);

  // Estimated Bank Bonds interest folded into the same KPI windows.
  const bondKpis = useMemo(() => {
    const now = new Date();
    const thisYear = String(now.getFullYear());
    const thisMonth = now.toISOString().slice(0, 7);
    let allTime = 0, ytd = 0, month = 0;
    for (const k of Object.keys(bondAccrual.byMonth)) {
      const v = bondAccrual.byMonth[k];
      allTime += v;
      if (k.startsWith(thisYear)) ytd += v;
      if (k === thisMonth) month += v;
    }
    return { allTime, ytd, month };
  }, [bondAccrual]);

  const costBasis = useMemo(() => computeCostBasis(transactions), [transactions]);
  const positionRows = useMemo(
    () => buildPositionRows(events, costBasis),
    [events, costBasis]
  );

  return (
    <div style={{ paddingBottom: 40 }}>
      {/* ── Income History card (KPIs + chart inside) ── */}
      <section>
        <button onClick={() => setIncomeOpen((o) => !o)} style={cardHeaderStyle(incomeOpen)}>
          <CardTitle icon={<TrendingUp size={14} strokeWidth={2} />}>Income History</CardTitle>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {state === "loading" && (
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, letterSpacing: "0.06em" }}>
                Loading…
              </span>
            )}
            <ChevronDown size={16} style={{ color: T.textDim, transform: incomeOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
          </div>
        </button>

        {incomeOpen && (
          <div style={cardBodyStyle}>
            {state === "loading" && (
              <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textDim, padding: "32px 0", textAlign: "center" }}>
                Fetching US dividends…
              </div>
            )}

            {state === "error" && (
              <div style={{ background: T.cardElev, border: `1px solid ${T.red}44`, borderRadius: 4, padding: "16px 20px", fontFamily: FONT_MONO, fontSize: 13, color: T.red }}>
                {error}
              </div>
            )}

            {state === "done" && (
              <>
                {/* Month Comparator: Prev Month vs This Month */}
                {(selectedYears.size === 0 || selectedYears.has(String(new Date().getFullYear()))) && (
                  <div style={{ marginBottom: 20 }}>
                    <div
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        letterSpacing: "0.18em",
                        textTransform: "uppercase",
                        color: T.textFaint,
                        marginBottom: 10,
                      }}
                    >
                      Month vs Month
                    </div>
                    <div style={{ display: "flex", gap: 12 }}>
                      {/* Prev Month */}
                      <div
                        style={{
                          background: T.cardElev,
                          border: `1px solid ${T.borderSoft}`,
                          borderRadius: 4,
                          padding: "14px 16px",
                          flex: "1 1 0",
                          minWidth: 120,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 10,
                            letterSpacing: "0.14em",
                            textTransform: "uppercase",
                            color: T.textDim,
                            marginBottom: 6,
                          }}
                        >
                          {kpis.prevMonthLabel}
                        </div>
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 20,
                            fontWeight: 700,
                            color: T.text,
                            letterSpacing: "-0.02em",
                          }}
                        >
                          {fmtUSD0(kpis.prevCalMonth, valuesHidden)}
                        </div>
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 10,
                            color: T.textFaint,
                            marginTop: 4,
                          }}
                        >
                          complete month
                        </div>
                      </div>

                      {/* Arrow + delta in the middle */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 4,
                          minWidth: 52,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 18,
                            color: T.border,
                          }}
                        >
                          {"--->"}
                        </div>
                        {kpis.momDelta != null && (
                          <div
                            style={{
                              fontFamily: FONT_MONO,
                              fontSize: 11,
                              fontWeight: 700,
                              color: kpis.momDelta > 0 ? T.green : kpis.momDelta < 0 ? T.red : T.textDim,
                            }}
                          >
                            {fmtPct(kpis.momDelta)}
                          </div>
                        )}
                      </div>

                      {/* This Month */}
                      <div
                        style={{
                          background: T.cardElev,
                          border: `1px solid ${T.gold}44`,
                          borderRadius: 4,
                          padding: "14px 16px",
                          flex: "1 1 0",
                          minWidth: 120,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 10,
                            letterSpacing: "0.14em",
                            textTransform: "uppercase",
                            color: T.gold,
                            marginBottom: 6,
                          }}
                        >
                          {kpis.thisMonthLabel}
                        </div>
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 20,
                            fontWeight: 700,
                            color: T.text,
                            letterSpacing: "-0.02em",
                          }}
                        >
                          {fmtUSD0(kpis.month, valuesHidden)}
                        </div>
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 10,
                            color: T.textFaint,
                            marginTop: 4,
                          }}
                        >
                          so far this month
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* KPI cards — dividends + estimated Bank Bonds accrued interest */}
                <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                  <KpiCard
                    label="All Time"
                    value={fmtUSD0(kpis.allTime + bondKpis.allTime, valuesHidden)}
                    sub={bondKpis.allTime > 0 ? `incl. ${fmtUSD0(bondKpis.allTime, valuesHidden)} est. bond interest` : null}
                  />
                  <KpiCard
                    label="YTD"
                    value={fmtUSD0(kpis.ytd + bondKpis.ytd, valuesHidden)}
                    yoy={kpis.yoyYtd}
                    sub={bondKpis.ytd > 0 ? `incl. ${fmtUSD0(bondKpis.ytd, valuesHidden)} est. bond interest` : null}
                  />
                  <KpiCard
                    label="This Month"
                    value={fmtUSD0(kpis.month + bondKpis.month, valuesHidden)}
                    yoy={kpis.yoyMonth}
                    sub={bondKpis.month > 0 ? `incl. ${fmtUSD0(bondKpis.month, valuesHidden)} est. bond interest` : null}
                  />
                </div>

                {/* Group-by selector */}
                <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                  {PERIOD_OPTIONS.map((p) => {
                    const active = groupBy === p;
                    return (
                      <button
                        key={p}
                        onClick={() => setGroupBy(p)}
                        style={{
                          background: active ? T.gold : T.cardElev,
                          border: `1px solid ${active ? T.gold : T.border}`,
                          borderRadius: 4,
                          color: active ? T.bg : T.textDim,
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          letterSpacing: "0.08em",
                          padding: "5px 12px",
                          cursor: "pointer",
                        }}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>

                {/* Year filter */}
                <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
                  {["All", ...availableYears].map((y) => {
                    const isAll = y === "All";
                    const active = isAll ? selectedYears.size === 0 : selectedYears.has(y);
                    return (
                      <button
                        key={y}
                        onClick={() => {
                          if (isAll) {
                            setSelectedYears(new Set());
                          } else {
                            setSelectedYears((prev) => {
                              const next = new Set(prev);
                              if (next.has(y)) next.delete(y);
                              else next.add(y);
                              return next;
                            });
                          }
                        }}
                        style={{
                          background: active ? T.gold : T.cardElev,
                          border: `1px solid ${active ? T.gold : T.border}`,
                          borderRadius: 4,
                          color: active ? T.bg : T.textDim,
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          letterSpacing: "0.08em",
                          padding: "5px 12px",
                          cursor: "pointer",
                        }}
                      >
                        {y}
                      </button>
                    );
                  })}
                </div>

                {!hasChartData ? (
                  <div style={{ textAlign: "center", padding: "40px 0", fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                    No dividends recorded in this range
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={chartData} margin={{ top: 8, right: 4, left: 0, bottom: 50 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                      <XAxis
                        dataKey="label"
                        tick={{ fontFamily: FONT_MONO, fontSize: 11, fill: T.textDim }}
                        axisLine={{ stroke: T.border }}
                        tickLine={false}
                        angle={-45}
                        textAnchor="end"
                        interval={xInterval}
                        height={55}
                      />
                      <YAxis
                        tickFormatter={valuesHidden ? () => "•••" : fmtAxisUSD}
                        tick={{ fontFamily: FONT_MONO, fontSize: 11, fill: T.textDim }}
                        axisLine={false}
                        tickLine={false}
                        width={44}
                      />
                      <Tooltip content={(props) => <BarTooltip {...props} hidden={valuesHidden} />} cursor={{ fill: "rgba(201,169,97,0.08)" }} />
                      <Bar dataKey="value" fill={T.gold} radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}

                <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, marginTop: 12, letterSpacing: "0.04em" }}>
                  US dividends only (Yahoo Finance amounts + Polygon.io pay dates). Bucketed by pay date; falls back to ex-date when the pay date is unavailable. Updated daily after US market close.
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {/* ── Position Dividends ── */}
      {state === "done" && (
        <PositionDividendsTable
          rows={positionRows}
          transactions={transactions}
          valuesHidden={valuesHidden}
          open={posOpen}
          onToggle={() => setPosOpen((v) => !v)}
        />
      )}

      {/* ── Year vs Year comparator ── */}
      {state === "done" && (
        <YearVsYearTable
          events={events}
          transactions={transactions}
          valuesHidden={valuesHidden}
          open={yoyOpen}
          onToggle={() => setYoyOpen((v) => !v)}
        />
      )}

      {/* ── Dividend History (audit) ── */}
      {state === "done" && (
        <DividendHistoryTable
          events={events}
          valuesHidden={valuesHidden}
          open={histOpen}
          onToggle={() => setHistOpen((v) => !v)}
        />
      )}
    </div>
  );
}
