// src/AporteQuinzenal.jsx
// Tab: Contributions
// Item 25: monthly plan → split into two halves
// Item 26: track invested vs planned per half (this month)
// Item 27: full contribution history bar chart (buy transactions, excluding DELL vesting)

import { useEffect, useState, useMemo, useRef } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, Pencil, Check, X } from "lucide-react";
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
const LS_REALIZADO = "aporteRealizado"; // kept only to clean up on mount

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

// Sums DELL sell transactions for the given year+month.
// Returns total USD sold.
function computeDellSale(transactions, usdBrlRate, year, month) {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  let total = 0;
  for (const tx of transactions) {
    if (tx.side !== "sell") continue;
    if ((tx.ticker || "").toUpperCase() !== "DELL") continue;
    if (!tx.date || !tx.date.startsWith(prefix)) continue;
    total += txToUSD(tx, usdBrlRate);
  }
  return total;
}

// Sums buy transactions for the given year+month, split by first and second
// halves (days 1-15 vs 16-last). DELL vesting is excluded (same as chart).
// Bank Bonds: only net positive (buys − sells) counts per half — a rollover
// (redeem + recompra) does not inflate the contribution.
// Returns { half1: number, half2: number } in USD.
function computeHalfInvested(transactions, usdBrlRate, year, month) {
  const yStr = String(year);
  const mStr = String(month).padStart(2, "0");
  const prefix = `${yStr}-${mStr}-`;
  const lastDay = new Date(year, month, 0).getDate();

  let half1 = 0, half2 = 0;
  let bbBuy1 = 0, bbSell1 = 0, bbBuy2 = 0, bbSell2 = 0;

  for (const tx of transactions) {
    if (!tx.date || !tx.date.startsWith(prefix)) continue;
    const day = parseInt(tx.date.slice(8, 10), 10);
    if (day < 1 || day > lastDay) continue;
    if ((tx.ticker || "").toUpperCase() === "DELL") continue;

    const isFirst = day <= 15;
    const amount = txToUSD(tx, usdBrlRate);

    if (tx.assetClass === "Bank Bonds") {
      if (tx.side === "buy") {
        if (isFirst) bbBuy1 += amount; else bbBuy2 += amount;
      } else if (tx.side === "sell") {
        if (isFirst) bbSell1 += amount; else bbSell2 += amount;
      }
    } else if (tx.side === "buy") {
      if (isFirst) half1 += amount; else half2 += amount;
    }
  }

  half1 += Math.max(0, bbBuy1 - bbSell1);
  half2 += Math.max(0, bbBuy2 - bbSell2);

  return { half1, half2 };
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
  return {
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
    bondIncome: Array.isArray(data.bondIncome) ? data.bondIncome : [],
  };
}

async function fetchContributionsHistory(auth) {
  const res = await fetch("/api/contributions-history", { headers: authHeaders(auth) });
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
  return data.history && typeof data.history === "object" ? data.history : {};
}

