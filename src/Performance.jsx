// src/Performance.jsx — Performance view
// Lazy-loaded. Shows portfolio USD value by default; toggling "vs S&P 500"
// switches to a TWR % comparison chart.

import { useEffect, useState, useMemo, Fragment } from "react";
import { ChevronDown, TrendingUp, BarChart2 } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

const FONT_DISPLAY = "'Fraunces', Georgia, serif";
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
  blue: "#60a5fa",
  orange: "#fb923c",
};

function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

async function loadTransactions(auth) {
  const res = await fetch("/api/transactions", { headers: authHeaders(auth) });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = `Storage error ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return Array.isArray(data.transactions) ? data.transactions : [];
}

async function postPerfHistory(auth, body) {
  const res = await fetch("/api/perf-history", {
    method: "POST",
    headers: { ...authHeaders(auth), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = `Perf history error ${res.status}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

async function loadPerfHistory(auth, transactions) {
  return postPerfHistory(auth, { transactions });
}

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}%`;
}

function fmtUSD(n) {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtUSDAxis(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtDateLabel(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// Computes X-axis tick timestamps and formatter for a given period.
// Uses calendar boundaries (weeks / months / years) so ticks always land on
// natural dates and recharts' numeric time scale spaces them proportionally.
function computeXAxis(data, period) {
  if (!data.length) return { ticks: [], tickFormatter: () => "" };

  const firstTs = data[0].dateTs;
  const lastTs  = data[data.length - 1].dateTs;
  const first   = new Date(firstTs);
  const last    = new Date(lastTs);
  const ticks   = [];

  if (period === "1M") {
    // Weekly ticks aligned to the next Monday inside the range
    const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()));
    const dow = d.getUTCDay(); // 0=Sun … 6=Sat
    d.setUTCDate(d.getUTCDate() + (dow === 1 ? 7 : (8 - dow) % 7 || 7));
    while (d.getTime() <= lastTs) {
      ticks.push(d.getTime());
      d.setUTCDate(d.getUTCDate() + 7);
    }
    return {
      ticks,
      tickFormatter: (ts) =>
        new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    };
  }

  if (period === "5Y" || period === "MAX") {
    const spanYears = (lastTs - firstTs) / (365.25 * 86400000);
    const step = spanYears > 8 ? 2 : 1;
    for (let y = first.getUTCFullYear() + 1; y <= last.getUTCFullYear(); y++) {
      if ((y - first.getUTCFullYear() - 1) % step === 0) ticks.push(Date.UTC(y, 0, 1));
    }
    return {
      ticks,
      tickFormatter: (ts) => String(new Date(ts).getUTCFullYear()),
    };
  }

  // 6M, YTD, 1Y — first-of-month ticks; 1Y skips every other month (~6 labels)
  const monthStep = period === "1Y" ? 2 : 1;
  const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  let count = 0;
  while (d.getTime() <= lastTs) {
    if (count % monthStep === 0) ticks.push(d.getTime());
    count++;
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return {
    ticks,
    tickFormatter: (ts) =>
      new Date(ts).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
  };
}

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
}

function fmtPrice(n) {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtQty(n) {
  if (n == null || isNaN(n)) return "—";
  const r = Math.round(n * 10000) / 10000;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(4).replace(/\.?0+$/, "");
}

function kpiColor(n) {
  if (n == null || isNaN(n)) return T.textDim;
  if (n > 0) return T.green;
  if (n < 0) return T.red;
  return T.textDim;
}

const PERIODS = [
  { label: "1M",  days: 30 },
  { label: "6M",  days: 182 },
  { label: "YTD", ytd: true },
  { label: "1Y",  days: 365 },
  { label: "5Y",  days: 1825 },
  { label: "MAX", days: Infinity },
];

function getWindowData(rawData, period) {
  if (!rawData.length) return { data: [], lastPortfolio: null, lastSpy: null, lastUSD: null };

  const p = PERIODS.find((x) => x.label === period) || PERIODS.find((x) => x.label === "1Y");
  let cutoff = null;
  if (p.ytd) {
    cutoff = `${new Date().getFullYear()}-01-01`;
  } else if (p.days !== Infinity) {
    const d = new Date(Date.now() - p.days * 86400 * 1000);
    cutoff = d.toISOString().slice(0, 10);
  }

  let startIdx = 0;
  if (cutoff) {
    const found = rawData.findIndex((d) => d.date >= cutoff);
    startIdx = found >= 0 ? found : rawData.length - 1;
  }

  const slice = rawData.slice(startIdx);
  if (!slice.length) return { data: [], lastPortfolio: null, lastSpy: null, lastUSD: null };

  const baseP = slice[0].portfolio;
  const baseS = slice[0].spy;
  const toWin = (v, base) => +((((1 + v / 100) / (1 + base / 100) - 1) * 100).toFixed(2));

  const data = slice.map((d) => ({
    date: d.date,
    dateTs: new Date(d.date + "T00:00:00Z").getTime(),
    portfolio: toWin(d.portfolio, baseP),
    spy: toWin(d.spy, baseS),
    usd: d.usd,
  }));

  const last = data[data.length - 1];
  return {
    data,
    lastPortfolio: last.portfolio,
    lastSpy: last.spy,
    lastUSD: last.usd,
  };
}

function KpiCard({ label, value, color }) {
  return (
    <div
      style={{
        background: T.cardElev,
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 4,
        padding: "18px 20px",
        flex: "1 1 0",
        minWidth: 140,
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
          fontSize: 26,
          fontWeight: 700,
          color: color || T.text,
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label, valuesHidden }) {
  if (!active || !payload?.length) return null;
  // label arrives as a Unix-ms timestamp when XAxis type="number"
  const dateLabel = typeof label === "number"
    ? new Date(label).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : label;
  return (
    <div
      style={{
        background: T.cardElev,
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        padding: "10px 14px",
        fontFamily: FONT_MONO,
        fontSize: 12,
      }}
    >
      <div style={{ color: T.textDim, marginBottom: 6 }}>{dateLabel}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}:{" "}
          {p.dataKey === "usd"
            ? (valuesHidden ? "$ ••••" : fmtUSD(p.value))
            : `${p.value > 0 ? "+" : ""}${p.value?.toFixed(2)}%`}
        </div>
      ))}
    </div>
  );
}

// Width reserved for the frozen Ticker column (kept in sync between header,
// body and TOTAL row so the sticky offset lines up).
const TICKER_COL_WIDTH = 92;

function aggFromRows(rows) {
  const totalCost = rows.reduce((s, r) => s + r.totalCost, 0);
  const totalValue = rows.reduce((s, r) => s + r.totalValue, 0);
  const totalGainLoss = totalValue - totalCost;
  const gainLossPct = totalCost > 0 ? (totalValue / totalCost - 1) * 100 : null;
  return { totalCost, totalValue, totalGainLoss, gainLossPct };
}

function PositionPerformanceTable({ rows, valuesHidden, open, onToggle }) {
  const [sortCol, setSortCol] = useState("totalValue");
  const [sortDir, setSortDir] = useState("desc");
  const [grouped, setGrouped] = useState(false);
  const [collapsedClasses, setCollapsedClasses] = useState(() => new Set());

  function toggleClass(cls) {
    setCollapsedClasses((prev) => {
      const next = new Set(prev);
      next.has(cls) ? next.delete(cls) : next.add(cls);
      return next;
    });
  }

  function sortRows(arr) {
    return [...arr].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      const an = av ?? (sortDir === "asc" ? Infinity : -Infinity);
      const bn = bv ?? (sortDir === "asc" ? Infinity : -Infinity);
      return sortDir === "asc" ? an - bn : bn - an;
    });
  }

  const sortedRows = useMemo(() => sortRows(rows), [rows, sortCol, sortDir]);

  const totals = useMemo(() => aggFromRows(rows), [rows]);

  // Group rows by assetClass, each group sorted by sortCol.
  const classGroups = useMemo(() => {
    if (!grouped) return null;
    const map = {};
    for (const row of rows) {
      const cls = row.assetClass || "Uncategorized";
      if (!map[cls]) map[cls] = [];
      map[cls].push(row);
    }
    return Object.entries(map)
      .map(([cls, clsRows]) => ({ cls, rows: sortRows(clsRows), ...aggFromRows(clsRows) }))
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [rows, grouped, sortCol, sortDir]);

  function handleSort(col) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  const COLS = [
    { key: "ticker",       label: "Ticker",          align: "left"  },
    { key: "qty",          label: "Qty",             align: "right" },
    { key: "avgCost",      label: "Avg Cost",        align: "right" },
    { key: "currentPrice", label: "Price",           align: "right" },
    { key: "totalCost",    label: "Total Cost",      align: "right" },
    { key: "totalValue",   label: "Current Value",   align: "right" },
    { key: "gainLossPct",  label: "Gain/Loss %",     align: "right" },
    { key: "totalGainLoss",label: "Total Gain/Loss", align: "right" },
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
    const gainColor = row.totalGainLoss > 0 ? T.green : row.totalGainLoss < 0 ? T.red : T.textDim;
    const pctColor  = row.gainLossPct  > 0 ? T.green : row.gainLossPct  < 0 ? T.red : T.textDim;
    switch (col.key) {
      case "ticker":
        return (
          <td key={col.key} style={{ ...tdBase, ...stickyCol(T.card), textAlign: "left", color: T.gold, letterSpacing: "0.06em", fontWeight: 600 }}>
            {row.ticker}
          </td>
        );
      case "qty":           return <td key={col.key} style={tdBase}>{fmtQty(row.qty)}</td>;
      case "avgCost":       return <td key={col.key} style={tdBase}>{valuesHidden ? "$ ••••" : fmtPrice(row.avgCost)}</td>;
      case "currentPrice":  return <td key={col.key} style={tdBase}>{valuesHidden ? "$ ••••" : fmtPrice(row.currentPrice)}</td>;
      case "totalCost":     return <td key={col.key} style={tdBase}>{valuesHidden ? "$ ••••" : fmtUSD(row.totalCost)}</td>;
      case "totalValue":    return <td key={col.key} style={tdBase}>{valuesHidden ? "$ ••••" : fmtUSD(row.totalValue)}</td>;
      case "gainLossPct":
        return <td key={col.key} style={{ ...tdBase, color: pctColor, fontWeight: 600 }}>{row.gainLossPct != null ? `${row.gainLossPct > 0 ? "+" : ""}${row.gainLossPct.toFixed(2)}%` : "—"}</td>;
      case "totalGainLoss":
        return <td key={col.key} style={{ ...tdBase, color: gainColor }}>{valuesHidden ? "$ ••••" : `${row.totalGainLoss > 0 ? "+" : ""}${fmtUSD(row.totalGainLoss)}`}</td>;
      default: return <td key={col.key} style={tdBase}>—</td>;
    }
  }

  // Renders a summary row (TOTAL or per-class header). `label` appears in the sticky
  // Ticker cell. When `collapsible` is set, a chevron is shown to expand/collapse.
  function renderSummaryRow(label, agg, bg, zIndex = 2, collapsible = false, collapsed = false) {
    const summaryTd = { ...tdBase, background: bg, fontWeight: 600, borderBottom: `1px solid ${T.border}`, borderTop: `1px solid ${T.border}` };
    const gainColor = agg.totalGainLoss > 0 ? T.green : agg.totalGainLoss < 0 ? T.red : T.textDim;
    const pctColor  = agg.gainLossPct  > 0 ? T.green : agg.gainLossPct  < 0 ? T.red : T.textDim;
    return COLS.map((col) => {
      switch (col.key) {
        case "ticker":
          return (
            <td key={col.key} style={{ ...summaryTd, ...stickyCol(bg, zIndex), textAlign: "left", color: T.text, letterSpacing: "0.08em", fontSize: 11 }}>
              {collapsible ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <ChevronDown
                    size={11}
                    color={T.textFaint}
                    style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}
                  />
                  {label}
                </span>
              ) : label}
            </td>
          );
        case "totalCost":
          return <td key={col.key} style={summaryTd}>{valuesHidden ? "$ ••••" : fmtUSD(agg.totalCost)}</td>;
        case "totalValue":
          return <td key={col.key} style={summaryTd}>{valuesHidden ? "$ ••••" : fmtUSD(agg.totalValue)}</td>;
        case "gainLossPct":
          return <td key={col.key} style={{ ...summaryTd, color: pctColor }}>{agg.gainLossPct != null ? `${agg.gainLossPct > 0 ? "+" : ""}${agg.gainLossPct.toFixed(2)}%` : "—"}</td>;
        case "totalGainLoss":
          return <td key={col.key} style={{ ...summaryTd, color: gainColor }}>{valuesHidden ? "$ ••••" : `${agg.totalGainLoss > 0 ? "+" : ""}${fmtUSD(agg.totalGainLoss)}`}</td>;
        default: return <td key={col.key} style={summaryTd} />;
      }
    });
  }

  return (
    <div style={{ marginTop: 28 }}>
      {/* Card header — same pattern as Rebalance Suggestions */}
      <button
        onClick={onToggle}
        style={{
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
        }}
      >
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
          <BarChart2 size={14} strokeWidth={2} />
          Position Performance
        </span>
        <ChevronDown
          size={16}
          style={{
            color: T.textDim,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.2s",
          }}
        />
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
          {/* Group by toggle */}
          <div style={{ padding: "12px 16px 0", display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={() => setGrouped((g) => !g)}
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.1em",
                padding: "4px 10px",
                border: `1px solid ${grouped ? T.gold + "66" : T.border}`,
                borderRadius: 3,
                background: grouped ? T.gold + "14" : "transparent",
                color: grouped ? T.gold : T.textFaint,
                cursor: "pointer",
                transition: "color 0.15s, background 0.15s, border-color 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              {grouped ? "Flat view" : "Group by class"}
            </button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: 900, borderCollapse: "collapse" }}>
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
                {/* Always-visible TOTAL row */}
                <tr>{renderSummaryRow("TOTAL", totals, T.cardElev, 2)}</tr>

                {grouped && classGroups ? (
                  classGroups.map(({ cls, rows: clsRows, ...agg }) => {
                    const isCollapsed = collapsedClasses.has(cls);
                    return (
                      <Fragment key={`cls-${cls}`}>
                        <tr onClick={() => toggleClass(cls)} style={{ cursor: "pointer" }}>
                          {renderSummaryRow(cls, agg, T.bg, 2, true, isCollapsed)}
                        </tr>
                        {!isCollapsed && clsRows.map((row) => (
                          <tr key={row.ticker}>{COLS.map((col) => renderCell(row, col))}</tr>
                        ))}
                      </Fragment>
                    );
                  })
                ) : (
                  sortedRows.map((row) => (
                    <tr key={row.ticker}>{COLS.map((col) => renderCell(row, col))}</tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PerformanceView({ auth, onAuthFail, valuesHidden, holdings }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState(null);
  const [rawData, setRawData] = useState([]); // all dates, unfiltered
  const [meta, setMeta] = useState(null);
  const [period, setPeriod] = useState("1Y");
  const [comparing, setComparing] = useState(false); // false = USD chart, true = % comparison
  const [transactions, setTransactions] = useState([]);
  const [perfCardOpen, setPerfCardOpen] = useState(true);
  const [posTableOpen, setPosTableOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setError(null);

    (async () => {
      try {
        const txs = await loadTransactions(auth);
        if (!cancelled) setTransactions(txs);
        const result = await loadPerfHistory(auth, txs);
        const { dates, portfolio, portfolioUSD, spy, meta: respMeta } = result;

        if (cancelled) return;

        setMeta(respMeta || null);

        if (!dates?.length) {
          setState("done");
          setRawData([]);
          return;
        }

        setRawData(
          dates.map((d, i) => ({
            date: d,
            portfolio: portfolio[i],
            usd: portfolioUSD?.[i] ?? null,
            spy: spy[i],
          }))
        );
        setState("done");
      } catch (err) {
        if (cancelled) return;
        if (err.code === 401 && onAuthFail) {
          onAuthFail();
          return;
        }
        setError(err.message || "Failed to load performance data");
        setState("error");
      }
    })();

    return () => { cancelled = true; };
  }, [auth]);

  const hasUSD = rawData.some((d) => d.usd != null);

  const { data: chartData, lastPortfolio, lastSpy, lastUSD } = useMemo(
    () => getWindowData(rawData, period),
    [rawData, period]
  );

  // If API response has no USD values (old cache), force comparison mode.
  const effectiveComparing = comparing || !hasUSD;

  const priceMap = useMemo(() => {
    const map = {};
    for (const h of holdings || []) {
      if (!h.ticker) continue;
      const tk = h.ticker.toUpperCase();
      if (h.type !== "manual" && h.price != null) {
        map[tk] = {
          price: h.price,
          // fxRate = BRL per USD. May be null on holdings not yet refreshed
          // after the field was introduced — derive it from originalPrice/price.
          fxRate: h.fxRate ?? (h.originalPrice && h.price > 0 ? h.originalPrice / h.price : null),
          assetClass: h.assetClassOverride || h.assetClass || "Uncategorized",
        };
      } else if (h.manualMode === "qty_price" && h.manualPrice != null) {
        map[tk] = {
          price: h.manualPrice,
          fxRate: null,
          assetClass: h.assetClassOverride || h.assetClass || "Uncategorized",
        };
      }
    }
    return map;
  }, [holdings]);

  const positionRows = useMemo(() => {
    if (!transactions.length) return [];
    const positions = {};
    for (const tx of transactions) {
      const ticker = tx.ticker?.toUpperCase();
      if (!ticker) continue;
      if (!positions[ticker]) positions[ticker] = { totalQty: 0, totalCost: 0, noFx: false, assetClass: null, lastBuyDate: null, lastBuyNotes: null };
      const pos = positions[ticker];
      // Asset class comes from the transactions themselves (last non-empty wins),
      // not from the current holding.
      if (tx.assetClass) pos.assetClass = tx.assetClass;
      const qty = Number(tx.qty) || 0;
      let price = Number(tx.price) || 0;
      if (isBrazilianTicker(ticker)) {
        const fxRate = priceMap[ticker]?.fxRate ?? null;
        if (!fxRate) pos.noFx = true;
        else price = price / fxRate;
      }
      if (tx.side === "buy") {
        pos.totalQty += qty;
        pos.totalCost += qty * price;
        if (!pos.lastBuyDate || tx.date > pos.lastBuyDate) {
          pos.lastBuyDate = tx.date;
          pos.lastBuyNotes = tx.notes || "";
        }
      } else if (tx.side === "sell") {
        const avgBefore = pos.totalQty > 0 ? pos.totalCost / pos.totalQty : 0;
        pos.totalQty -= qty;
        pos.totalCost -= avgBefore * qty;
        if (pos.totalQty < 0.0001) { pos.totalQty = 0; pos.totalCost = 0; }
      }
    }
    const rows = [];
    for (const [ticker, pos] of Object.entries(positions)) {
      if (pos.totalQty < 0.0001) continue;
      if (pos.noFx) continue;
      const assetClass = pos.assetClass || "Uncategorized";

      // Bank Bonds: calculate accrued value locally; no live price fetch.
      if (assetClass === "Bank Bonds") {
        const avgCost = pos.totalCost / pos.totalQty;
        const totalCost = avgCost * pos.totalQty;
        let totalValue = totalCost; // fallback: face value
        if (pos.lastBuyNotes && pos.lastBuyDate) {
          const couponM = pos.lastBuyNotes.match(/(\d+\.\d+)%/);
          const maturityM = pos.lastBuyNotes.match(/\d{2}\/\d{2}\/\d{4}$/);
          if (couponM && maturityM) {
            const annualRate = parseFloat(couponM[1]) / 100;
            const purchaseTs = new Date(pos.lastBuyDate + "T00:00:00").getTime();
            const todayTs = Date.now();
            const daysSincePurchase = (todayTs - purchaseTs) / 86400000;
            totalValue = totalCost + totalCost * annualRate * (daysSincePurchase / 365);
          }
        }
        const totalGainLoss = totalValue - totalCost;
        const gainLossPct = totalCost > 0 ? (totalValue / totalCost - 1) * 100 : null;
        rows.push({ ticker, assetClass, qty: pos.totalQty, avgCost, currentPrice: null, totalCost, totalValue, totalGainLoss, gainLossPct });
        continue;
      }

      const entry = priceMap[ticker];
      const currentPrice = entry?.price;
      if (currentPrice == null) continue;
      const avgCost = pos.totalCost / pos.totalQty;
      const totalCost = avgCost * pos.totalQty;
      const totalValue = currentPrice * pos.totalQty;
      const totalGainLoss = totalValue - totalCost;
      const gainLossPct = avgCost > 0 ? (currentPrice / avgCost - 1) * 100 : null;
      rows.push({ ticker, assetClass, qty: pos.totalQty, avgCost, currentPrice, totalCost, totalValue, totalGainLoss, gainLossPct });
    }
    return rows;
  }, [transactions, priceMap]);

  const xAxis = useMemo(() => computeXAxis(chartData, period), [chartData, period]);

  const alpha =
    lastPortfolio != null && lastSpy != null
      ? +(lastPortfolio - lastSpy).toFixed(2)
      : null;

  const lastDate = rawData.length > 0 ? rawData[rawData.length - 1].date : null;

  // Live net worth: sum of all priced positions using current holdings prices.
  // This matches the Position Performance total and is always up-to-date,
  // unlike the chart's lastUSD which comes from cached historical candles.
  const liveNetWorth = useMemo(
    () => positionRows.length > 0 ? positionRows.reduce((s, r) => s + r.totalValue, 0) : null,
    [positionRows]
  );

  // Shared card header button style (matches Rebalance Suggestions in Holdings tab).
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

  return (
    <div style={{ paddingBottom: 40 }}>
      {/* Page title */}
      <h1
        style={{
          fontFamily: FONT_DISPLAY,
          fontWeight: 500,
          fontSize: 44,
          lineHeight: 1,
          margin: "12px 0 20px",
          letterSpacing: "-0.02em",
          fontStyle: "italic",
          color: T.text,
        }}
      >
        Performance
      </h1>

      {/* Portfolio Performance & Net Worth card */}
      <section>
        <button
          onClick={() => setPerfCardOpen((o) => !o)}
          style={cardHeaderStyle(perfCardOpen)}
        >
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
            <TrendingUp size={14} strokeWidth={2} />
            Portfolio Performance &amp; Net Worth
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {state === "loading" && (
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, letterSpacing: "0.06em" }}>
                Loading…
              </span>
            )}
            {state === "done" && lastDate && (
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, letterSpacing: "0.06em" }}>
                as of {fmtDateLabel(lastDate)}
              </span>
            )}
            <ChevronDown
              size={16}
              style={{
                color: T.textDim,
                transform: perfCardOpen ? "rotate(180deg)" : "none",
                transition: "transform 0.2s",
              }}
            />
          </div>
        </button>

        {perfCardOpen && (
          <div style={cardBodyStyle}>
            {state === "loading" && (
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 13,
                  color: T.textDim,
                  padding: "32px 0",
                  textAlign: "center",
                }}
              >
                Loading performance data…
              </div>
            )}

            {state === "error" && (
              <div
                style={{
                  background: T.cardElev,
                  border: `1px solid ${T.red}44`,
                  borderRadius: 4,
                  padding: "16px 20px",
                  fontFamily: FONT_MONO,
                  fontSize: 13,
                  color: T.red,
                }}
              >
                {error}
              </div>
            )}

            {state === "done" && rawData.length === 0 && (
              <div
                style={{
                  background: T.cardElev,
                  borderRadius: 4,
                  padding: "20px 24px",
                  fontFamily: FONT_MONO,
                  fontSize: 13,
                  color: T.textDim,
                }}
              >
                {meta?.reason === "no-eligible-transactions"
                  ? "No transactions in eligible asset classes (Stocks, BRA Stocks, Alternative, Real Estate, Bonds, BRA Fixed Income)."
                  : meta?.reason === "no-priced-days"
                  ? "Could not fetch enough historical price data to build a chart."
                  : "No performance data available."}
              </div>
            )}

            {state === "done" && rawData.length > 0 && (
              <>
                {/* Period selector + compare toggle */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 20,
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", gap: 2 }}>
                    {PERIODS.map(({ label }) => {
                      const active = period === label;
                      return (
                        <button
                          key={label}
                          onClick={() => setPeriod(label)}
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 11,
                            letterSpacing: "0.08em",
                            padding: "5px 10px",
                            border: `1px solid ${active ? T.blue + "66" : T.border}`,
                            borderRadius: 3,
                            background: active ? T.blue + "18" : "transparent",
                            color: active ? T.blue : T.textDim,
                            cursor: "pointer",
                            transition: "color 0.15s, background 0.15s, border-color 0.15s",
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => setComparing((c) => !c)}
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      letterSpacing: "0.08em",
                      padding: "5px 12px",
                      border: `1px solid ${effectiveComparing ? T.orange + "66" : T.border}`,
                      borderRadius: 3,
                      background: effectiveComparing ? T.orange + "18" : "transparent",
                      color: effectiveComparing ? T.orange : T.textDim,
                      cursor: "pointer",
                      transition: "color 0.15s, background 0.15s, border-color 0.15s",
                    }}
                  >
                    {effectiveComparing ? "← Net Worth" : "Compare vs S&P 500"}
                  </button>
                </div>

                {/* KPI cards */}
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    marginBottom: 24,
                    flexWrap: "wrap",
                  }}
                >
                  <KpiCard
                    label="Net Worth"
                    value={valuesHidden ? "$ ••••" : fmtUSD(liveNetWorth ?? lastUSD)}
                    color={T.text}
                  />
                  <KpiCard
                    label={`Portfolio ${period}`}
                    value={fmt(lastPortfolio)}
                    color={kpiColor(lastPortfolio)}
                  />
                  {effectiveComparing && (
                    <>
                      <KpiCard
                        label={`S&P 500 ${period}`}
                        value={fmt(lastSpy)}
                        color={kpiColor(lastSpy)}
                      />
                      <KpiCard
                        label="Alpha"
                        value={fmt(alpha)}
                        color={kpiColor(alpha)}
                      />
                    </>
                  )}
                </div>

                {/* Chart */}
                <div
                  style={{
                    background: T.cardElev,
                    border: `1px solid ${T.borderSoft}`,
                    borderRadius: 4,
                    padding: "20px 8px 8px",
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
                      paddingLeft: 8,
                    }}
                  >
                    {effectiveComparing ? "Portfolio VS S&P 500" : "Net Worth Growth"}
                  </div>
                  <ResponsiveContainer width="100%" height={320}>
                    <LineChart data={chartData} margin={{ top: 4, right: 20, left: 8, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                      <XAxis
                        dataKey="dateTs"
                        type="number"
                        scale="time"
                        domain={["dataMin", "dataMax"]}
                        ticks={xAxis.ticks}
                        tickFormatter={xAxis.tickFormatter}
                        tick={{ fontFamily: FONT_MONO, fontSize: 10, fill: T.textFaint }}
                        tickLine={false}
                        axisLine={{ stroke: T.border }}
                        angle={-45}
                        textAnchor="end"
                        height={60}
                      />
                      {effectiveComparing ? (
                        <YAxis
                          tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`}
                          tick={{ fontFamily: FONT_MONO, fontSize: 10, fill: T.textFaint }}
                          tickLine={false}
                          axisLine={false}
                          width={52}
                        />
                      ) : (
                        <YAxis
                          tickFormatter={valuesHidden ? () => "" : fmtUSDAxis}
                          tick={{ fontFamily: FONT_MONO, fontSize: 10, fill: T.textFaint }}
                          tickLine={false}
                          axisLine={false}
                          width={valuesHidden ? 16 : 64}
                        />
                      )}
                      <Tooltip content={(props) => <CustomTooltip {...props} valuesHidden={valuesHidden} />} />
                      {effectiveComparing && (
                        <Legend
                          wrapperStyle={{
                            fontFamily: FONT_MONO,
                            fontSize: 11,
                            paddingTop: 8,
                            color: T.textDim,
                          }}
                        />
                      )}
                      {effectiveComparing ? (
                        <>
                          <Line
                            type="monotone"
                            dataKey="portfolio"
                            name="Portfolio"
                            stroke={T.blue}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4, fill: T.blue }}
                          />
                          <Line
                            type="monotone"
                            dataKey="spy"
                            name="S&P 500"
                            stroke={T.orange}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4, fill: T.orange }}
                          />
                        </>
                      ) : (
                        <Line
                          type="monotone"
                          dataKey="usd"
                          name="Portfolio"
                          stroke={T.blue}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4, fill: T.blue }}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    color: T.textFaint,
                    marginTop: 12,
                    letterSpacing: "0.04em",
                  }}
                >
                  Excludes Cash and Unallocated assets. Updated daily after US market close.
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {/* Position Performance card */}
      {state === "done" && positionRows.length > 0 && (
        <PositionPerformanceTable
          rows={positionRows}
          valuesHidden={valuesHidden}
          open={posTableOpen}
          onToggle={() => setPosTableOpen((v) => !v)}
        />
      )}
    </div>
  );
}
