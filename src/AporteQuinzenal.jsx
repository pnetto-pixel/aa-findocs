// src/AporteQuinzenal.jsx
// Tab: Contributions
// Item 25: monthly plan → split into two halves
// Item 26: track invested vs planned per half (this month)
// Item 27: full contribution history bar chart (buy transactions, excluding DELL vesting)

import { useEffect, useState, useMemo } from "react";
import { Plus, Trash2, ChevronDown } from "lucide-react";
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
};

const LS_CONFIG = "aporteConfig";
const LS_REALIZADO = "aporteRealizado";

const DEFAULT_CONFIG = {
  monthlyFixed: "",
  dividendsLastMonth: "",
  dellSale: "",
  extras: [],
};

const INPUT_STYLE = {
  background: "#191d24",
  border: "1px solid #222831",
  borderRadius: 4,
  color: "#ece8e0",
  fontFamily: FONT_MONO,
  fontSize: 13,
  padding: "5px 8px",
  width: 100,
  textAlign: "right",
  outline: "none",
};

const DATE_INPUT_STYLE = {
  background: "#191d24",
  border: "1px solid #222831",
  borderRadius: 4,
  color: "#ece8e0",
  fontFamily: FONT_MONO,
  fontSize: 12,
  padding: "5px 8px",
  outline: "none",
  colorScheme: "dark",
  flex: 1,
  minWidth: 0,
};

const PERIOD_OPTIONS = ["Month", "Quarter", "Half", "Year"];

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const v = localStorage.getItem(LS_CONFIG);
    if (v) return { ...DEFAULT_CONFIG, ...JSON.parse(v) };
  } catch {}
  return { ...DEFAULT_CONFIG };
}

function loadRealizado() {
  try {
    const v = localStorage.getItem(LS_REALIZADO);
    if (v) return JSON.parse(v);
  } catch {}
  return {};
}

function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

async function fetchTransactions(auth) {
  const res = await fetch("/api/transactions", { headers: authHeaders(auth) });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return Array.isArray(data.transactions) ? data.transactions : [];
}

function txToUSD(tx, usdBrlRate) {
  const qty = parseFloat(tx.qty) || 0;
  const price = parseFloat(tx.price) || 0;
  const fee = parseFloat(tx.fee) || 0;
  const total = qty * price + fee;
  if (tx.currency === "BRL" && usdBrlRate > 0) {
    return total / usdBrlRate;
  }
  return total;
}

