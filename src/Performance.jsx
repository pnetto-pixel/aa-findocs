// src/Performance.jsx — Performance (TEST ONLY) view
// Lazy-loaded. Shows portfolio vs SPY total return chart since first transaction.

import { useEffect, useState } from "react";
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

async function loadPerfHistory(auth, transactions) {
  const res = await fetch("/api/perf-history", {
    method: "POST",
    headers: { ...authHeaders(auth), "Content-Type": "application/json" },
    body: JSON.stringify({ transactions }),
  });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = `Perf history error ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}%`;
}

function fmtDate(dateStr) {
  // "2024-03-15" → "Mar '24"
  try {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  } catch {
    return dateStr;
  }
}

function kpiColor(n) {
  if (n == null || isNaN(n)) return T.textDim;
  if (n > 0) return T.green;
  if (n < 0) return T.red;
  return T.textDim;
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
          {p.name}: {p.value > 0 ? "+" : ""}
          {p.value?.toFixed(2)}%
        </div>
      ))}
    </div>
  );
}

export default function PerformanceView({ auth, onAuthFail }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [lastPortfolio, setLastPortfolio] = useState(null);
  const [lastSpy, setLastSpy] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setError(null);

    (async () => {
      try {
        const transactions = await loadTransactions(auth);
        const { dates, portfolio, spy } = await loadPerfHistory(auth, transactions);

        if (cancelled) return;

        if (!dates?.length) {
          setState("done");
          setChartData([]);
          return;
        }

        // Subsample dates for the X-axis label readability (show ~12 labels max)
        const step = Math.max(1, Math.floor(dates.length / 12));
        const data = dates.map((d, i) => ({
          date: d,
          label: i % step === 0 ? fmtDate(d) : "",
          portfolio: portfolio[i],
          spy: spy[i],
        }));

        setChartData(data);
        setLastPortfolio(portfolio[portfolio.length - 1]);
        setLastSpy(spy[spy.length - 1]);
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

      {state === "done" && chartData.length === 0 && (
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: T.textDim,
            padding: "40px 0",
            textAlign: "center",
          }}
        >
          No eligible transactions found. Add equity transactions to see performance.
        </div>
      )}

      {state === "done" && chartData.length > 0 && (
        <>
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
              label="Portfolio total return"
              value={fmt(lastPortfolio)}
              color={kpiColor(lastPortfolio)}
            />
            <KpiCard
              label="S&P 500 same period"
              value={fmt(lastSpy)}
              color={kpiColor(lastSpy)}
            />
            <KpiCard
              label="Alpha"
              value={fmt(alpha)}
              color={kpiColor(alpha)}
            />
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
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData} margin={{ top: 4, right: 20, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                <XAxis
                  dataKey="label"
                  tick={{ fontFamily: FONT_MONO, fontSize: 10, fill: T.textFaint }}
                  tickLine={false}
                  axisLine={{ stroke: T.border }}
                  interval={0}
                />
                <YAxis
                  tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`}
                  tick={{ fontFamily: FONT_MONO, fontSize: 10, fill: T.textFaint }}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  wrapperStyle={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    paddingTop: 8,
                    color: T.textDim,
                  }}
                />
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
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
