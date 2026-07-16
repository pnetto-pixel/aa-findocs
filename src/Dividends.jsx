// src/Dividends.jsx
// Tab: Dividends / Income — US assets only (Yahoo Finance, keyless).
// Item 17: Income History — collapsible card with KPIs inside, bar chart
//          with Month | Quarter | Half | Year views + date range filter.
// Item 18: (kept in monthly grouping of the chart)
// Position Dividends: per-ticker total, YTD, Y/Y YTD growth, yield on cost.
// Dividend History: full audit table of every payment.

import { useState, useEffect, useMemo, useRef, Fragment } from "react";
import { ChevronDown, ChevronRight, TrendingUp, BarChart2, Receipt, Filter } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import DateMonthPicker from "./DateMonthPicker.jsx";

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

// In-session cache for the POST /api/dividends response — tab switches
// unmount this view and every revisit re-showed "Fetching dividends" while
// re-posting identical payloads. Keyed by a hash of transactions+bondIncome
// (+local day), so any data change misses the cache. Module scope: survives
// remounts, dies with a page reload.
const divSessionCache = new Map();
function divSessionKey(payload) {
  const s = JSON.stringify(payload);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
}

// Local (not UTC) "today" as YYYY-MM-DD — UTC rolls over hours before local
// midnight for negative-offset timezones (US Central, Brazil, etc), which was
// causing dividends to show as already-received a day early. Same helper/fix
// already applied in App.jsx (Alerts) and Events.jsx (chronological grouping).
function localTodayISO(d = new Date()) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
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

// ── Bank Bonds interest (item 36) ─────────────────────────────────────────────
// CDs / US bank bonds pay periodic coupons but there is no free per-CUSIP
// payment history API. Income comes from two sources, merged in buildBondEvents:
// real payments imported from the Fidelity Account History (bondIncome store)
// and an estimated accrual (principal x coupon x days/365, ACT/365) filling
// only the gap after the last real payment, replayed per CUSIP with partial
// sells reducing the running principal up to min(today, maturity).
//
// Extracts coupon% + maturity for one transaction. Prefers dedicated fields
// added by the Fidelity parser (couponRate, maturityDate); falls back to the
// legacy notes string "5.45% | 03/15/2027". Returns null when absent (the
// transaction is then skipped silently in the accrual).
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

// Map a median spacing (in days) between real coupon payments to a frequency.
function freqFromDays(d) {
  if (!isFinite(d) || d <= 0) return null;
  if (d <= 45) return "monthly";
  if (d <= 135) return "quarterly";
  if (d <= 270) return "semi-annual";
  return "annual";
}

// Frequency label -> coupon interval in days. Shared by buildBondEvents (accrual
// block sizing) and buildBondProjections (future payment spacing).
const FREQ_DAYS = {
  "monthly": 30,
  "quarterly": 91,
  "semi-annual": 182,
  "annual": 365,
};

function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Bank Bonds interest events ────────────────────────────────────────────────
// Builds an event array (same shape as dividend events from /api/dividends)
// merging real coupon payments (from bondIncome) with estimated accrual for
// the gap not yet covered by a real payment. The unified array feeds every
// card in DividendsView — bar chart, Position Dividends, Dividend History,
// Y/Y table — so bond interest appears everywhere alongside stock dividends.
//
// Real events: source "fidelity", exact date and amount.
// Estimated events: source "estimated", dated at the end of each fully-elapsed
//   coupon period (sized per the bond's real cadence — freqByCusip/couponFreq,
//   falling back to "monthly" only when no data at all is available), same
//   pattern as buildBondProjections. Only complete periods are emitted — the
//   still-running current period is never turned into a "paid" event.
//   incomeType "interest". amountPerShare/qtyHeld are null (shown as "—" in table).
// Coupon frequency is calibrated from real payment cadence (>= 2 payments).
function buildBondEvents(transactions, bondIncome, todayISO) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const events = [];

  // ── 1) Real payments ──────────────────────────────────────────────────────
  const realByCusip = {};
  for (const ev of bondIncome || []) {
    if (!ev || (ev.kind && ev.kind !== "interest")) continue;
    const t = (ev.ticker || "").toUpperCase();
    const amt = Number(ev.amount);
    if (!t || !ev.date || !isFinite(amt) || amt <= 0) continue;
    events.push({
      id: ev.id || `bond-real-${t}-${ev.date}`,
      date: ev.date,
      ticker: t,
      assetClass: "Bank Bonds",
      incomeType: "interest",
      totalReceived: amt,
      currency: "USD",
      source: "fidelity",
      amountPerShare: null,
      qtyHeld: null,
    });
    if (!realByCusip[t]) realByCusip[t] = [];
    realByCusip[t].push({ date: ev.date, amount: amt });
  }

  // ── 2) Calibrate coupon frequency per CUSIP from real payment cadence ─────
  const freqByCusip = {};
  for (const [t, real] of Object.entries(realByCusip)) {
    if (real.length < 2) continue;
    const diffs = [];
    const sorted = real.slice().sort(byDate);
    for (let i = 1; i < sorted.length; i++) diffs.push(daysBetweenISO(sorted[i - 1].date, sorted[i].date));
    diffs.sort((a, b) => a - b);
    freqByCusip[t] = freqFromDays(diffs[Math.floor(diffs.length / 2)]);
  }

  // ── 3) Estimated accrual for the gap (per CUSIP, sized per coupon freq) ───
  const byCusip = {};
  for (const tx of transactions || []) {
    if (!tx || (tx.assetClass || "") !== "Bank Bonds") continue;
    const meta = parseBondNotes(tx);
    if (!meta) continue;
    const t = (tx.ticker || "").toUpperCase();
    const qty = Number(tx.qty);
    const price = Number(tx.price);
    if (!t || !isFinite(qty) || !isFinite(price)) continue;
    if (!byCusip[t]) byCusip[t] = { txns: [], coupon: meta.couponPct, maturityISO: meta.maturityISO, couponFreq: null };
    byCusip[t].coupon = meta.couponPct;
    byCusip[t].maturityISO = meta.maturityISO;
    if (!byCusip[t].couponFreq && tx.couponFreq) byCusip[t].couponFreq = tx.couponFreq;
    byCusip[t].txns.push({ date: tx.date, delta: (tx.side === "sell" ? -1 : 1) * qty * price });
  }

  for (const [t, { txns, coupon, maturityISO, couponFreq }] of Object.entries(byCusip)) {
    txns.sort(byDate);
    const endISO = minISO(maturityISO, today);
    const rate = coupon / 100;
    const realDates = (realByCusip[t] || []).slice().sort(byDate);
    const lastRealDate = realDates.length ? realDates[realDates.length - 1].date : null;

    // Accrual starts strictly the day after the last known real payment (never
    // on the same day — otherwise a residual stub overlaps the real payment's
    // period), or from the first transaction date if there has never been a
    // real payment for this CUSIP.
    const accrueFrom = lastRealDate ? addDaysISO(lastRealDate, 1) : (txns.length ? txns[0].date : null);
    if (!accrueFrom || accrueFrom >= endISO || !txns.length) continue;

    // Constant-principal segments across the full txn history, clamped to endISO.
    const segments = [];
    let principal = 0;
    for (let i = 0; i < txns.length; i++) {
      principal += txns[i].delta;
      if (principal < 0) principal = 0;
      const segStart = txns[i].date;
      const segEnd = i + 1 < txns.length ? txns[i + 1].date : endISO;
      if (segEnd > segStart) segments.push({ start: segStart, end: segEnd, principal });
    }

    // Prefer calibrated real-payment cadence, then the Fidelity-reported
    // couponFreq, then "monthly" only when there is no data at all.
    const freqLabel = freqByCusip[t] || couponFreq || "monthly";
    const intervalDays = FREQ_DAYS[freqLabel] || 30;

    accrueByFreqAsEvents(events, t, accrueFrom, endISO, segments, rate, intervalDays);
  }

  return { events, freqByCusip };
}

