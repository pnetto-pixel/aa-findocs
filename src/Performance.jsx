// src/Performance.jsx — Performance (TEST ONLY) view
// Lazy-loaded. Shows portfolio USD value by default; toggling "vs S&P 500"
// switches to a TWR % comparison chart.

import { useEffect, useState, useMemo } from "react";
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

function fmtDate(dateStr) {
  try {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  } catch {
    return dateStr;
  }
}

function fmtYear(dateStr) {
  return dateStr ? dateStr.slice(0, 4) : dateStr;
}

// Returns up to 6 evenly-spaced date strings from data, deduped by their displayed label.
function getXTicks(data, yearOnly) {
  if (data.length === 0) return [];
  const MAX = 6;
  const n = data.length;
  const fmt = yearOnly ? fmtYear : fmtDate;
  const seen = new Set();
  const ticks = [];
  for (let i = 0; i < MAX; i++) {
    const idx = Math.round((i / (MAX - 1)) * (n - 1));
    const date = data[idx].date;
    const label = fmt(date);
    if (!seen.has(label)) {
      seen.add(label);
      ticks.push(date);
    }
  }
  return ticks;
}

function kpiColor(n) {
  if (n == null || isNaN(n)) return T.textDim;
  if (n > 0) return T.green;
  if (n < 0) return T.red;
  return T.textDim;
}

const PERIODS = [
  { label: "1M", days: 30 },
  { label: "3M", days: 91 },
  { label: "6M", days: 182 },
  { label: "YTD", ytd: true },
  { label: "1Y", days: 365 },
  { label: "3Y", days: 1095 },
  { label: "5Y", days: 1825 },
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

  const step = Math.max(1, Math.floor(slice.length / 10));
  const data = slice.map((d, i) => ({
    date: d.date,
    label: i % step === 0 ? fmtDate(d.date) : "",
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
        background: T.card,
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

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
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
      <div style={{ color: T.textDim, marginBottom: 6 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}:{" "}
          {p.dataKey === "usd"
            ? fmtUSD(p.value)
            : `${p.value > 0 ? "+" : ""}${p.value?.toFixed(2)}%`}
        </div>
      ))}
    </div>
  );
}


export default function PerformanceView({ auth, onAuthFail }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState(null);
  const [rawData, setRawData] = useState([]); // all dates, unfiltered
  const [meta, setMeta] = useState(null);
  const [period, setPeriod] = useState("1Y");
  const [comparing, setComparing] = useState(false); // false = USD chart, true = % comparison

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setError(null);

    (async () => {
      try {
        const transactions = await loadTransactions(auth);
        const result = await loadPerfHistory(auth, transactions);
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

  const yearOnly = useMemo(() => {
    if (chartData.length < 2) return false;
    const spanDays = (new Date(chartData[chartData.length - 1].date) - new Date(chartData[0].date)) / 86400000;
    return spanDays > 365 * 2;
  }, [chartData]);

  const xTicks = useMemo(() => getXTicks(chartData, yearOnly), [chartData, yearOnly]);

  const alpha =
    lastPortfolio != null && lastSpy != null
      ? +(lastPortfolio - lastSpy).toFixed(2)
      : null;

  return (
    <div style={{ paddingBottom: 40 }}>
      {/* Page title */}
      <h1
        style={{
          fontFamily: FONT_DISPLAY,
          fontWeight: 500,
          fontSize: 44,
          lineHeight: 1,
          margin: "12px 0 4px",
          letterSpacing: "-0.02em",
          fontStyle: "italic",
          color: T.text,
        }}
      >
        Performance{" "}
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            fontStyle: "normal",
            fontWeight: 400,
            letterSpacing: "0.1em",
            color: T.gold,
            verticalAlign: "middle",
          }}
        >
          TEST ONLY
        </span>
      </h1>

      {/* Disclaimer */}
      <p
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: T.textFaint,
          margin: "0 0 24px",
          letterSpacing: "0.04em",
        }}
      >
        Excludes fixed income &amp; unallocated assets
      </p>

      {state === "loading" && (
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: T.textDim,
            padding: "40px 0",
            textAlign: "center",
          }}
        >
          Loading performance data…
        </div>
      )}

      {state === "error" && (
        <div
          style={{
            background: T.card,
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
            background: T.card,
            border: `1px solid ${T.borderSoft}`,
            borderRadius: 4,
            padding: "20px 24px",
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: T.textDim,
          }}
        >
          <div style={{ marginBottom: 12 }}>
            {meta?.reason === "no-eligible-transactions"
              ? "No transactions in eligible asset classes (Stocks, BRA Stocks, Alternative, Real Estate)."
              : meta?.reason === "no-priced-days"
              ? "Could not fetch enough historical price data to build a chart."
              : "No performance data available."}
          </div>
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
              marginBottom: 16,
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
              value={fmtUSD(lastUSD)}
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
              background: T.card,
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
                  dataKey="date"
                  ticks={xTicks}
                  tickFormatter={yearOnly ? fmtYear : fmtDate}
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
                    tickFormatter={fmtUSDAxis}
                    tick={{ fontFamily: FONT_MONO, fontSize: 10, fill: T.textFaint }}
                    tickLine={false}
                    axisLine={false}
                    width={64}
                  />
                )}
                <Tooltip
                  content={<CustomTooltip />}
                  labelFormatter={(label) => {
                    const d = new Date(label);
                    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                  }}
                />
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
        </>
      )}

    </div>
  );
}
