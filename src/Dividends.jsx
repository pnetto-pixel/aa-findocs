// src/Dividends.jsx
// Tab: Dividends / Income — US assets only (Yahoo Finance, keyless).
// Item 17: Income History — collapsible card with KPIs inside, bar chart
//          with Month | Quarter | Half | Year views + date range filter.
// Item 18: (kept in monthly grouping of the chart)
// Position Dividends: per-ticker total, YTD, Y/Y YTD growth, yield on cost.
// Dividend History: full audit table of every payment.

import { useState, useEffect, useMemo, Fragment } from "react";
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

function KpiCard({ label, value, color, yoy }) {
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
  const [groupMode, setGroupMode] = useState("ticker");

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

const MONTH_FULL = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function buildYoyData(events, selectedMonth, groupMode) {
  const curYear = new Date().getFullYear();
  const priorYear = curYear - 1;

  const relevant = events.filter((e) => {
    if (!e.date) return false;
    const y = parseInt(e.date.slice(0, 4), 10);
    return y === curYear || y === priorYear;
  });

  const monthSet = new Set();
  for (const e of relevant) monthSet.add(parseInt(e.date.slice(5, 7), 10));
  const availableMonths = [...monthSet].sort((a, b) => a - b);

  const filtered = selectedMonth > 0
    ? relevant.filter((e) => parseInt(e.date.slice(5, 7), 10) === selectedMonth)
    : relevant;

  const curAmts = {};
  const priorAmts = {};

  for (const e of filtered) {
    const y = parseInt(e.date.slice(0, 4), 10);
    const key = groupMode === "ticker" ? e.ticker : (e.assetClass || "Other");
    if (y === curYear) {
      curAmts[key] = (curAmts[key] || 0) + e.totalReceived;
    } else {
      priorAmts[key] = (priorAmts[key] || 0) + e.totalReceived;
    }
  }

  const allKeys = new Set([...Object.keys(curAmts), ...Object.keys(priorAmts)]);
  const rows = [...allKeys].sort().map((label) => {
    const lastYear = priorAmts[label] || 0;
    const curYearAmt = curAmts[label] || 0;
    const diffDollar = curYearAmt - lastYear;
    const diffPct = lastYear > 0 ? Math.round((curYearAmt - lastYear) / lastYear * 100) : null;
    return { label, lastYear, curYearAmt, diffDollar, diffPct };
  });

  return { rows, curYear, priorYear, availableMonths };
}

function YearVsYearTable({ events, valuesHidden, open, onToggle }) {
  const [selectedMonth, setSelectedMonth] = useState(0);
  const [groupMode, setGroupMode] = useState("ticker");

  const yoyData = useMemo(
    () => buildYoyData(events, selectedMonth, groupMode),
    [events, selectedMonth, groupMode]
  );
  const { rows, curYear, priorYear, availableMonths } = yoyData;

  const totalLastYear   = rows.reduce((s, r) => s + r.lastYear, 0);
  const totalCurYear    = rows.reduce((s, r) => s + r.curYearAmt, 0);
  const totalDiffDollar = totalCurYear - totalLastYear;
  const totalDiffPct    = totalLastYear > 0
    ? Math.round((totalCurYear - totalLastYear) / totalLastYear * 100)
    : null;

  const thBase = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    fontWeight: 500,
    padding: "8px 12px",
    borderBottom: `1px solid ${T.border}`,
    whiteSpace: "nowrap",
    color: T.textFaint,
  };

  const tdBase = {
    fontFamily: FONT_MONO,
    fontSize: 12,
    padding: "9px 12px",
    borderBottom: `1px solid ${T.borderSoft}`,
    whiteSpace: "nowrap",
  };

  const summaryTd = {
    ...tdBase,
    background: T.cardElev,
    fontWeight: 600,
    borderTop: `1px solid ${T.border}`,
    borderBottom: `1px solid ${T.border}`,
  };

  function fmtDiff(n, hidden) {
    if (hidden) return "$ ••••";
    if (n === 0) return "—";
    const sign = n > 0 ? "+" : "";
    return sign + new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD",
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(n);
  }

  function diffColor(n) {
    return n > 0 ? T.green : n < 0 ? T.red : T.textDim;
  }

  function renderPctCell(diffPct, lastYear, curYearAmt, extra) {
    const style = { ...tdBase, ...extra, textAlign: "right" };
    if (lastYear === 0 && curYearAmt === 0) return <td style={{ ...style, color: T.textFaint }}>—</td>;
    if (lastYear === 0 && curYearAmt > 0)   return <td style={{ ...style, color: T.textDim }}>new</td>;
    if (diffPct == null)                     return <td style={{ ...style, color: T.textFaint }}>—</td>;
    const color = diffPct > 0 ? T.green : diffPct < 0 ? T.red : T.textDim;
    return <td style={{ ...style, color, fontWeight: 600 }}>{`${diffPct > 0 ? "+" : ""}${diffPct}%`}</td>;
  }

  const subtitle = `${curYear} vs ${priorYear}`;

  return (
    <div style={{ marginTop: 16 }}>
      <button onClick={onToggle} style={cardHeaderStyle(open)}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
          <CardTitle icon={<BarChart2 size={14} strokeWidth={2} />}>Year vs Year</CardTitle>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, letterSpacing: "0.06em", marginLeft: 24 }}>
            {subtitle}
          </span>
        </div>
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
          {/* Controls row */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "14px 16px 0",
            gap: 8,
            flexWrap: "wrap",
          }}>
            <div style={{ display: "flex", gap: 8 }}>
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
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(Number(e.target.value))}
              style={{
                background: T.cardElev,
                border: `1px solid ${T.border}`,
                borderRadius: 4,
                color: T.text,
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.08em",
                padding: "5px 10px",
                cursor: "pointer",
                outline: "none",
              }}
            >
              <option value={0}>All Months</option>
              {availableMonths.map((m) => (
                <option key={m} value={m}>{MONTH_FULL[m - 1]}</option>
              ))}
            </select>
          </div>

          {rows.length === 0 ? (
            <div style={{ padding: "20px", fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
              No dividend data for {curYear} or {priorYear}.
            </div>
          ) : (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", marginTop: 14 }}>
              <table style={{ width: "100%", minWidth: 480, borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...thBase, textAlign: "left" }}>
                      {groupMode === "ticker" ? "Ticker" : "Asset Class"}
                    </th>
                    <th style={{ ...thBase, textAlign: "right" }}>{priorYear}</th>
                    <th style={{ ...thBase, textAlign: "right" }}>{curYear}</th>
                    <th style={{ ...thBase, textAlign: "right" }}>Δ $</th>
                    <th style={{ ...thBase, textAlign: "right" }}>Δ %</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.label}>
                      <td style={{ ...tdBase, textAlign: "left", color: T.gold, fontWeight: 600, letterSpacing: "0.06em" }}>
                        {row.label}
                      </td>
                      <td style={{ ...tdBase, textAlign: "right", color: T.textDim }}>
                        {fmtUSD(row.lastYear, valuesHidden)}
                      </td>
                      <td style={{ ...tdBase, textAlign: "right", color: T.text }}>
                        {fmtUSD(row.curYearAmt, valuesHidden)}
                      </td>
                      <td style={{ ...tdBase, textAlign: "right", color: diffColor(row.diffDollar), fontWeight: 600 }}>
                        {fmtDiff(row.diffDollar, valuesHidden)}
                      </td>
                      {renderPctCell(row.diffPct, row.lastYear, row.curYearAmt, {})}
                    </tr>
                  ))}
                  <tr>
                    <td style={{ ...summaryTd, textAlign: "left", color: T.text, letterSpacing: "0.08em", fontSize: 11 }}>
                      TOTAL
                    </td>
                    <td style={{ ...summaryTd, textAlign: "right", color: T.textDim }}>
                      {fmtUSD(totalLastYear, valuesHidden)}
                    </td>
                    <td style={{ ...summaryTd, textAlign: "right", color: T.text }}>
                      {fmtUSD(totalCurYear, valuesHidden)}
                    </td>
                    <td style={{ ...summaryTd, textAlign: "right", color: diffColor(totalDiffDollar), fontWeight: 600 }}>
                      {fmtDiff(totalDiffDollar, valuesHidden)}
                    </td>
                    {renderPctCell(totalDiffPct, totalLastYear, totalCurYear, { background: T.cardElev, fontWeight: 600 })}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Dividend History (audit) table ────────────────────────────────────────────