// Generates one estimated-interest event per fully-elapsed coupon period of
// length intervalDays within [startISO, endISO). A period is only emitted when
// it is entirely within the window (periodEnd <= endISO) — the still-running
// partial period at the tail is dropped, since no money has actually been paid
// for it yet. Principal can change mid-period (buy/sell); the accrual for each
// period sums principal x days across the overlapping constant-principal
// segments, same ACT/365 convention as before.
function accrueByFreqAsEvents(events, ticker, startISO, endISO, segments, rate, intervalDays) {
  let periodStart = startISO;
  while (true) {
    const periodEnd = addDaysISO(periodStart, intervalDays);
    if (periodEnd > endISO) break; // incomplete trailing period — not "paid" yet
    let amt = 0;
    for (const seg of segments) {
      if (seg.principal <= 0) continue;
      const overlapStart = seg.start > periodStart ? seg.start : periodStart;
      const overlapEnd = seg.end < periodEnd ? seg.end : periodEnd;
      if (overlapEnd <= overlapStart) continue;
      const days = daysBetweenISO(overlapStart, overlapEnd);
      amt += seg.principal * rate * (days / 365);
    }
    if (amt > 0) {
      const eventDate = addDaysISO(periodEnd, -1); // last day of the elapsed period
      events.push({
        id: `bond-est-${ticker}-${periodStart}`,
        date: eventDate,
        ticker,
        assetClass: "Bank Bonds",
        incomeType: "interest",
        totalReceived: amt,
        currency: "USD",
        source: "estimated",
        amountPerShare: null,
        qtyHeld: null,
      });
    }
    periodStart = periodEnd;
  }
}

// Full history grouped by the chosen granularity, optional date/ticker/assetClass filter.
function buildChartData(events, groupBy, selectedYears, selectedTickers, selectedAssetClasses) {
  const filtered = events.filter((e) => {
    if (!e.date) return false;
    if (selectedYears.size > 0 && !selectedYears.has(e.date.slice(0, 4))) return false;
    if (selectedTickers.size > 0 && !selectedTickers.has(e.ticker)) return false;
    if (selectedAssetClasses.size > 0 && !selectedAssetClasses.has(e.assetClass)) return false;
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

// Multi-select filter chip: trigger button + own popover (checkboxes, Clear + × header).
// Avoids native <select multiple>, whose iOS picker sheet can't be customized.
function FilterMultiSelect({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    document.addEventListener("touchstart", handle);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("touchstart", handle);
    };
  }, [open]);

  const active = selected.size > 0;
  const triggerText = active ? [...selected].sort().join(", ") : label;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: T.cardElev,
          border: `1px solid ${active ? T.gold : T.border}`,
          borderRadius: 4,
          color: T.text,
          fontFamily: FONT_MONO,
          fontSize: 12,
          padding: "5px 10px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          maxWidth: 160,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{triggerText}</span>
        <span style={{ color: T.textDim, fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            width: 200,
            maxHeight: 280,
            overflowY: "auto",
            background: T.cardElev,
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 10px",
              borderBottom: `1px solid ${T.border}`,
              position: "sticky",
              top: 0,
              background: T.cardElev,
            }}
          >
            <button
              onClick={() => onChange(new Set())}
              style={{
                background: "transparent",
                border: "none",
                color: T.gold,
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Clear
            </button>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: "transparent",
                border: "none",
                color: T.textDim,
                fontSize: 16,
                lineHeight: 1,
                cursor: "pointer",
                padding: 0,
              }}
            >
              ×
            </button>
          </div>
          {options.map((opt) => (
            <label
              key={opt}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: "pointer", borderBottom: `1px solid ${T.border}` }}
            >
              <input
                type="checkbox"
                checked={selected.has(opt)}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(opt)) next.delete(opt);
                  else next.add(opt);
                  onChange(next);
                }}
                style={{ accentColor: T.gold }}
              />
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text }}>{opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Asset class grouping helper ───────────────────────────────────────────────

// Returns an array of group objects for collapsible class-mode rendering.
// Each group: { label, ticker (= label, for sort compat), total, ytd, priorYtd, ttm, cost, yoyPct, yoc, recovered, tickers }
function buildClassGroups(rows, transactions) {
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
    if (!byClass[cls]) byClass[cls] = { label: cls, ticker: cls, total: 0, ytd: 0, priorYtd: 0, ttm: 0, cost: 0, tickers: [] };
    const g = byClass[cls];
    g.total += row.total;
    g.ytd += row.ytd;
    g.priorYtd += row.priorYtd;
    g.ttm += row.ttm;
    g.cost += row.cost || 0;
    g.tickers.push(row);
  }

  return Object.values(byClass).map((g) => ({
    ...g,
    yoyPct: g.priorYtd > 0 ? (g.ytd / g.priorYtd - 1) * 100 : null,
    yoc: g.cost > 0 ? (g.ttm / g.cost) * 100 : null,
    recovered: g.cost > 0 ? (g.total / g.cost) * 100 : null,
  }));
}