// Full history from first transaction, grouped by the chosen granularity.
// DELL buys are excluded (stock vesting, not real contributions).
// Optional fromDate/toDate ("YYYY-MM-DD") filter the date range shown.
// groupBy: "Month" | "Quarter" | "Half" | "Year"
function buildChartData(transactions, usdBrlRate, groupBy, fromDate, toDate) {
  const buys = transactions.filter((tx) => {
    if (tx.side !== "buy") return false;
    if ((tx.ticker || "").toUpperCase() === "DELL") return false;
    if (!tx.date) return false;
    if (fromDate && tx.date < fromDate) return false;
    if (toDate && tx.date > toDate) return false;
    return true;
  });
  if (!buys.length) return [];

  const byKey = {};
  for (const tx of buys) {
    const [yStr, mStr] = tx.date.slice(0, 7).split("-");
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    let key;
    if (groupBy === "Month") {
      key = `${yStr}-${mStr}`;
    } else if (groupBy === "Quarter") {
      key = `${y}-Q${Math.ceil(m / 3)}`;
    } else if (groupBy === "Half") {
      key = `${y}-H${m <= 6 ? 1 : 2}`;
    } else {
      key = yStr;
    }
    byKey[key] = (byKey[key] || 0) + txToUSD(tx, usdBrlRate);
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

function fmtAxisUSD(n) {
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function currentMonthLabel() {
  return new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function daysInCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

// ── Sub-components (defined outside to prevent React remounting on re-render) ─

function BarTooltip({ active, payload, label, hidden }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: "#191d24",
        border: "1px solid #222831",
        borderRadius: 4,
        padding: "8px 12px",
        fontFamily: FONT_MONO,
        fontSize: 12,
        color: "#ece8e0",
      }}
    >
      <div style={{ color: "#8a8f99", marginBottom: 4 }}>{label}</div>
      <div style={{ color: "#c9a961" }}>{fmtUSD(payload[0].value, hidden)}</div>
    </div>
  );
}

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

function PlanRow({ label, value, onChange }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "9px 0",
        borderBottom: `1px solid ${T.borderSoft}`,
      }}
    >
      <span style={{ fontFamily: FONT_BODY, fontSize: 13, color: T.textDim, flex: 1 }}>
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.textFaint }}>$</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          style={INPUT_STYLE}
        />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AporteQuinzenal({ auth, onAuthFail, valuesHidden }) {
  const [config, setConfig] = useState(loadConfig);
  const [realizado, setRealizado] = useState(loadRealizado);

  const [transactions, setTransactions] = useState([]);
  const [txLoading, setTxLoading] = useState(true);
  const [txError, setTxError] = useState(null);

  const [groupBy, setGroupBy] = useState("Month");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [planOpen, setPlanOpen] = useState(true);
  const [realizadoOpen, setRealizadoOpen] = useState(true);
  const [histOpen, setHistOpen] = useState(true);

  const [newExtraLabel, setNewExtraLabel] = useState("");
  const [newExtraValue, setNewExtraValue] = useState("");

  const usdBrlRate = useMemo(() => {
    const v = parseFloat(localStorage.getItem("usdBrlRate"));
    return isFinite(v) && v > 0 ? v : 5.7;
  }, []);

  useEffect(() => {
    fetchTransactions(auth)
      .then((txs) => {
        setTransactions(txs);
        setTxLoading(false);
      })
      .catch((e) => {
        if (e.code === 401) {
          onAuthFail();
          return;
        }
        setTxError(e.message || "Failed to load transactions");
        setTxLoading(false);
      });
  }, []);

  function updateConfig(patch) {
    const next = { ...config, ...patch };
    setConfig(next);
    localStorage.setItem(LS_CONFIG, JSON.stringify(next));
  }

  function setHalfRealizado(half, val) {
    const key = `${currentMonthKey()}-${half}`;
    const next = { ...realizado, [key]: val };
    setRealizado(next);
    localStorage.setItem(LS_REALIZADO, JSON.stringify(next));
  }

  function addExtra() {
    const label = newExtraLabel.trim();
    if (!label) return;
    updateConfig({ extras: [...(config.extras || []), { label, value: newExtraValue }] });
    setNewExtraLabel("");
    setNewExtraValue("");
  }

  function removeExtra(i) {
    updateConfig({ extras: (config.extras || []).filter((_, idx) => idx !== i) });
  }

  function updateExtraValue(i, val) {
    const extras = [...(config.extras || [])];
    extras[i] = { ...extras[i], value: val };
    updateConfig({ extras });
  }

  const planTotal = useMemo(() => {
    const fixed = parseFloat(config.monthlyFixed) || 0;
    const divs = parseFloat(config.dividendsLastMonth) || 0;
    const dell = parseFloat(config.dellSale) || 0;
    const extrasSum = (config.extras || []).reduce(
      (s, e) => s + (parseFloat(e.value) || 0),
      0
    );
    return fixed + divs + dell + extrasSum;
  }, [config]);

  const halfPlanned = planTotal / 2;
  const monthKey = currentMonthKey();
  const r1 = parseFloat(realizado[`${monthKey}-1`]) || 0;
  const r2 = parseFloat(realizado[`${monthKey}-2`]) || 0;
  const days = daysInCurrentMonth();

  const chartData = useMemo(
    () => buildChartData(transactions, usdBrlRate, groupBy, fromDate, toDate),
    [transactions, usdBrlRate, groupBy, fromDate, toDate]
  );
  const hasChartData = chartData.some((d) => d.value > 0);

  // Limit x-axis ticks to avoid overlap on small screens
  const xInterval = chartData.length > 12 ? Math.ceil(chartData.length / 10) - 1 : 0;

  const cardStyle = {
    background: T.card,
    border: `1px solid ${T.borderSoft}`,
    borderRadius: 4,
    marginBottom: 16,
    position: "relative",
    overflow: "hidden",
  };

  const goldAccent = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    background: `linear-gradient(to right, ${T.gold}, transparent)`,
  };

  return (
    <div style={{ paddingBottom: 40 }}>
      {/* ── Monthly Plan ── */}
      <section style={cardStyle}>
        <div style={goldAccent} />
        <CardToggle
          label="Monthly Plan"
          sub={currentMonthLabel()}
          open={planOpen}
          onToggle={() => setPlanOpen((v) => !v)}
        />
        {planOpen && (
          <div style={{ padding: "0 20px 20px" }}>
            <PlanRow
              label="Monthly fixed amount"
              value={config.monthlyFixed}
              onChange={(v) => updateConfig({ monthlyFixed: v })}
            />
            <PlanRow
              label="Dividends (last month)"
              value={config.dividendsLastMonth}
              onChange={(v) => updateConfig({ dividendsLastMonth: v })}
            />
            <PlanRow
              label="DELL sale"
              value={config.dellSale}
              onChange={(v) => updateConfig({ dellSale: v })}
            />

            {/* Dynamic extras */}
            {(config.extras || []).map((extra, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "9px 0",
                  borderBottom: `1px solid ${T.borderSoft}`,
                }}
              >
                <span style={{ fontFamily: FONT_BODY, fontSize: 13, color: T.textDim, flex: 1 }}>
                  {extra.label}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.textFaint }}>$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={extra.value}
                    onChange={(e) => updateExtraValue(i, e.target.value)}
                    style={INPUT_STYLE}
                  />
                  <button
                    onClick={() => removeExtra(i)}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: T.textFaint,
                      padding: 2,
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}

            {/* Add extra row */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input
                type="text"
                value={newExtraLabel}
                onChange={(e) => setNewExtraLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addExtra(); }}
                placeholder="Extra label…"
                style={{
                  flex: 1,
                  background: T.cardElev,
                  border: `1px solid ${T.border}`,
                  borderRadius: 4,
                  color: T.text,
                  fontFamily: FONT_BODY,
                  fontSize: 12,
                  padding: "5px 8px",
                  outline: "none",
                }}
              />
              <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.textFaint }}>$</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={newExtraValue}
                onChange={(e) => setNewExtraValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addExtra(); }}
                placeholder="0"
                style={{ ...INPUT_STYLE, width: 90 }}
              />
              <button
                onClick={addExtra}
                style={{
                  background: T.goldDim,
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  color: T.text,
                  padding: "6px 10px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  flexShrink: 0,
                }}
              >
                <Plus size={12} />
                Add
              </button>
            </div>

            {/* Total breakdown */}
            <div style={{ marginTop: 20, borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 14,
                }}
              >
                <span style={{ fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
                  Monthly total
                </span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 16, color: T.text, fontWeight: 600 }}>
                  {fmtUSD(planTotal, valuesHidden)}
                </span>
              </div>

              <div style={{ display: "flex", gap: 12 }}>
                {[1, 2].map((half) => (
                  <div
                    key={half}
                    style={{
                      flex: 1,
                      background: T.cardElev,
                      borderRadius: 4,
                      padding: "12px 14px",
                      border: `1px solid ${T.border}`,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: T.gold,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                        marginBottom: 4,
                      }}
                    >
                      {half === 1 ? "1st" : "2nd"} Half
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textFaint, marginBottom: 6 }}>
                      {half === 1 ? "1–15" : `16–${days}`}
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 15, color: T.text, fontWeight: 600 }}>
                      {fmtUSD(halfPlanned, valuesHidden)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── This Month (Track) ── */}
      <section style={cardStyle}>
        <div style={goldAccent} />
        <CardToggle
          label="This Month"
          sub={currentMonthLabel()}
          open={realizadoOpen}
          onToggle={() => setRealizadoOpen((v) => !v)}
        />
        {realizadoOpen && (
          <div style={{ padding: "0 20px 20px" }}>
            {[1, 2].map((half) => {
              const invested = half === 1 ? r1 : r2;
              const remaining = Math.max(0, halfPlanned - invested);
              const done = invested >= halfPlanned && halfPlanned > 0;
              const dateRange = half === 1 ? "1–15" : `16–${days}`;
              const storedKey = `${monthKey}-${half}`;

              return (
                <div
                  key={half}
                  style={{
                    padding: "16px 0",
                    borderBottom: half === 1 ? `1px solid ${T.borderSoft}` : "none",
                  }}
                >
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: T.gold,
                      marginBottom: 12,
                    }}
                  >
                    {half === 1 ? "1st" : "2nd"} Half — {dateRange}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginBottom: 5 }}>
                        Planned
                      </div>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                        {fmtUSD(halfPlanned, valuesHidden)}
                      </div>
                    </div>

                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginBottom: 5 }}>
                        Invested
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textFaint }}>$</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={realizado[storedKey] ?? ""}
                          onChange={(e) => setHalfRealizado(half, e.target.value)}
                          placeholder="0"
                          style={{ ...INPUT_STYLE, width: 82 }}
                        />
                      </div>
                    </div>

                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginBottom: 5 }}>
                        Remaining
                      </div>
                      {done ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.green }}>
                          Done ✓
                        </div>
                      ) : (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: halfPlanned > 0 ? T.text : T.textFaint }}>
                          {fmtUSD(remaining, valuesHidden)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Contribution History ── */}
      <section style={{ ...cardStyle, marginBottom: 0 }}>
        <div style={goldAccent} />
        <CardToggle
          label="Contribution History"
          sub="All buy transactions · DELL excluded · converted to USD"
          open={histOpen}
          onToggle={() => setHistOpen((v) => !v)}
        />
        {histOpen && (
          <div style={{ padding: "0 20px 24px" }}>
            {/* Group-by selector */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
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

            {/* Date range filter */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textFaint, flexShrink: 0 }}>
                From
              </span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                style={DATE_INPUT_STYLE}
              />
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textFaint, flexShrink: 0 }}>
                to
              </span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                style={DATE_INPUT_STYLE}
              />
              {(fromDate || toDate) && (
                <button
                  onClick={() => { setFromDate(""); setToDate(""); }}
                  style={{
                    background: "none",
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    color: T.textDim,
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    padding: "5px 8px",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  Clear
                </button>
              )}
            </div>

            {txLoading && (
              <div style={{ textAlign: "center", padding: "40px 0", fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                Loading…
              </div>
            )}

            {txError && (
              <div style={{ textAlign: "center", padding: "40px 0", fontFamily: FONT_MONO, fontSize: 13, color: T.red }}>
                {txError}
              </div>
            )}

            {!txLoading && !txError && !hasChartData && (
              <div style={{ textAlign: "center", padding: "40px 0", fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                No buy transactions recorded yet
              </div>
            )}

            {!txLoading && !txError && hasChartData && (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={chartData}
                  margin={{ top: 8, right: 4, left: 0, bottom: 50 }}
                >
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
                  <Tooltip
                    content={(props) => (
                      <BarTooltip {...props} hidden={valuesHidden} />
                    )}
                  />
                  <Bar dataKey="value" fill={T.gold} radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