function DividendHistoryTable({ events, valuesHidden, open, onToggle }) {
  const sorted = useMemo(
    () => [...events].sort((a, b) => b.date.localeCompare(a.date)),
    [events]
  );

  const thBase = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    fontWeight: 500,
    padding: "8px 12px",
    borderBottom: `1px solid ${T.border}`,
    whiteSpace: "nowrap",
    color: T.textFaint,
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

  return (
    <div style={{ marginTop: 16 }}>
      <button onClick={onToggle} style={cardHeaderStyle(open)}>
        <CardTitle icon={<Receipt size={14} strokeWidth={2} />}>Dividend History</CardTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, letterSpacing: "0.06em" }}>
            {events.length} payment{events.length === 1 ? "" : "s"}
          </span>
          <ChevronDown size={16} style={{ color: T.textDim, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </div>
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
          {sorted.length === 0 ? (
            <div style={{ padding: "20px", fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
              No dividend payments recorded yet.
            </div>
          ) : (
            <div style={{ maxHeight: 420, overflowY: "auto", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", minWidth: 480, borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...thBase, textAlign: "left", position: "sticky", top: 0, background: T.card }}>Date</th>
                    <th style={{ ...thBase, textAlign: "left", position: "sticky", top: 0, background: T.card }}>Ticker</th>
                    <th style={{ ...thBase, position: "sticky", top: 0, background: T.card }}>$/Share</th>
                    <th style={{ ...thBase, position: "sticky", top: 0, background: T.card }}>Qty</th>
                    <th style={{ ...thBase, position: "sticky", top: 0, background: T.card }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((e, i) => (
                    <tr key={`${e.ticker}-${e.date}-${i}`}>
                      <td style={{ ...tdBase, textAlign: "left", color: T.textDim }}>{e.date}</td>
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
  const [posOpen, setPosOpen] = useState(true);
  const [histOpen, setHistOpen] = useState(false);
  const [yoyOpen, setYoyOpen] = useState(true);

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

                {/* KPI cards */}
                <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                  <KpiCard label="All Time" value={fmtUSD0(kpis.allTime, valuesHidden)} />
                  <KpiCard label="YTD" value={fmtUSD0(kpis.ytd, valuesHidden)} yoy={kpis.yoyYtd} />
                  <KpiCard label="This Month" value={fmtUSD0(kpis.month, valuesHidden)} yoy={kpis.yoyMonth} />
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
                  US dividends only, fetched from Yahoo Finance. Updated daily after US market close.
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

      {/* ── Dividend History (audit) ── */}
      {state === "done" && (
        <DividendHistoryTable
          events={events}
          valuesHidden={valuesHidden}
          open={histOpen}
          onToggle={() => setHistOpen((v) => !v)}
        />
      )}

      {/* ── Year vs Year comparator ── */}
      {state === "done" && (
        <YearVsYearTable
          events={events}
          valuesHidden={valuesHidden}
          open={yoyOpen}
          onToggle={() => setYoyOpen((v) => !v)}
        />
      )}
    </div>
  );
}