// Filter-only popover for the Ticker column header. Anchored to the clicked
// filter icon (position: fixed, clamped to viewport). Independent of sort,
// which stays on the header text click (handleSort).
function TickerFilterPopover({ anchor, onClose, options, selected, onChange }) {
  const ref = useRef(null);

  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target) && !(anchor && anchor.contains(e.target))) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handle);
    document.addEventListener("touchstart", handle);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("touchstart", handle);
    };
  }, [onClose, anchor]);

  const rect = anchor?.getBoundingClientRect();
  const POPOVER_W = 180;
  const posStyle = rect
    ? {
        position: "fixed",
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_W - 8)),
        zIndex: 50,
        width: POPOVER_W,
      }
    : { display: "none" };

  return (
    <div
      ref={ref}
      style={{
        ...posStyle,
        background: T.cardElev,
        border: `1px solid ${T.border}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        padding: 10,
        maxHeight: 280,
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <button
          onClick={() => onChange(new Set(options))}
          style={{ background: "transparent", border: "none", color: T.gold, fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", cursor: "pointer", padding: 0 }}
        >
          All
        </button>
        <button
          onClick={() => onChange(new Set())}
          style={{ background: "transparent", border: "none", color: T.textDim, fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", cursor: "pointer", padding: 0 }}
        >
          Clear
        </button>
      </div>
      {options.map((opt) => (
        <label key={opt} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={selected.has(opt)}
            onChange={() => {
              const next = new Set(selected);
              next.has(opt) ? next.delete(opt) : next.add(opt);
              onChange(next);
            }}
            style={{ accentColor: T.gold }}
          />
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text }}>{opt}</span>
        </label>
      ))}
    </div>
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

// ── Position Dividends table ──────────────────────────────────────────────────

function PositionDividendsTable({ rows, transactions, valuesHidden, open, onToggle }) {
  const [sortCol, setSortCol] = useState("total");
  const [sortDir, setSortDir] = useState("desc");
  const [groupMode, setGroupMode] = useState("class");
  const [collapsedClasses, setCollapsedClasses] = useState(() => new Set());
  const [tickerFilter, setTickerFilter] = useState(() => new Set());
  const [tickerFilterOpen, setTickerFilterOpen] = useState(false);
  const tickerFilterIconRef = useRef(null);

  // Ticker universe for the filter popover - always derived from the
  // unfiltered rows so the popover lists every ticker, not just visible ones.
  const allTickers = useMemo(() => [...new Set(rows.map((r) => r.ticker))].sort(), [rows]);

  const filteredRows = useMemo(
    () => (tickerFilter.size === 0 ? rows : rows.filter((r) => tickerFilter.has(r.ticker))),
    [rows, tickerFilter]
  );

  // On initial mount in class mode, collapse all groups by default.
  useEffect(() => {
    if (groupMode === "class" && filteredRows.length > 0 && transactions.length > 0) {
      const allClasses = new Set(buildClassGroups(filteredRows, transactions).map((g) => g.label));
      setCollapsedClasses(allClasses);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleClass(cls) {
    setCollapsedClasses((prev) => {
      const next = new Set(prev);
      next.has(cls) ? next.delete(cls) : next.add(cls);
      return next;
    });
  }

  function handleSort(col) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  // In class mode, displayRows is the array of group objects (not flat ticker rows).
  // In ticker mode, displayRows is the flat rows array.
  const displayRows = useMemo(() => {
    if (groupMode === "class") return buildClassGroups(filteredRows, transactions);
    return filteredRows;
  }, [filteredRows, transactions, groupMode]);

  // sortedRows only applies when groupMode === "ticker".
  // In class mode we sort groups directly.
  const sortedRows = useMemo(() => {
    if (groupMode === "class") {
      return [...displayRows].sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        const an = av ?? (sortDir === "asc" ? Infinity : -Infinity);
        const bn = bv ?? (sortDir === "asc" ? Infinity : -Infinity);
        return sortDir === "asc" ? an - bn : bn - an;
      });
    }
    return [...displayRows].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      const an = av ?? (sortDir === "asc" ? Infinity : -Infinity);
      const bn = bv ?? (sortDir === "asc" ? Infinity : -Infinity);
      return sortDir === "asc" ? an - bn : bn - an;
    });
  }, [displayRows, sortCol, sortDir, groupMode]);

  // Totals always aggregate from the base ticker rows, not from displayRows
  // (which in class mode contains group objects, not flat ticker rows).
  const totals = useMemo(() => aggPositions(filteredRows), [filteredRows]);

  const COLS = [
    { key: "ticker", label: "Ticker", align: "left" },
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

  function renderGroupHeaderRow(group) {
    const collapsed = collapsedClasses.has(group.label);
    const groupTd = {
      ...tdBase,
      background: T.cardElev,
      fontWeight: 600,
      borderTop: `1px solid ${T.border}`,
      borderBottom: `1px solid ${T.border}`,
    };
    return (
      <tr key={`group-${group.label}`} style={{ cursor: "pointer" }} onClick={() => toggleClass(group.label)}>
        <td style={{
          ...groupTd,
          ...stickyCol(T.cardElev, 2),
          textAlign: "left",
          color: T.text,
          letterSpacing: "0.06em",
        }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ChevronDown
              size={12}
              style={{
                color: T.textFaint,
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.2s",
                flexShrink: 0,
              }}
            />
            {group.label}
          </span>
        </td>
        <td style={groupTd}>{fmtUSD(group.total, valuesHidden)}</td>
        <td style={groupTd}>{fmtUSD(group.ytd, valuesHidden)}</td>
        <td style={{ ...groupTd, color: growthColor(group.yoyPct), fontWeight: 600 }}>{fmtPct(group.yoyPct)}</td>
        <td style={groupTd}>{fmtYoc(group.yoc)}</td>
        <td style={{ ...groupTd, color: T.gold }}>{fmtYoc(group.recovered)}</td>
      </tr>
    );
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {open && (
            <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6 }}>
              {[["class", "By Class"], ["ticker", "By Ticker"]].map(([mode, label]) => {
                const active = groupMode === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => {
                      if (mode === "class") {
                        setGroupMode("class");
                        const allClasses = new Set(buildClassGroups(filteredRows, transactions).map((g) => g.label));
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
          )}
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
          <ScrollHintTable leftFadeOffset={TICKER_COL_WIDTH}>
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
                      {col.key === "ticker" && (
                        <span
                          ref={tickerFilterIconRef}
                          onClick={(e) => {
                            e.stopPropagation();
                            setTickerFilterOpen((v) => !v);
                          }}
                          style={{ display: "inline-flex", marginLeft: 6, verticalAlign: "middle", cursor: "pointer" }}
                        >
                          <Filter size={11} color={tickerFilter.size > 0 ? T.gold : T.textFaint} />
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.length === 0 ? (
                  <tr>
                    <td colSpan={COLS.length} style={{ padding: "20px", fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
                      {rows.length > 0 && tickerFilter.size > 0
                        ? "No tickers match the selected filter."
                        : "No dividends recorded yet."}
                    </td>
                  </tr>
                ) : (
                  <>
                    <tr>{renderTotalRow()}</tr>
                    {groupMode === "class"
                      ? sortedRows.map((group) => (
                          <Fragment key={group.label}>
                            {renderGroupHeaderRow(group)}
                            {!collapsedClasses.has(group.label) &&
                              group.tickers
                                .slice()
                                .sort((a, b) => {
                                  const av = a[sortCol], bv = b[sortCol];
                                  if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
                                  const an = av ?? (sortDir === "asc" ? Infinity : -Infinity);
                                  const bn = bv ?? (sortDir === "asc" ? Infinity : -Infinity);
                                  return sortDir === "asc" ? an - bn : bn - an;
                                })
                                .map((row) => (
                                  <tr key={row.ticker}>{COLS.map((col) => renderCell(row, col))}</tr>
                                ))
                            }
                          </Fragment>
                        ))
                      : sortedRows.map((row) => (
                          <tr key={row.ticker}>{COLS.map((col) => renderCell(row, col))}</tr>
                        ))
                    }
                  </>
                )}
              </tbody>
            </table>
          </ScrollHintTable>
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

      {tickerFilterOpen && (
        <TickerFilterPopover
          anchor={tickerFilterIconRef.current}
          onClose={() => setTickerFilterOpen(false)}
          options={allTickers}
          selected={tickerFilter}
          onChange={setTickerFilter}
        />
      )}
    </div>
  );
}

// ── Bond Projections (future coupon payments) ─────────────────────────────────
// Projects upcoming coupon payment dates for open bank bond positions.
// Uses the same byCusip shape as buildBondEvents to extract per-CUSIP metadata.
// Returns an array of projection objects (only CUSIPs with nextPayments > 0).
function buildBondProjections(transactions, bondIncome, freqByCusip, todayISO, nMonths) {
  if (nMonths == null) nMonths = 12;
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  // Compute end-of-projection window (today + nMonths months)
  function addMonths(isoDate, n) {
    const [y, m] = isoDate.split("-");
    const yi = parseInt(y, 10);
    const mi = parseInt(m, 10);
    const totalMonths = (yi * 12 + mi - 1) + n;
    const ny = Math.floor(totalMonths / 12);
    const nm = (totalMonths % 12) + 1;
    return `${ny}-${String(nm).padStart(2, "0")}-01`;
  }

  const windowEnd = addMonths(today, nMonths);

  // FREQ_DAYS (frequency label -> interval in days) is module-level, shared
  // with buildBondEvents.

  // Collect per-CUSIP metadata from transactions
  const byCusip = {};
  for (const tx of transactions || []) {
    if (!tx || (tx.assetClass || "") !== "Bank Bonds") continue;
    const meta = parseBondNotes(tx);
    if (!meta) continue;
    const t = (tx.ticker || "").toUpperCase();
    const qty = Number(tx.qty);
    const price = Number(tx.price);
    if (!t || !isFinite(qty) || !isFinite(price)) continue;
    if (!byCusip[t]) {
      byCusip[t] = {
        txns: [],
        coupon: meta.couponPct,
        maturityISO: meta.maturityISO,
        shortName: null,
        couponFreq: null,
      };
    }
    byCusip[t].coupon = meta.couponPct;
    byCusip[t].maturityISO = meta.maturityISO;
    if (!byCusip[t].shortName && tx.shortName) {
      byCusip[t].shortName = tx.shortName;
    }
    if (!byCusip[t].couponFreq && tx.couponFreq) {
      byCusip[t].couponFreq = tx.couponFreq;
    }
    byCusip[t].txns.push({
      date: tx.date,
      side: tx.side,
      qty,
      price,
    });
  }

  const projections = [];

  for (const [cusip, info] of Object.entries(byCusip)) {
    const { txns, coupon, maturityISO, shortName } = info;
    if (!maturityISO || today >= maturityISO) continue; // already matured

    // Compute principal: sum(buy qty*price) - sum(sell qty*price), floored at 0
    let principal = 0;
    for (const t of txns) {
      const delta = t.qty * t.price;
      if (t.side === "buy") principal += delta;
      else principal -= delta;
    }
    if (principal < 0) principal = 0;
    if (principal <= 0) continue; // no open position

    // Determine frequency (prefer calibrated > tx field > default monthly)
    const freqLabel = (freqByCusip && freqByCusip[cusip]) || info.couponFreq || "monthly";
    const intervalDays = FREQ_DAYS[freqLabel] || 30;

    // Find the last real payment date for this CUSIP
    const realPayments = (bondIncome || [])
      .filter((ev) => ev && (ev.kind === "interest" || !ev.kind) && (ev.ticker || "").toUpperCase() === cusip)
      .sort(byDate);

    const txnsSorted = txns.slice().sort(byDate);
    const firstBuyDate = txnsSorted.length ? txnsSorted[0].date : today;

    const lastRealDate = realPayments.length
      ? realPayments[realPayments.length - 1].date
      : null;

    // Project from: last real payment + interval (or firstBuyDate + interval)
    const baseDate = lastRealDate || firstBuyDate;

    // Generate next payment dates starting from baseDate + intervalDays
    const nextPayments = [];
    const cutoff = maturityISO < windowEnd ? maturityISO : windowEnd;

    // Compute first projected date: baseDate + intervalDays
    let cursor = new Date(baseDate + "T00:00:00Z").getTime() + intervalDays * 86400000;

    while (cursor <= new Date(cutoff + "T00:00:00Z").getTime()) {
      const d = new Date(cursor);
      const dateISO = d.toISOString().slice(0, 10);
      if (dateISO > today) {
        const estimatedAmount = principal * (coupon / 100) * (intervalDays / 365);
        nextPayments.push({ date: dateISO, estimatedAmount });
      }
      cursor += intervalDays * 86400000;
    }

    if (!nextPayments.length) continue;

    const totalProjected = nextPayments.reduce((s, p) => s + p.estimatedAmount, 0);
    projections.push({
      cusip,
      shortName: shortName || null,
      couponPct: coupon,
      maturityISO,
      principal,
      freq: freqLabel,
      nextPayments,
      totalProjected,
    });
  }

  return projections;
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
  const [sortCol, setSortCol] = useState("cy");
  const [sortDir, setSortDir] = useState("desc");

  function toggleClass(cls) {
    setCollapsedClasses(prev => {
      const next = new Set(prev);
      next.has(cls) ? next.delete(cls) : next.add(cls);
      return next;
    });
  }

  function handleSort(col) {
    if (col === sortCol) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  function sortIndicator(col) {
    if (col !== sortCol) return " ↕";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  // Shared comparator for both class groups and ticker rows.
  // `nameField` is the object property holding the row label ("ticker" for
  // flat ticker rows, "label" for class groups) - the header column key
  // itself is always "ticker" regardless of which list is being sorted.
  // Adds the derived "delta" / "deltaPct" fields so they can be sorted by key.
  function sortByCurrentCol(list, nameField) {
    return [...list].sort((a, b) => {
      let av, bv;
      if (sortCol === "delta") {
        av = a.cy - a.py;
        bv = b.cy - b.py;
      } else if (sortCol === "deltaPct") {
        av = a.py > 0 ? (a.cy / a.py - 1) * 100 : null;
        bv = b.py > 0 ? (b.cy / b.py - 1) * 100 : null;
      } else if (sortCol === "ticker") {
        av = a[nameField];
        bv = b[nameField];
      } else {
        av = a[sortCol];
        bv = b[sortCol];
      }
      if (typeof av === "string" || typeof bv === "string") {
        return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      }
      const an = av ?? (sortDir === "asc" ? Infinity : -Infinity);
      const bn = bv ?? (sortDir === "asc" ? Infinity : -Infinity);
      return sortDir === "asc" ? an - bn : bn - an;
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
    return sortByCurrentCol(Object.values(byClass), "label");
  }, [tickerRows, groupMode, tickerToClass, sortCol, sortDir]);

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
          color: T.text,
          letterSpacing: "0.06em",
        }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ChevronDown
              size={12}
              style={{
                color: T.textFaint,
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

  // Auto-collapse all groups when groupMode is "class" and data is available.
  useEffect(() => {
    if (groupMode === "class" && tickerRows.length > 0) {
      const allClasses = new Set(tickerRows.map(r => tickerToClass[r.ticker] || "Unknown"));
      setCollapsedClasses(allClasses);
    }
  }, [groupMode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ marginTop: 16 }}>
      <button onClick={onToggle} style={cardHeaderStyle(open)}>
        <CardTitle icon={<BarChart2 size={14} strokeWidth={2} />}>Dividends Monthly Y/Y</CardTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {open && (
            <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6 }}>
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
          )}
          <ChevronDown size={16} style={{ color: T.textDim, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </div>
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
              </div>

              {tickerRows.length === 0 ? (
                <div style={{ padding: "0 16px 20px", fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
                  No dividends in {monthLabel}.
                </div>
              ) : (
                <ScrollHintTable leftFadeOffset={TICKER_COL_WIDTH}>
                  <table style={{ width: "100%", minWidth: 480, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th
                          onClick={() => handleSort("ticker")}
                          style={{ ...stickyTh(), cursor: "pointer", userSelect: "none", color: sortCol === "ticker" ? T.textDim : T.textFaint }}
                        >
                          {groupMode === "class" ? "Class" : "Ticker"}
                          <span style={{ opacity: sortCol === "ticker" ? 0.9 : 0.35 }}>{sortIndicator("ticker")}</span>
                        </th>
                        <th
                          onClick={() => handleSort("py")}
                          style={{ ...thStyle, cursor: "pointer", userSelect: "none", color: sortCol === "py" ? T.textDim : T.textFaint }}
                        >
                          {priorYear}
                          <span style={{ opacity: sortCol === "py" ? 0.9 : 0.35 }}>{sortIndicator("py")}</span>
                        </th>
                        <th
                          onClick={() => handleSort("cy")}
                          style={{ ...thStyle, cursor: "pointer", userSelect: "none", color: sortCol === "cy" ? T.textDim : T.textFaint }}
                        >
                          {curYear}
                          <span style={{ opacity: sortCol === "cy" ? 0.9 : 0.35 }}>{sortIndicator("cy")}</span>
                        </th>
                        <th
                          onClick={() => handleSort("delta")}
                          style={{ ...thStyle, cursor: "pointer", userSelect: "none", color: sortCol === "delta" ? T.textDim : T.textFaint }}
                        >
                          Δ $
                          <span style={{ opacity: sortCol === "delta" ? 0.9 : 0.35 }}>{sortIndicator("delta")}</span>
                        </th>
                        <th
                          onClick={() => handleSort("deltaPct")}
                          style={{ ...thStyle, cursor: "pointer", userSelect: "none", color: sortCol === "deltaPct" ? T.textDim : T.textFaint }}
                        >
                          Δ %
                          <span style={{ opacity: sortCol === "deltaPct" ? 0.9 : 0.35 }}>{sortIndicator("deltaPct")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {renderDataRow("TOTAL", totalPY, totalCY, true)}
                      {groupMode === "class" && classGroups
                        ? classGroups.map(group => (
                            <Fragment key={group.label}>
                              {renderGroupHeaderRow(group.label, group.py, group.cy)}
                              {!collapsedClasses.has(group.label) && sortByCurrentCol(group.tickers, "ticker").map(r => renderDataRow(r.ticker, r.py, r.cy, false))}
                            </Fragment>
                          ))
                        : sortByCurrentCol(tickerRows, "ticker").map(r => renderDataRow(r.ticker, r.py, r.cy, false))
                      }
                    </tbody>
                  </table>
                </ScrollHintTable>
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

function DivHistPopover({ anchor, onClose, sortDir, onSort, filterable, options, selected, onChange, dateMonths, setDateMonths, dateOptions }) {
  const isDateFilter = !!dateMonths;
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

      {filterable && isDateFilter && (
        <>
          <div style={{ height: 1, background: T.border, marginBottom: 12 }} />
          <div style={secLabel}>Filter by month</div>
          <DateMonthPicker
            dateOptions={dateOptions}
            selectedMonths={dateMonths}
            onChange={setDateMonths}
            T={T}
            FONT_MONO={FONT_MONO}
          />
        </>
      )}

      {filterable && !isDateFilter && options && (
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
  const [filters, setFilters] = useState({ ticker: new Set(), dateMonths: new Set() });

  const allTickers = useMemo(() => [...new Set(events.map(e => e.ticker))].sort(), [events]);

  // Date options: Map<year(number), Set<month(number 1-based)>> for the picker.
  const dateOptions = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      const m = String(e.date || "").match(/^(\d{4})-(\d{2})/);
      if (!m) continue;
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      if (!map.has(year)) map.set(year, new Set());
      map.get(year).add(month);
    }
    return map;
  }, [events]);

  function isFiltered(col) {
    if (col === "date") return filters.dateMonths.size > 0;
    if (col === "ticker") return filters.ticker.size > 0 && filters.ticker.size < allTickers.length;
    return false;
  }

  const visible = useMemo(() => {
    let list = events.filter(e => {
      if (filters.ticker.size > 0 && !filters.ticker.has(e.ticker)) return false;
      if (filters.dateMonths.size > 0 && !filters.dateMonths.has(String(e.date || "").slice(0, 7))) return false;
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
  // Gross/tax breakdown — only meaningful (and only shown) when at least one foreign-tax
  // row is present among the visible rows. totalReceived above is already the net figure
  // (gross dividends + negative tax rows summed together).
  const grossReceived = useMemo(
    () => visible.reduce((s, e) => s + (e.incomeType !== "tax" ? (e.totalReceived || 0) : 0), 0),
    [visible]
  );
  const taxWithheld = useMemo(
    () => visible.reduce((s, e) => s + (e.incomeType === "tax" ? (e.totalReceived || 0) : 0), 0),
    [visible]
  );
  const hasTaxRows = taxWithheld !== 0;

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
          {hasTaxRows && (
            <div style={{ display: "flex", gap: 18, padding: "10px 16px", borderBottom: `1px solid ${T.borderSoft}`, background: "rgba(224,164,88,0.04)" }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                Gross <span style={{ color: T.text }}>{fmtUSD(grossReceived, valuesHidden)}</span>
              </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                Foreign Tax <span style={{ color: T.red }}>{fmtUSD(taxWithheld, valuesHidden)}</span>
              </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                Net <span style={{ color: T.green, fontWeight: 600 }}>{fmtUSD(totalReceived, valuesHidden)}</span>
              </span>
            </div>
          )}
          {events.length === 0 ? (
            <div style={{ padding: "20px", fontFamily: FONT_BODY, fontSize: 13, color: T.textDim }}>
              No dividend payments recorded yet.
            </div>
          ) : (
            <ScrollHintTable style={{ maxHeight: 420, overflowY: "auto" }}>
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
                  {visible.map((e, i) => {
                    const isTax = e.incomeType === "tax";
                    return (
                    <tr key={`${e.ticker}-${e.date}-${i}`} style={isTax ? { background: "rgba(232,140,140,0.04)" } : undefined}>
                      <td style={{ ...tdBase, textAlign: "left", color: T.textDim }} title={e.source === "estimated" ? "Estimated bond interest accrual (no real payment imported for this period)" : e.exDate ? `Ex-date: ${e.exDate}${e.payDate ? "" : " (pay date n/a — showing ex-date)"}` : undefined}>{e.date}</td>
                      <td style={{ ...tdBase, textAlign: "left", color: T.gold, fontWeight: 600, letterSpacing: "0.06em" }}>
                        {e.ticker}
                        {isTax && (
                          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: T.red, marginLeft: 6, letterSpacing: "0.1em", border: "1px solid rgba(232,140,140,0.4)", borderRadius: 3, padding: "1px 4px", verticalAlign: "middle" }}>TAX</span>
                        )}
                        {e.source === "estimated" && (
                          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: T.textFaint, marginLeft: 6, letterSpacing: "0.1em", border: `1px solid ${T.borderSoft}`, borderRadius: 3, padding: "1px 4px", verticalAlign: "middle" }}>EST</span>
                        )}
                        {e.payDateUncertain && (
                          <span
                            title={e.exDate ? `Ex-date: ${e.exDate} (pay date n/a - showing ex-date)` : undefined}
                            style={{ fontFamily: FONT_MONO, fontSize: 8, color: "#e0a458", marginLeft: 6, letterSpacing: "0.1em", border: "1px solid rgba(224,164,88,0.4)", borderRadius: 3, padding: "1px 4px", verticalAlign: "middle" }}
                          >
                            EX-DATE
                          </span>
                        )}
                      </td>
                      <td style={tdBase}>{isTax ? "—" : fmtPerShare(e.amountPerShare, valuesHidden)}</td>
                      <td style={tdBase}>{isTax ? "—" : fmtQty(e.qtyHeld)}</td>
                      <td style={{ ...tdBase, color: isTax ? T.red : T.green, fontWeight: 600 }}>{fmtUSD(e.totalReceived, valuesHidden)}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollHintTable>
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
          dateMonths={isDateCol ? filters.dateMonths : undefined}
          setDateMonths={isDateCol ? next => setFilters(f => ({ ...f, dateMonths: next })) : undefined}
          dateOptions={isDateCol ? dateOptions : undefined}
        />
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DividendsView({ auth, onAuthFail, valuesHidden }) {
  const [transactions, setTransactions] = useState([]);
  const [bondIncome, setBondIncome] = useState([]);
  const [events, setEvents] = useState([]);
  const [foreignTax, setForeignTax] = useState([]);
  const [state, setState] = useState("loading"); // loading | done | error
  const [error, setError] = useState(null);

  const [groupBy, setGroupBy] = useState("Month");
  const [selectedYears, setSelectedYears] = useState(new Set());
  const [selectedTickers, setSelectedTickers] = useState(new Set());
  const [selectedAssetClasses, setSelectedAssetClasses] = useState(new Set());

  const [incomeOpen, setIncomeOpen] = useState(true);
  const [posOpen, setPosOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [yoyOpen, setYoyOpen] = useState(false);
  const [bondProjOpen, setBondProjOpen] = useState(false);

  const todayISO = useMemo(() => localTodayISO(), []);

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
        // Use a local — `bondIncome` state isn't updated yet inside this closure
        // (setBondIncome is async), so referencing the state var would send a stale
        // (empty) array to /api/dividends and change the de-dupe/cache behavior.
        const bi = Array.isArray(txData.bondIncome) ? txData.bondIncome : [];
        if (!cancelled) {
          setTransactions(txs);
          setBondIncome(bi);
        }

        if (!txs.length) {
          if (!cancelled) { setEvents([]); setForeignTax([]); setState("done"); }
          return;
        }

        const divKey = divSessionKey({ txs, bi, day: localTodayISO() });
        let divData = divSessionCache.get(divKey);
        if (!divData) {
          const divRes = await fetch("/api/dividends", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ transactions: txs, bondIncome: bi, todayISO: localTodayISO() }),
          });
          if (divRes.status === 401) { onAuthFail?.(); return; }
          if (!divRes.ok) throw new Error(`Dividends: ${divRes.status}`);
          divData = await divRes.json();
          divSessionCache.set(divKey, divData);
        }
        if (!cancelled) {
          setEvents(Array.isArray(divData.events) ? divData.events : []);
          setForeignTax(Array.isArray(divData.foreignTax) ? divData.foreignTax : []);
          setState("done");
        }
      } catch (err) {
        if (!cancelled) { setError(err.message); setState("error"); }
      }
    })();

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Bond interest events (real + estimated) in the same shape as stock dividend events.
  // Merged into allEvents so every card — chart, Position Dividends, Dividend History,
  // Y/Y, KPIs — sees bond income alongside stock dividends without separate logic.
  const { events: bondEvents, freqByCusip } = useMemo(
    () => buildBondEvents(transactions, bondIncome, todayISO),
    [transactions, bondIncome, todayISO]
  );
  // Foreign tax withheld (negative totalReceived, incomeType "tax") is merged in here too —
  // dividend events carry the GROSS amount Fidelity reported (confirmed against a real
  // export: e.g. TSM's $8.45 matches the official gross $/ADS rate), so every aggregate
  // that sums totalReceived needs the tax event netted in to reflect actual cash received.
  // Previously kept separate (pre-jul/2026) under the wrong assumption dividends were
  // already net — see "Foreign tax withheld" in Decisões Técnicas (CONTEXT.md) for the fix.
  const allEvents = useMemo(
    () => [...events, ...bondEvents, ...foreignTax],
    [events, bondEvents, foreignTax]
  );

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

    // KPIs loop over allEvents (stock dividends + bond interest) — no separate bondKpis needed.
    let allTime = 0, ytd = 0, month = 0, priorYtd = 0, priorMonth = 0, prevCalMonth = 0;
    let bondTotal = 0, bondYtd = 0, bondMonth = 0;
    for (const e of allEvents) {
      allTime += e.totalReceived;
      if (e.date.startsWith(thisYear)) ytd += e.totalReceived;
      if (e.date.startsWith(thisMonth)) month += e.totalReceived;
      // Y/Y uses only real dividend events (stock dividends + real bond payments).
      // Estimated accrual has no prior-year counterpart — exclude to avoid skewing Y/Y.
      if (e.source !== "estimated") {
        if (e.date.startsWith(priorYear) && e.date.slice(5, 10) <= mmdd) priorYtd += e.totalReceived;
        if (e.date.startsWith(priorYearMonth)) priorMonth += e.totalReceived;
        if (e.date.startsWith(prevMonthStr)) prevCalMonth += e.totalReceived;
      }
      if (e.assetClass === "Bank Bonds") {
        bondTotal += e.totalReceived;
        if (e.date.startsWith(thisYear)) bondYtd += e.totalReceived;
        if (e.date.startsWith(thisMonth)) bondMonth += e.totalReceived;
      }
    }
    const yoyYtd = priorYtd > 0 ? (ytd / priorYtd - 1) * 100 : null;
    const yoyMonth = priorMonth > 0 ? (month / priorMonth - 1) * 100 : null;
    const momDelta = prevCalMonth > 0 ? (month / prevCalMonth - 1) * 100 : null;

    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const thisMonthLabel = `${MONTHS[now.getMonth()]} ${curYear}`;
    const prevMonthLabel = `${MONTHS[prevMonthDate.getMonth()]} ${prevMonthDate.getFullYear()}`;

    // Bond interest KPI subtitle: detect real vs estimated mix.
    const hasRealBond = allEvents.some((e) => e.assetClass === "Bank Bonds" && e.source === "fidelity");
    const hasEstBond = allEvents.some((e) => e.assetClass === "Bank Bonds" && e.source === "estimated");
    const bondLabel = !hasRealBond ? "est. bond interest"
      : hasEstBond ? "bond interest (real + est.)"
      : "bond interest";

    return {
      allTime, ytd, month, priorYtd, priorMonth, yoyYtd, yoyMonth,
      prevCalMonth, momDelta, thisMonthLabel, prevMonthLabel,
      bondTotal, bondYtd, bondMonth, bondLabel,
    };
  }, [allEvents]);

  const availableYears = useMemo(() => {
    const ys = [...new Set(allEvents.map((e) => e.date.slice(0, 4)))].sort((a, b) => b - a);
    return ys;
  }, [allEvents]);

  const availableTickers = useMemo(() => {
    return [...new Set(allEvents.map((e) => e.ticker))].sort();
  }, [allEvents]);

  const availableAssetClasses = useMemo(() => {
    return [...new Set(allEvents.map((e) => e.assetClass).filter(Boolean))].sort();
  }, [allEvents]);

  const chartData = useMemo(
    () => buildChartData(allEvents, groupBy, selectedYears, selectedTickers, selectedAssetClasses),
    [allEvents, groupBy, selectedYears, selectedTickers, selectedAssetClasses]
  );
  const hasChartData = chartData.some((d) => d.value > 0);
  const xInterval = chartData.length > 12 ? Math.ceil(chartData.length / 10) - 1 : 0;

  const costBasis = useMemo(() => computeCostBasis(transactions), [transactions]);
  const positionRows = useMemo(
    () => buildPositionRows(allEvents, costBasis),
    [allEvents, costBasis]
  );

  const bondProjections = useMemo(
    () => buildBondProjections(transactions, bondIncome, freqByCusip, todayISO, 12),
    [transactions, bondIncome, freqByCusip, todayISO]
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

                {/* KPI cards — allEvents (stock dividends + bond interest) */}
                <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                  <KpiCard
                    label="All Time"
                    value={fmtUSD0(kpis.allTime, valuesHidden)}
                    sub={kpis.bondTotal > 0 ? `incl. ${fmtUSD0(kpis.bondTotal, valuesHidden)} ${kpis.bondLabel}` : null}
                  />
                  <KpiCard
                    label="YTD"
                    value={fmtUSD0(kpis.ytd, valuesHidden)}
                    yoy={kpis.yoyYtd}
                    sub={kpis.bondYtd > 0 ? `incl. ${fmtUSD0(kpis.bondYtd, valuesHidden)} ${kpis.bondLabel}` : null}
                  />
                  <KpiCard
                    label="This Month"
                    value={fmtUSD0(kpis.month, valuesHidden)}
                    yoy={kpis.yoyMonth}
                    sub={kpis.bondMonth > 0 ? `incl. ${fmtUSD0(kpis.bondMonth, valuesHidden)} ${kpis.bondLabel}` : null}
                  />
                </div>

                {/* Year, Ticker and Asset Class selectors */}
                <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
                  <FilterMultiSelect label="Years" options={availableYears} selected={selectedYears} onChange={setSelectedYears} />
                  <FilterMultiSelect label="Tickers" options={availableTickers} selected={selectedTickers} onChange={setSelectedTickers} />
                  <FilterMultiSelect label="Classes" options={availableAssetClasses} selected={selectedAssetClasses} onChange={setSelectedAssetClasses} />
                </div>

                {/* Group-by selector */}
                <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                  {PERIOD_OPTIONS.map((p) => {
                    const active = groupBy === p;
                    return (
                      <button
                        key={p}
                        onClick={() => setGroupBy(p)}
                        title={p}
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
                        {p[0]}
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
          events={allEvents}
          transactions={transactions}
          valuesHidden={valuesHidden}
          open={yoyOpen}
          onToggle={() => setYoyOpen((v) => !v)}
        />
      )}

      {/* ── Dividend History (audit) ── */}
      {state === "done" && (
        <DividendHistoryTable
          events={allEvents}
          valuesHidden={valuesHidden}
          open={histOpen}
          onToggle={() => setHistOpen((v) => !v)}
        />
      )}

      {/* ── Bond Projections ── */}
      {state === "done" && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => setBondProjOpen((v) => !v)}
            style={cardHeaderStyle(bondProjOpen)}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <CardTitle icon={<Receipt size={14} strokeWidth={2} />}>Bond Projections</CardTitle>
              <span style={{
                fontFamily: FONT_MONO,
                fontSize: 9,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: T.gold,
                border: `1px solid ${T.gold}55`,
                borderRadius: 3,
                padding: "2px 6px",
                marginLeft: 4,
                whiteSpace: "nowrap",
              }}>EST</span>
            </span>
            <ChevronDown
              size={16}
              style={{
                color: T.textDim,
                transform: bondProjOpen ? "rotate(180deg)" : "none",
                transition: "transform 0.2s",
              }}
            />
          </button>

          {bondProjOpen && (
            <div style={{ ...cardBodyStyle }}>
              {bondProjections.length === 0 ? (
                <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                  No open bond positions with projection data.
                </div>
              ) : (
                bondProjections.map((proj) => {
                  const matLabel = (() => {
                    const [y, m] = proj.maturityISO.split("-");
                    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
                    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
                  })();
                  const tdH = {
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    fontWeight: 500,
                    padding: "7px 10px",
                    borderBottom: `1px solid ${T.border}`,
                    color: T.textFaint,
                    textAlign: "right",
                    whiteSpace: "nowrap",
                  };
                  const tdB = {
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    padding: "8px 10px",
                    textAlign: "right",
                    borderBottom: `1px solid ${T.borderSoft}`,
                    color: T.text,
                    whiteSpace: "nowrap",
                  };
                  const tdBLeft = { ...tdB, textAlign: "left", color: T.textDim };
                  return (
                    <div
                      key={proj.cusip}
                      style={{
                        background: T.cardElev,
                        border: `1px solid ${T.borderSoft}`,
                        borderRadius: 4,
                        marginBottom: 14,
                        overflow: "hidden",
                      }}
                    >
                      {/* Sub-header */}
                      <div style={{
                        padding: "10px 14px",
                        borderBottom: `1px solid ${T.border}`,
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        alignItems: "center",
                      }}>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, color: T.gold, letterSpacing: "0.06em" }}>
                          {proj.shortName || proj.cusip}
                        </span>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                          {proj.freq
                            ? proj.freq.charAt(0).toUpperCase() + proj.freq.slice(1)
                            : "Monthly"}
                          {proj.couponPct ? ` · ${proj.couponPct}%` : ""}
                          {matLabel ? ` · Matures ${matLabel}` : ""}
                        </span>
                      </div>

                      {/* Principal */}
                      <div style={{ padding: "8px 14px", borderBottom: `1px solid ${T.borderSoft}` }}>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                          Principal:{" "}
                        </span>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text }}>
                          {fmtUSD(proj.principal, valuesHidden)}
                        </span>
                      </div>

                      {/* Payments table */}
                      <ScrollHintTable fadeBg={T.cardElev}>
                        <table style={{ width: "100%", minWidth: 300, borderCollapse: "collapse" }}>
                          <thead>
                            <tr>
                              <th style={{ ...tdH, textAlign: "left" }}>Date</th>
                              <th style={tdH}>Est. Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {proj.nextPayments.map((pmt, pi) => (
                              <tr key={pi}>
                                <td style={tdBLeft}>{pmt.date}</td>
                                <td style={{ ...tdB, color: T.green, fontWeight: 600 }}>
                                  {fmtUSD(pmt.estimatedAmount, valuesHidden)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr style={{ background: "rgba(201,169,97,0.06)" }}>
                              <td style={{
                                ...tdBLeft,
                                fontWeight: 700,
                                color: T.gold,
                                fontFamily: FONT_MONO,
                                fontSize: 10,
                                letterSpacing: "0.12em",
                                textTransform: "uppercase",
                                borderTop: `1px solid ${T.border}`,
                              }}>
                                Total projected
                              </td>
                              <td style={{
                                ...tdB,
                                fontWeight: 700,
                                color: T.green,
                                borderTop: `1px solid ${T.border}`,
                              }}>
                                {fmtUSD(proj.totalProjected, valuesHidden)}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </ScrollHintTable>
                    </div>
                  );
                })
              )}
              <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, marginTop: 8, letterSpacing: "0.04em" }}>
                Projected payments are estimates based on coupon rate and principal. Actual payments may differ.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