async function putContributionsSnapshot(auth, month, snapshot) {
  const res = await fetch("/api/contributions-history", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ month, snapshot }),
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return res.json();
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// "2026-06" -> "Jun 2026"
function monthKeyLabel(key) {
  const [y, m] = key.split("-");
  const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
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
// Bank Bonds: only net positive (buys − sells) per bucket counts — rollovers
// (redeem + recompra) do not inflate the contribution history.
// Optional fromDate/toDate ("YYYY-MM-DD") filter the date range shown.
// groupBy: "Month" | "Quarter" | "Half" | "Year"
function buildChartData(transactions, usdBrlRate, groupBy, fromDate, toDate) {
  const relevant = transactions.filter((tx) => {
    if (tx.side !== "buy" && !(tx.assetClass === "Bank Bonds" && tx.side === "sell")) return false;
    if ((tx.ticker || "").toUpperCase() === "DELL") return false;
    if (!tx.date) return false;
    if (fromDate && tx.date < fromDate) return false;
    if (toDate && tx.date > toDate) return false;
    return true;
  });
  if (!relevant.length) return [];

  const byKey = {};
  const bbBuy = {}, bbSell = {};

  for (const tx of relevant) {
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

    const amount = txToUSD(tx, usdBrlRate);
    if (tx.assetClass === "Bank Bonds") {
      if (tx.side === "buy") bbBuy[key] = (bbBuy[key] || 0) + amount;
      else bbSell[key] = (bbSell[key] || 0) + amount;
    } else if (tx.side === "buy") {
      byKey[key] = (byKey[key] || 0) + amount;
    }
  }

  // Merge net Bank Bond contributions per bucket
  const allKeys = new Set([...Object.keys(byKey), ...Object.keys(bbBuy)]);
  for (const key of allKeys) {
    const net = Math.max(0, (bbBuy[key] || 0) - (bbSell[key] || 0));
    if (net > 0) byKey[key] = (byKey[key] || 0) + net;
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

// Wraps a horizontally-scrollable table with edge fades (always shown while
// the content overflows) and a one-shot animated "Swipe" hint pill that
// teaches the horizontal-scroll gesture. Fades are persistent; the pill
// keeps bouncing to draw attention until the user actually scrolls
// horizontally, then it's dismissed globally (localStorage flag, no
// per-user scoping - low-risk UI preference).
const SCROLL_HINT_SEEN_KEY = "scrollHintSeen";

function ScrollHintTable({ children, style, leftFadeOffset = 0, fadeBg = T.card }) {
  const scrollRef = useRef(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);
  const [pillPhase, setPillPhase] = useState("hidden"); // "hidden" | "visible" | "fading"
  const [bounce, setBounce] = useState(false);

  function hasSeenHint() {
    try {
      return localStorage.getItem(SCROLL_HINT_SEEN_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function dismissPill() {
    try {
      localStorage.setItem(SCROLL_HINT_SEEN_KEY, "1");
    } catch (e) {}
    setPillPhase((p) => (p === "hidden" ? p : "fading"));
    setTimeout(() => setPillPhase((p) => (p === "fading" ? "hidden" : p)), 320);
  }

  function measure() {
    const el = scrollRef.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 1;
    setShowRightFade(overflow && el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
    setShowLeftFade(el.scrollLeft > 4);
    if (overflow && !hasSeenHint()) {
      setPillPhase((p) => (p === "hidden" ? "visible" : p));
    }
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    } else {
      window.addEventListener("resize", measure);
    }
    return () => {
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pillPhase !== "visible") return;
    let reduceMotion = false;
    try {
      reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {}
    if (reduceMotion) return;
    const id = setInterval(() => {
      setBounce((b) => !b);
    }, 700);
    return () => clearInterval(id);
  }, [pillPhase]);

  function handleScroll() {
    measure();
    const el = scrollRef.current;
    if (el && el.scrollLeft > 4) dismissPill();
  }

  return (
    <div style={{ position: "relative" }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", ...style }}
      >
        {children}
      </div>
      {showRightFade && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: 28,
            pointerEvents: "none",
            background: `linear-gradient(to right, transparent, ${fadeBg} 75%)`,
          }}
        />
      )}
      {showLeftFade && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: leftFadeOffset,
            width: 28,
            pointerEvents: "none",
            background: `linear-gradient(to left, transparent, ${fadeBg} 75%)`,
          }}
        />
      )}
      {pillPhase !== "hidden" && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            right: 10,
            background: "rgba(19,22,27,0.9)",
            border: `1px solid ${T.borderSoft}`,
            borderRadius: 12,
            padding: "4px 10px",
            display: "flex",
            alignItems: "center",
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: T.textDim,
            opacity: pillPhase === "visible" ? 1 : 0,
            transition: "opacity 0.3s ease",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          <span>Swipe</span>
          <ChevronRight
            size={12}
            color={T.gold}
            style={{ marginLeft: 3, transform: bounce ? "translateX(6px)" : "translateX(0)", transition: "transform 0.7s ease-in-out" }}
          />
          <ChevronRight
            size={12}
            color={T.gold}
            style={{ marginLeft: -8, transform: bounce ? "translateX(6px)" : "translateX(0)", transition: "transform 0.7s ease-in-out" }}
          />
        </div>
      )}
    </div>
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

// Monthly fixed amount: presets to the previous month's saved value, but is
// gated behind an Edit → Save flow so a stored value is only changed when the
// user explicitly confirms. Blank (placeholder) when there's no prior month.
function MonthlyFixedRow({ value, prevMonthValue, valuesHidden, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  // Keep the draft in sync with the stored value while not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  const hasValue = value !== "" && value != null;
  const iconBtn = {
    background: "transparent",
    border: `1px solid ${T.border}`,
    borderRadius: 4,
    color: T.textDim,
    padding: "4px 6px",
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
  };

  return (
    <div style={{ padding: "9px 0", borderBottom: `1px solid ${T.borderSoft}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontFamily: FONT_BODY, fontSize: 13, color: T.textDim, flex: 1 }}>
          Monthly fixed amount
        </span>
        {!editing ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: hasValue ? T.text : T.textFaint }}>
              {hasValue ? fmtUSD(parseFloat(value) || 0, valuesHidden) : "Not set"}
            </span>
            <button
              type="button"
              onClick={() => { setDraft(value ?? ""); setEditing(true); }}
              title="Edit monthly fixed amount"
              style={iconBtn}
            >
              <Pencil size={12} />
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.textFaint }}>$</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="0"
              autoFocus
              style={{ ...INPUT_STYLE, width: 90 }}
            />
            <button
              type="button"
              onClick={() => { onSave(draft); setEditing(false); }}
              title="Save"
              style={{ ...iconBtn, border: `1px solid ${T.gold}`, color: T.gold }}
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              onClick={() => { setDraft(value ?? ""); setEditing(false); }}
              title="Cancel"
              style={iconBtn}
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>
      {editing && prevMonthValue != null && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 10, color: T.textFaint, textAlign: "right", marginTop: 4 }}>
          Last month: {fmtUSD(prevMonthValue, valuesHidden)}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AporteQuinzenal({ auth, onAuthFail, valuesHidden }) {
  const [config, setConfig] = useState(loadConfig);

  const [windowWidth, setWindowWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 375));
  useEffect(() => {
    function handleResize() { setWindowWidth(window.innerWidth); }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const [transactions, setTransactions] = useState([]);
  const [bondIncome, setBondIncome] = useState([]);
  const [txLoading, setTxLoading] = useState(true);
  const [txError, setTxError] = useState(null);
  const [divLastMonth, setDivLastMonth] = useState(null); // null = loading

  const [groupBy, setGroupBy] = useState("Month");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [planOpen, setPlanOpen] = useState(true);
  const [realizadoOpen, setRealizadoOpen] = useState(true);
  const [histOpen, setHistOpen] = useState(true);
  const [capacityOpen, setCapacityOpen] = useState(true);

  const [capacityHistory, setCapacityHistory] = useState({}); // { "YYYY-MM": snapshot }
  const [capacityLoaded, setCapacityLoaded] = useState(false);

  const [newExtraLabel, setNewExtraLabel] = useState("");
  const [newExtraValue, setNewExtraValue] = useState("");

  const usdBrlRate = useMemo(() => {
    const v = parseFloat(localStorage.getItem("usdBrlRate"));
    return isFinite(v) && v > 0 ? v : 5.7;
  }, []);

  useEffect(() => {
    localStorage.removeItem(LS_REALIZADO);
    // Load contribution-capacity history (silent failure — table just stays empty).
    fetchContributionsHistory(auth)
      .then((hist) => {
        setCapacityHistory(hist);
        setCapacityLoaded(true);
      })
      .catch((e) => {
        if (e.code === 401) { onAuthFail(); return; }
        setCapacityLoaded(true);
      });
    fetchTransactions(auth)
      .then(({ transactions: txs, bondIncome: bi }) => {
        setTransactions(txs);
        setBondIncome(bi);
        setTxLoading(false);
        // Fetch dividends last month - silent failure
        fetch("/api/dividends", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders(auth) },
          body: JSON.stringify({ transactions: txs, bondIncome: bi }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!data) return;
            const now = new Date();
            const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const prefix = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, "0")}-`;
            // Bucket by e.date (= payDate when known, else ex-date) — the same basis
            // the Dividends tab uses, so the two screens stay in lockstep.
            const apiTotal = (data.events || [])
              .filter((e) => e.date && e.date.startsWith(prefix))
              .reduce((sum, e) => sum + (parseFloat(e.totalReceived) || 0), 0);
            // Add real bond interest payments not returned by /api/dividends.
            // This MUST mirror buildBondEvents() in Dividends.jsx (which treats
            // entries with kind="interest" OR no kind at all as real bond interest)
            // so this KPI stays in lockstep with the Dividends tab's "previous
            // month" total. Stock dividends (kind="dividend") are excluded here —
            // they already arrive via apiTotal from /api/dividends, so counting
            // them again would double-count.
            const bondTotal = (bi || [])
              .filter((e) => e && (e.kind === "interest" || !e.kind) && e.date && e.date.startsWith(prefix) && Number(e.amount) > 0)
              .reduce((sum, e) => sum + Number(e.amount), 0);
            setDivLastMonth(apiTotal + bondTotal);
          })
          .catch(() => { setDivLastMonth(0); });
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

  // Previous month's saved "monthly fixed amount" (from the capacity snapshots).
  // Used to preset the current month's value. null when there's no prior value.
  const prevMonthFixed = useMemo(() => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const v = Number(capacityHistory[key]?.monthlyFixed);
    return isFinite(v) && v > 0 ? v : null;
  }, [capacityHistory]);

  // One-time preset: when the current month has no fixed amount set yet, seed it
  // from the previous month's value. Leaves it blank if there's no prior value.
  const seededFixed = useRef(false);
  useEffect(() => {
    if (!capacityLoaded || seededFixed.current) return;
    seededFixed.current = true;
    if ((config.monthlyFixed === "" || config.monthlyFixed == null) && prevMonthFixed != null) {
      updateConfig({ monthlyFixed: String(prevMonthFixed) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capacityLoaded, prevMonthFixed]);

  // The current month's capacity snapshot as last written to Redis (write path
  // is the auto-snapshot effect below). Used only as a restore source when
  // localStorage's aporteConfig has been wiped (e.g. Safari clearing site
  // storage) — the extras a user adds are otherwise persisted exclusively in
  // localStorage, so losing it silently drops them from the UI even though
  // they still exist in the last saved Redis snapshot.
  const currentMonthSnapshot = useMemo(
    () => capacityHistory[currentMonthKey()],
    [capacityHistory]
  );

  // One-time restore: if localStorage has no extras for this session but the
  // last Redis snapshot for the current month does, repopulate config.extras
  // from it. Converts the Redis snapshot shape ({name, amount}) back to the
  // local state shape ({label, value}). Runs only once so it never clobbers
  // edits the user makes after the initial load.
  const seededExtras = useRef(false);
  useEffect(() => {
    if (!capacityLoaded || seededExtras.current) return;
    seededExtras.current = true;
    const snapshotExtras = currentMonthSnapshot?.extras;
    if ((config.extras || []).length === 0 && Array.isArray(snapshotExtras) && snapshotExtras.length > 0) {
      updateConfig({
        extras: snapshotExtras.map((e) => ({
          label: e.name ?? "",
          value: e.amount != null ? String(e.amount) : "",
        })),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capacityLoaded, currentMonthSnapshot]);

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

  const dellSaleAuto = useMemo(() => {
    if (!transactions.length) return 0;
    const now = new Date();
    return computeDellSale(transactions, usdBrlRate, now.getFullYear(), now.getMonth() + 1);
  }, [transactions, usdBrlRate]);

  const planTotal = useMemo(() => {
    const fixed = parseFloat(config.monthlyFixed) || 0;
    const extrasSum = (config.extras || []).reduce(
      (s, e) => s + (parseFloat(e.value) || 0),
      0
    );
    return fixed + (divLastMonth ?? 0) + dellSaleAuto + extrasSum;
  }, [config, divLastMonth, dellSaleAuto]);

  const halfPlanned = planTotal / 2;
  const days = daysInCurrentMonth();

  const { half1Auto, half2Auto } = useMemo(() => {
    if (!transactions || transactions.length === 0)
      return { half1Auto: 0, half2Auto: 0 };
    const now = new Date();
    const { half1, half2 } = computeHalfInvested(transactions, usdBrlRate, now.getFullYear(), now.getMonth() + 1);
    return { half1Auto: half1, half2Auto: half2 };
  }, [transactions, usdBrlRate]);

  // ── Chunk A: rollover ──
  // Semantics: "deficit rolls into the 2nd half, monthly total stays fixed".
  // The month goal is planTotal and never changes. The 1st-half goal is
  // halfPlanned (= planTotal/2). Whatever was NOT invested in the 1st half
  // (deficit) is added to the 2nd-half goal. A 1st-half surplus makes the 2nd
  // cheaper. All derived from half1Auto / half2Auto / halfPlanned — no fetch.
  const rollover = useMemo(() => {
    const half1Target = halfPlanned;
    const half1Deficit = Math.max(0, half1Target - half1Auto);
    // Only roll deficit into the 2nd half once the 1st half has closed (day > 15).
    const past15 = new Date().getDate() > 15;
    const half2Target = halfPlanned + (past15 ? half1Deficit : 0);
    const half1Remaining = Math.max(0, half1Target - half1Auto);
    const half2Remaining = Math.max(0, half2Target - half2Auto);
    const totalInvested = half1Auto + half2Auto;
    const monthRemaining = Math.max(0, planTotal - totalInvested);
    return {
      half1Target,
      half2Target,
      half1Deficit,
      half1Remaining,
      half2Remaining,
      totalInvested,
      monthRemaining,
    };
  }, [halfPlanned, half1Auto, half2Auto, planTotal]);

  // ── Chunk B: auto-snapshot the CURRENT month (idempotent overwrite) ──
  // Runs once history + dividends + transactions are loaded. Always overwrites
  // the current month with the freshest plan values; never touches past months
  // (the endpoint does a read-modify-write of the map). Also keeps the in-memory
  // capacityHistory in sync so the table reflects the latest plan immediately.
  useEffect(() => {
    if (!capacityLoaded || txLoading || divLastMonth === null) return;
    const month = currentMonthKey();
    const snapshot = {
      monthlyFixed: parseFloat(config.monthlyFixed) || 0,
      dividends: divLastMonth ?? 0,
      dellSale: dellSaleAuto,
      extras: (config.extras || []).map((e) => ({
        name: e.label,
        amount: parseFloat(e.value) || 0,
      })),
      planTotal,
      invested: half1Auto + half2Auto,
    };
    setCapacityHistory((prev) => ({
      ...prev,
      [month]: { ...snapshot, savedAt: new Date().toISOString() },
    }));
    putContributionsSnapshot(auth, month, snapshot).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    capacityLoaded,
    txLoading,
    divLastMonth,
    config.monthlyFixed,
    config.extras,
    dellSaleAuto,
    planTotal,
    half1Auto,
    half2Auto,
  ]);

  // Months sorted most-recent first for the capacity table.
  const capacityRows = useMemo(() => {
    return Object.keys(capacityHistory)
      .filter((k) => /^\d{4}-\d{2}$/.test(k))
      .sort()
      .reverse()
      .map((k) => ({ month: k, ...capacityHistory[k] }));
  }, [capacityHistory]);

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
      <div style={{ display: windowWidth >= 768 ? "flex" : "block", gap: 16, alignItems: "flex-start" }}>
      {/* ── Monthly Plan ── */}
      <section style={{ ...cardStyle, flex: windowWidth >= 768 ? "3 1 0" : undefined }}>
        <div style={goldAccent} />
        <CardToggle
          label="Monthly Plan"
          sub={currentMonthLabel()}
          open={planOpen}
          onToggle={() => setPlanOpen((v) => !v)}
        />
        {planOpen && (
          <div style={{ padding: "0 20px 20px" }}>
            <MonthlyFixedRow
              value={config.monthlyFixed}
              prevMonthValue={prevMonthFixed}
              valuesHidden={valuesHidden}
              onSave={(v) => updateConfig({ monthlyFixed: v })}
            />
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"9px 0", borderBottom:`1px solid ${T.borderSoft}` }}>
              <span style={{ fontFamily:FONT_BODY, fontSize:13, color:T.textDim, flex:1 }}>Dividends (last month)</span>
              {divLastMonth === null ? (
                <span style={{ fontFamily:FONT_MONO, fontSize:13, color:T.textDim }}>Loading…</span>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end" }}>
                  <span style={{ fontFamily:FONT_MONO, fontSize:13, color: divLastMonth > 0 ? T.text : T.textFaint }}>
                    {fmtUSD(divLastMonth, valuesHidden)}
                  </span>
                  <span style={{ fontFamily:FONT_BODY, fontSize:10, color:T.textFaint }}>from Dividends</span>
                </div>
              )}
            </div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"9px 0", borderBottom:`1px solid ${T.borderSoft}` }}>
              <span style={{ fontFamily:FONT_BODY, fontSize:13, color:T.textDim, flex:1 }}>DELL sale (this month)</span>
              {txLoading ? (
                <span style={{ fontFamily:FONT_MONO, fontSize:13, color:T.textDim }}>Loading…</span>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end" }}>
                  <span style={{ fontFamily:FONT_MONO, fontSize:13, color: dellSaleAuto > 0 ? T.text : T.textFaint }}>
                    {fmtUSD(dellSaleAuto, valuesHidden)}
                  </span>
                  <span style={{ fontFamily:FONT_BODY, fontSize:10, color:T.textFaint }}>from Transactions</span>
                </div>
              )}
            </div>

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
                  <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.text }}>
                    {fmtUSD(Number(extra.value) || 0, valuesHidden)}
                  </span>
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
      <section style={{ ...cardStyle, flex: windowWidth >= 768 ? "2 1 0" : undefined, marginTop: windowWidth >= 768 ? 0 : 16 }}>
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
              const invested = half === 1 ? half1Auto : half2Auto;
              const planned = half === 1 ? rollover.half1Target : rollover.half2Target;
              const remaining = half === 1 ? rollover.half1Remaining : rollover.half2Remaining;
              const done = invested >= planned && planned > 0;
              const dateRange = half === 1 ? "1-15" : `16-${days}`;
              const rolledUp = half === 2 && rollover.half1Deficit > 0;

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
                    {half === 1 ? "1st" : "2nd"} Half - {dateRange}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginBottom: 5 }}>
                        Planned
                      </div>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: rolledUp ? T.gold : T.textDim }}>
                        {fmtUSD(planned, valuesHidden)}
                      </div>
                      {rolledUp && (
                        <div
                          title="Rolled over from the 1st-half deficit"
                          style={{ fontFamily: FONT_BODY, fontSize: 10, color: T.gold, marginTop: 3 }}
                        >
                          +{fmtUSD(rollover.half1Deficit, valuesHidden)} rollover
                        </div>
                      )}
                    </div>

                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginBottom: 5 }}>
                        Invested
                      </div>
                      {txLoading ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                          Loading...
                        </div>
                      ) : txError ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textFaint }}>
                          --
                        </div>
                      ) : (
                        <div>
                          <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.text }}>
                            {fmtUSD(invested, valuesHidden)}
                          </div>
                          <div style={{ fontFamily: FONT_BODY, fontSize: 10, color: T.textFaint, marginTop: 3 }}>
                            from Transactions
                          </div>
                        </div>
                      )}
                    </div>

                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginBottom: 5 }}>
                        Remaining
                      </div>
                      {txLoading ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                          Loading...
                        </div>
                      ) : txError ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textFaint }}>
                          --
                        </div>
                      ) : done ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.green }}>
                          Done
                        </div>
                      ) : (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: planned > 0 ? T.text : T.textFaint }}>
                          {fmtUSD(remaining, valuesHidden)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Month totalizer */}
            <div style={{ marginTop: 4, borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
              {(() => {
                const monthDone = rollover.totalInvested >= planTotal && planTotal > 0;
                return (
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginBottom: 5 }}>
                        Month total
                      </div>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                        {fmtUSD(planTotal, valuesHidden)}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginBottom: 5 }}>
                        Invested
                      </div>
                      {txLoading ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>Loading...</div>
                      ) : txError ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textFaint }}>--</div>
                      ) : (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.text, fontWeight: 600 }}>
                          {fmtUSD(rollover.totalInvested, valuesHidden)}
                        </div>
                      )}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: T.textFaint, marginBottom: 5 }}>
                        Remaining for month
                      </div>
                      {txLoading ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>Loading...</div>
                      ) : txError ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textFaint }}>--</div>
                      ) : monthDone ? (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.green, fontWeight: 600 }}>
                          Month Done
                        </div>
                      ) : (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: planTotal > 0 ? T.text : T.textFaint, fontWeight: 600 }}>
                          {fmtUSD(rollover.monthRemaining, valuesHidden)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </section>
      </div>

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

      {/* ── Contribution Capacity History (Chunk B) ── */}
      {/* Monthly snapshots of planned capacity vs realized, persisted in Redis.
          Limitation: months PRIOR to the first use of this feature have no
          monthlyFixed/extras stored — those cells render as "—" (no invented
          data). The current month is re-snapshotted (idempotent) on every load. */}
      <section style={{ ...cardStyle, marginTop: 16, marginBottom: 0 }}>
        <div style={goldAccent} />
        <CardToggle
          label="Contribution Capacity History"
          sub="Planned capacity vs invested · per month · stored in Redis"
          open={capacityOpen}
          onToggle={() => setCapacityOpen((v) => !v)}
        />
        {capacityOpen && (
          <div style={{ padding: "0 20px 24px" }}>
            {!capacityLoaded ? (
              <div style={{ textAlign: "center", padding: "40px 0", fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                Loading…
              </div>
            ) : capacityRows.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 0", fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                No capacity history yet
              </div>
            ) : (
              <ScrollHintTable>
                <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse" }}>
                  <colgroup>
                    <col style={{ width: 84 }} />
                    <col /><col /><col /><col /><col /><col /><col />
                  </colgroup>
                  <thead>
                    <tr>
                      {[
                        { label: "Month", align: "left" },
                        { label: "Fixed", align: "right" },
                        { label: "Dividends", align: "right" },
                        { label: "DELL", align: "right" },
                        { label: "Extras", align: "right" },
                        { label: "Planned", align: "right" },
                        { label: "Invested", align: "right" },
                        { label: "Balance", align: "right" },
                      ].map((c) => (
                        <th
                          key={c.label}
                          style={{
                            textAlign: c.align,
                            fontFamily: FONT_MONO,
                            fontSize: 10,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            color: T.textFaint,
                            fontWeight: 600,
                            padding: "8px 10px",
                            borderBottom: `1px solid ${T.border}`,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {capacityRows.map((row) => {
                      const extrasSum = (row.extras || []).reduce(
                        (s, e) => s + (parseFloat(e.amount) || 0),
                        0
                      );
                      const planned = row.planTotal != null ? row.planTotal : null;
                      const invested = row.invested != null ? row.invested : null;
                      const balance =
                        planned != null && invested != null ? planned - invested : null;
                      const tdBase = {
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                        textAlign: "right",
                        padding: "9px 10px",
                        borderBottom: `1px solid ${T.borderSoft}`,
                        whiteSpace: "nowrap",
                        color: T.text,
                      };
                      const dash = (v) => (v == null ? "—" : fmtUSD(v, valuesHidden));
                      return (
                        <tr key={row.month}>
                          <td
                            style={{
                              ...tdBase,
                              textAlign: "left",
                              color: T.gold,
                              fontWeight: 600,
                              letterSpacing: "0.04em",
                            }}
                          >
                            {monthKeyLabel(row.month)}
                          </td>
                          <td style={{ ...tdBase, color: T.textDim }}>
                            {dash(row.monthlyFixed)}
                          </td>
                          <td style={{ ...tdBase, color: T.textDim }}>
                            {dash(row.dividends)}
                          </td>
                          <td style={{ ...tdBase, color: T.textDim }}>
                            {dash(row.dellSale)}
                          </td>
                          <td style={{ ...tdBase, color: T.textDim }}>
                            {row.extras == null ? "—" : fmtUSD(extrasSum, valuesHidden)}
                          </td>
                          <td style={{ ...tdBase, fontWeight: 600 }}>
                            {dash(planned)}
                          </td>
                          <td style={{ ...tdBase, color: T.text, fontWeight: 600 }}>
                            {dash(invested)}
                          </td>
                          <td
                            style={{
                              ...tdBase,
                              fontWeight: 600,
                              color:
                                balance == null
                                  ? T.textFaint
                                  : balance > 0.005
                                  ? T.red
                                  : T.green,
                            }}
                          >
                            {dash(balance)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollHintTable>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
