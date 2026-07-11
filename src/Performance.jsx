// src/Performance.jsx — Performance view
// Lazy-loaded. Shows portfolio USD value by default; toggling "vs S&P 500"
// switches to a TWR % comparison chart.

import { useEffect, useState, useMemo, useRef, Fragment } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, TrendingUp, BarChart2, Filter, Layers } from "lucide-react";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
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
  return {
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
    bondIncome: Array.isArray(data.bondIncome) ? data.bondIncome : [],
  };
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

  if (period === "5Y" || period === "MAX" || period === "All") {
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

  // 6M, YTD, 1Y, 2Y — first-of-month ticks, thinned out as the span grows so
  // labels stay ~6-8 wide regardless of period (1Y: every other month, 2Y:
  // quarterly).
  const monthStep = period === "2Y" ? 3 : period === "1Y" ? 2 : 1;
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

// ── Bank Bonds helpers (copied from Dividends.jsx) ────────────────────────────
function parseBondNotes(tx) {
  if (tx.couponRate != null && tx.maturityDate) {
    const couponPct = Number(tx.couponRate);
    if (isFinite(couponPct) && couponPct > 0 && /^\d{4}-\d{2}-\d{2}$/.test(tx.maturityDate)) {
      return { couponPct, maturityISO: tx.maturityDate };
    }
  }
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

function freqFromDays(d) {
  if (!isFinite(d) || d <= 0) return null;
  if (d <= 45) return "monthly";
  if (d <= 135) return "quarterly";
  if (d <= 270) return "semi-annual";
  return "annual";
}

// Frequency label -> coupon interval in days. Kept in sync with the copy in
// src/Dividends.jsx (no shared module between the two files, per project convention).
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

// Generates one estimated-interest event per fully-elapsed coupon period of
// length intervalDays within [startISO, endISO). A period is only emitted when
// it is entirely within the window (periodEnd <= endISO) — the still-running
// partial period at the tail is dropped, since no money has actually been paid
// for it yet. Principal can change mid-period (buy/sell); the accrual for each
// period sums principal x days across the overlapping constant-principal
// segments, ACT/365 convention.
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

function buildBondEvents(transactions, bondIncome, todayISO) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const events = [];

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

  const freqByCusip = {};
  for (const [t, real] of Object.entries(realByCusip)) {
    if (real.length < 2) continue;
    const diffs = [];
    const sorted = real.slice().sort(byDate);
    for (let i = 1; i < sorted.length; i++) diffs.push(daysBetweenISO(sorted[i - 1].date, sorted[i].date));
    diffs.sort((a, b) => a - b);
    freqByCusip[t] = freqFromDays(diffs[Math.floor(diffs.length / 2)]);
  }

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
    // on the same day), or from the first transaction date if there has never
    // been a real payment for this CUSIP.
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

// Generalized replay + accrued-interest projection for Bank Bonds, extracted
// from the Position Performance calculation (positionRows below) so both it
// and the Composition Evolution card share a single source of truth instead
// of two divergent implementations of the same math. `asOfISO` defaults to
// today; the Composition Evolution card calls this once per historical date
// in the composition series to build a client-side Bank Bonds value series.
function computeBankBondsValueAt(transactions, asOfISO) {
  const asOf = asOfISO || new Date().toISOString().slice(0, 10);
  const sorted = (transactions || [])
    .filter((tx) => tx?.assetClass === "Bank Bonds" && tx.date && tx.date <= asOf)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const positions = {};
  for (const tx of sorted) {
    const ticker = tx.ticker?.toUpperCase();
    if (!ticker) continue;
    if (!positions[ticker]) positions[ticker] = { totalQty: 0, totalCost: 0, lastBuyDate: null, lastBuyNotes: null };
    const pos = positions[ticker];
    const qty = Number(tx.qty) || 0;
    const price = Number(tx.price) || 0;
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

  const byTicker = {};
  let total = 0;
  for (const [ticker, pos] of Object.entries(positions)) {
    if (pos.totalQty < 0.0001) continue;
    const avgCost = pos.totalCost / pos.totalQty;
    const totalCost = avgCost * pos.totalQty;
    let totalValue = totalCost;
    if (pos.lastBuyNotes && pos.lastBuyDate) {
      const couponM = pos.lastBuyNotes.match(/(\d+\.\d+)%/);
      const maturityM = pos.lastBuyNotes.match(/\d{2}\/\d{2}\/\d{4}$/);
      if (couponM && maturityM) {
        const annualRate = parseFloat(couponM[1]) / 100;
        const purchaseTs = new Date(pos.lastBuyDate + "T00:00:00").getTime();
        const asOfTs = new Date(asOf + "T00:00:00").getTime();
        const daysSincePurchase = Math.max(0, (asOfTs - purchaseTs) / 86400000);
        totalValue = totalCost + totalCost * annualRate * (daysSincePurchase / 365);
      }
    }
    byTicker[ticker] = { qty: pos.totalQty, avgCost, totalCost, totalValue };
    total += totalValue;
  }
  return { total, byTicker };
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

// Dynamic chart card title covering every combination of the two independent
// toggles (Compare vs S&P 500, Show Total Return). Default (both off) keeps
// the original "Net Worth Growth" copy — zero regression for existing users.
function chartTitle(pctMode, comparing, showTotalReturn) {
  if (!pctMode) return "Net Worth Growth";
  if (comparing && showTotalReturn) return "Portfolio vs Total Return vs S&P 500";
  if (comparing) return "Portfolio VS S&P 500";
  if (showTotalReturn) return "Portfolio vs Total Return";
  return "Portfolio Performance";
}

// Asset classes eligible for the performance chart. Kept in sync with
// INCLUDED_CLASSES in api/perf-history.js (duplicated, not imported — the
// server module isn't reachable from client bundles).
const PERF_ELIGIBLE_CLASSES = new Set([
  "Stocks",
  "BRA Stocks",
  "Alternative",
  "Real Estate",
  "Bonds",
  "Bank Bonds",
  "BRA Fixed Income",
  "Unallocated USD",
]);

const PERIODS = [
  { label: "1M",  days: 30 },
  { label: "6M",  days: 182 },
  { label: "YTD", ytd: true },
  { label: "1Y",  days: 365 },
  { label: "5Y",  days: 1825 },
  { label: "MAX", days: Infinity },
];

function getWindowData(rawData, period, divEvents) {
  if (!rawData.length) return { data: [], lastPortfolio: null, lastSpy: null, lastUSD: null, lastTotalReturn: null };

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
  if (!slice.length) return { data: [], lastPortfolio: null, lastSpy: null, lastUSD: null, lastTotalReturn: null };

  const baseP = slice[0].portfolio;
  const baseS = slice[0].spy;
  const toWin = (v, base) => +((((1 + v / 100) / (1 + base / 100) - 1) * 100).toFixed(2));

  const startDate = slice[0].date;
  const initialPortfolioUSD = rawData[startIdx].usd;
  const safeEvents = Array.isArray(divEvents) ? divEvents : [];

  let lastTotalReturn = null;
  const data = slice.map((d) => {
    const portfolio = toWin(d.portfolio, baseP);
    const spy = toWin(d.spy, baseS);
    let totalReturn;
    if (initialPortfolioUSD) {
      const cumulativeDivsUSD = safeEvents
        .filter((e) => e.date >= startDate && e.date <= d.date)
        .reduce((s, e) => s + (e.totalReceived || 0), 0);
      totalReturn = +(portfolio + (cumulativeDivsUSD / initialPortfolioUSD) * 100).toFixed(2);
      lastTotalReturn = totalReturn;
    }
    return {
      date: d.date,
      dateTs: new Date(d.date + "T00:00:00Z").getTime(),
      portfolio,
      spy,
      usd: d.usd,
      totalReturn,
    };
  });

  const last = data[data.length - 1];
  return {
    data,
    lastPortfolio: last.portfolio,
    lastSpy: last.spy,
    lastUSD: last.usd,
    lastTotalReturn,
  };
}

// Fixed display order + color for the Composition Evolution card. Distinct
// from PERF_ELIGIBLE_CLASSES only in that BRA Fixed Income is excluded (no
// market price source, cannot be reconstructed historically — see CONTEXT.md).
const COMPOSITION_CLASS_ORDER = [
  "Stocks",
  "BRA Stocks",
  "Alternative",
  "Real Estate",
  "Bonds",
  "Bank Bonds",
  "Unallocated USD",
];

const COMPOSITION_COLORS = {
  "Stocks": T.blue,
  "BRA Stocks": T.green,
  "Alternative": T.orange,
  "Real Estate": "#a78bfa",
  "Bonds": "#5eead4",
  "Bank Bonds": T.gold,
  "Unallocated USD": T.textDim,
};

// Composition Evolution's "Ticker" view can have far more series than the
// 7 asset classes, so colors are assigned by cycling this palette (sorted by
// each ticker's total contribution) instead of a fixed per-key map.
const TICKER_PALETTE = [
  T.blue, T.green, T.orange, "#a78bfa", "#5eead4", T.gold, "#f472b6",
  T.red, "#38bdf8", "#facc15", "#4ade80", "#c084fc", T.textDim,
];

// Distinct from PERIODS (1M/6M/YTD/1Y/5Y/MAX, used by the TWR chart above) —
// the composition card only needs long-horizon windows.
const COMPOSITION_PERIODS = [
  { label: "1Y", days: 365 },
  { label: "2Y", days: 730 },
  { label: "5Y", days: 1825 },
  { label: "All", days: Infinity },
];

// Slices a { dates, classValues } series to a period window. Same cutoff
// pattern as getWindowData, but client-side over composition.dates (which are
// sparse — only real transaction dates, not a daily grid).
function getCompositionWindow(merged, period) {
  const dates = merged?.dates || [];
  if (!dates.length) return { dates: [], classValues: {} };

  const p = COMPOSITION_PERIODS.find((x) => x.label === period) || COMPOSITION_PERIODS[0];
  let cutoff = null;
  if (p.days !== Infinity) {
    cutoff = new Date(Date.now() - p.days * 86400 * 1000).toISOString().slice(0, 10);
  }

  let startIdx = 0;
  if (cutoff) {
    const found = dates.findIndex((d) => d >= cutoff);
    startIdx = found >= 0 ? found : dates.length - 1;
  }

  const slicedDates = dates.slice(startIdx);
  const classValues = {};
  for (const [cls, arr] of Object.entries(merged.classValues || {})) {
    classValues[cls] = arr.slice(startIdx);
  }
  return { dates: slicedDates, classValues };
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
  const hasDivData = rows.some((r) => r.divTtm != null);
  const divTtmSum = hasDivData ? rows.reduce((s, r) => s + (r.divTtm ?? 0), 0) : null;
  const totalDiv = hasDivData ? rows.reduce((s, r) => s + (r.totalDiv ?? 0), 0) : null;
  const yoc = hasDivData && totalCost > 0 ? (divTtmSum / totalCost) * 100 : null;
  return { totalCost, totalValue, totalGainLoss, gainLossPct, divTtmSum, totalDiv, yoc };
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
// teaches the horizontal-scroll gesture. Fades are persistent; the pill is
// dismissed globally (localStorage flag, no per-user scoping - low-risk UI
// preference) after the first real horizontal scroll or a ~4s timeout.
const SCROLL_HINT_SEEN_KEY = "scrollHintSeen";

function ScrollHintTable({ children, style, leftFadeOffset = 0, fadeBg = T.card }) {
  const scrollRef = useRef(null);
  const dismissTimerRef = useRef(null);
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
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
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
      setPillPhase((p) => {
        if (p !== "hidden") return p;
        if (!dismissTimerRef.current) {
          dismissTimerRef.current = setTimeout(dismissPill, 4000);
        }
        return "visible";
      });
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
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
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
    let ticks = 0;
    const id = setInterval(() => {
      setBounce((b) => !b);
      ticks += 1;
      if (ticks >= 6) clearInterval(id);
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

function PositionPerformanceTable({ rows, valuesHidden, open, onToggle }) {
  const [sortCol, setSortCol] = useState("ticker");
  const [sortDir, setSortDir] = useState("asc");
  const [grouped, setGrouped] = useState(true);
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

  // Auto-collapse all groups when switching to grouped mode or on mount (default grouped=true).
  useEffect(() => {
    if (grouped && rows.length > 0) {
      const map = {};
      for (const row of rows) {
        const cls = row.assetClass || "Uncategorized";
        if (!map[cls]) map[cls] = [];
        map[cls].push(row);
      }
      setCollapsedClasses(new Set(Object.keys(map)));
    }
  }, [grouped]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const sortedRows = useMemo(() => sortRows(filteredRows), [filteredRows, sortCol, sortDir]);

  const totals = useMemo(() => aggFromRows(filteredRows), [filteredRows]);

  // Group rows by assetClass, each group sorted by sortCol.
  const classGroups = useMemo(() => {
    if (!grouped) return null;
    const map = {};
    for (const row of filteredRows) {
      const cls = row.assetClass || "Uncategorized";
      if (!map[cls]) map[cls] = [];
      map[cls].push(row);
    }
    return Object.entries(map)
      .map(([cls, clsRows]) => ({ cls, rows: sortRows(clsRows), ...aggFromRows(clsRows) }))
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [filteredRows, grouped, sortCol, sortDir]);

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
    { key: "divTtm",       label: "Div TTM",         align: "right" },
    { key: "yoc",          label: "YoC %",           align: "right" },
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
      case "divTtm":
        if (row.divTtm == null) return <td key={col.key} style={{ ...tdBase, color: T.textFaint }}>{"—"}</td>;
        return <td key={col.key} style={tdBase}>{valuesHidden ? "$ ••••" : fmtPrice(row.divTtm)}</td>;
      case "yoc":
        if (row.yoc == null) return <td key={col.key} style={{ ...tdBase, color: T.textFaint }}>{"—"}</td>;
        return <td key={col.key} style={{ ...tdBase, color: T.textDim }}>{`${row.yoc.toFixed(2)}%`}</td>;
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
        case "divTtm":
          if (agg.divTtmSum == null) return <td key={col.key} style={{ ...summaryTd, color: T.textFaint }}>{"—"}</td>;
          return <td key={col.key} style={summaryTd}>{valuesHidden ? "$ ••••" : fmtPrice(agg.divTtmSum)}</td>;
        case "yoc":
          if (agg.yoc == null) return <td key={col.key} style={{ ...summaryTd, color: T.textFaint }}>{"—"}</td>;
          return <td key={col.key} style={{ ...summaryTd, color: T.textDim }}>{`${agg.yoc.toFixed(2)}%`}</td>;
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {open && (
            <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6 }}>
              {[["class", "By Class"], ["ticker", "By Ticker"]].map(([mode, label]) => {
                const active = (mode === "class") === grouped;
                return (
                  <button
                    key={mode}
                    onClick={() => setGrouped(mode === "class")}
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
          <ChevronDown
            size={16}
            style={{
              color: T.textDim,
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 0.2s",
            }}
          />
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
            <table style={{ width: "100%", minWidth: 1060, borderCollapse: "collapse" }}>
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
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={COLS.length} style={{ padding: "20px", fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
                      No tickers match the selected filter.
                    </td>
                  </tr>
                ) : (
                  <>
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
                  </>
                )}
              </tbody>
            </table>
          </ScrollHintTable>
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

// Multi-select filter chip: trigger button + TickerFilterPopover, deferring the
// commit of the selection (and therefore any downstream refetch) until the
// popover closes. The popover itself updates a local `draft` Set on every
// checkbox click for instant visual feedback; `onCommit` only fires once, on
// close, so callers don't refetch on every individual checkbox toggle.
function FilterChip({ label, options, committed, onCommit }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(committed);
  const btnRef = useRef(null);

  function handleOpen() {
    setDraft(committed);
    setOpen(true);
  }

  function handleClose() {
    setOpen(false);
    onCommit(draft);
  }

  const active = committed.size > 0;
  const triggerText = active ? [...committed].sort().join(", ") : label;

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        onClick={handleOpen}
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
          maxWidth: 170,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{triggerText}</span>
        <span style={{ color: T.textDim, fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <TickerFilterPopover
          anchor={btnRef.current}
          onClose={handleClose}
          options={options}
          selected={draft}
          onChange={setDraft}
        />
      )}
    </div>
  );
}

// Small 2-option pill toggle (e.g. Class/Ticker, Area/River) — a more
// compact variant of the period pills, used for secondary view switches.
function SegmentedToggle({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.06em",
              padding: "5px 10px",
              border: `1px solid ${active ? T.gold : T.border}`,
              borderRadius: 4,
              background: active ? T.gold : T.cardElev,
              color: active ? T.bg : T.textDim,
              cursor: "pointer",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function CompositionTooltip({ active, payload, label, valuesHidden }) {
  if (!active || !payload?.length) return null;
  const dateLabel = typeof label === "number"
    ? new Date(label).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : label;
  const total = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
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
      {payload
        .slice()
        .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0))
        .map((p) => {
          const pct = total > 0 ? (Number(p.value) || 0) / total * 100 : 0;
          return (
            <div key={p.dataKey} style={{ color: p.color, marginBottom: 2 }}>
              {p.name}: {valuesHidden ? "$ ••••" : fmtUSD(p.value)} ({pct.toFixed(1)}%)
            </div>
          );
        })}
    </div>
  );
}

// Custom paginated legend — the native recharts <Legend> doesn't paginate,
// and ~7 asset classes don't fit on one line on iPhone-width screens.
function CompositionLegend({ classList, colors, page, setPage, pageSize = 4 }) {
  if (!classList.length) return null;
  const totalPages = Math.max(1, Math.ceil(classList.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const start = clampedPage * pageSize;
  const pageItems = classList.slice(start, start + pageSize);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 10 }}>
      <button
        onClick={() => setPage((p) => Math.max(0, p - 1))}
        disabled={clampedPage === 0}
        style={{
          background: "transparent",
          border: "none",
          padding: 2,
          cursor: clampedPage === 0 ? "default" : "pointer",
          color: clampedPage === 0 ? T.textFaint : T.textDim,
          display: "flex",
        }}
      >
        <ChevronLeft size={14} />
      </button>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", minWidth: 0 }}>
        {pageItems.map((cls) => (
          <div key={cls} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: colors[cls] || T.textDim, flexShrink: 0 }} />
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim, whiteSpace: "nowrap" }}>{cls}</span>
          </div>
        ))}
      </div>
      <button
        onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
        disabled={clampedPage >= totalPages - 1}
        style={{
          background: "transparent",
          border: "none",
          padding: 2,
          cursor: clampedPage >= totalPages - 1 ? "default" : "pointer",
          color: clampedPage >= totalPages - 1 ? T.textFaint : T.textDim,
          display: "flex",
        }}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

// "Composition Evolution" card — stacked-area chart of asset-class weight
// over time, normalized to 100% (recharts stackOffset="expand"). Has its own
// independent Asset Class / Ticker filter (same FilterChip dropdown used by
// the Portfolio Performance & Net Worth card above), separate from that
// card's filter chips — hiding a class here removes it from the underlying
// data, so the stack renormalizes to 100% among whatever remains.
function CompositionCard({
  mergedComposition,
  mergedTickerComposition,
  valuesHidden,
  assetClassOptions,
  assetClassFilter,
  onCommitAssetClassFilter,
  tickerOptions,
  tickerFilter,
  onCommitTickerFilter,
  filtersActive,
  onClearFilters,
}) {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState("1Y");
  const [legendPage, setLegendPage] = useState(0);
  const [viewBy, setViewBy] = useState("class"); // "class" | "ticker"
  const [chartStyle, setChartStyle] = useState("area"); // "area" (0-100% expand) | "river" (streamgraph)

  // `mergedTickerComposition` reuses the same `{ dates, classValues }` shape
  // as `mergedComposition` (see PerformanceView) so `getCompositionWindow`
  // works unmodified for both — its keys are ticker symbols instead of asset
  // class names when viewBy === "ticker".
  const activeComposition = viewBy === "ticker" ? mergedTickerComposition : mergedComposition;

  const windowed = useMemo(
    () => getCompositionWindow(activeComposition, period),
    [activeComposition, period]
  );

  // Class mode keeps the fixed, hand-picked COMPOSITION_CLASS_ORDER; ticker
  // mode has no natural fixed order, so series are ranked by total
  // contribution over the visible window (largest band first).
  const classList = useMemo(() => {
    if (viewBy === "ticker") {
      return Object.keys(windowed.classValues)
        .filter((k) => (windowed.classValues[k] || []).some((v) => v > 0))
        .sort((a, b) => {
          const totalA = (windowed.classValues[a] || []).reduce((s, v) => s + v, 0);
          const totalB = (windowed.classValues[b] || []).reduce((s, v) => s + v, 0);
          return totalB - totalA;
        });
    }
    return COMPOSITION_CLASS_ORDER.filter((cls) => (windowed.classValues[cls] || []).some((v) => v > 0));
  }, [windowed, viewBy]);

  const seriesColors = useMemo(() => {
    if (viewBy !== "ticker") return COMPOSITION_COLORS;
    const map = {};
    classList.forEach((t, i) => { map[t] = TICKER_PALETTE[i % TICKER_PALETTE.length]; });
    return map;
  }, [viewBy, classList]);

  const chartRows = useMemo(() => {
    return windowed.dates.map((d, i) => {
      const row = { date: d, dateTs: new Date(d + "T00:00:00Z").getTime() };
      for (const cls of classList) {
        row[cls] = windowed.classValues[cls]?.[i] ?? 0;
      }
      return row;
    });
  }, [windowed, classList]);

  // Same calendar-boundary tick logic as the Portfolio Performance & Net
  // Worth chart above (computeXAxis) — evenly spaced regardless of how
  // transaction dates happen to cluster.
  const xAxis = useMemo(() => computeXAxis(chartRows, period), [chartRows, period]);

  const isEmpty = chartRows.length === 0;

  return (
    <div style={{ marginTop: 28 }}>
      <button
        onClick={() => setOpen((o) => !o)}
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
          <Layers size={14} strokeWidth={2} />
          Composition Evolution
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
            padding: 20,
            marginTop: -1,
          }}
        >
          {isEmpty ? (
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
              No transactions in eligible asset classes (excludes BRA Fixed Income, Cash and Unallocated BRL).
            </div>
          ) : (
            <>
              {/* Asset Class / Ticker filter chips — same dropdown component
                  used by the Portfolio Performance & Net Worth card above. */}
              {assetClassOptions.length > 0 && (
                <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <FilterChip
                    label="Asset Class"
                    options={assetClassOptions}
                    committed={assetClassFilter}
                    onCommit={onCommitAssetClassFilter}
                  />
                  <FilterChip
                    label="Ticker"
                    options={tickerOptions}
                    committed={tickerFilter}
                    onCommit={onCommitTickerFilter}
                  />
                  {filtersActive && (
                    <button
                      onClick={onClearFilters}
                      style={{
                        background: "transparent",
                        border: `1px solid ${T.border}`,
                        borderRadius: 4,
                        color: T.textDim,
                        fontFamily: FONT_MONO,
                        fontSize: 11,
                        padding: "5px 10px",
                        cursor: "pointer",
                      }}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              )}

              {/* Period pills (left, gold-fill — same style as the "Income
                  History" card's period selector in Dividends.jsx) + view
                  toggles (right): Class/Ticker grouping and Area/River
                  chart style. */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 16,
                  marginBottom: 20,
                }}
              >
                <div style={{ display: "flex", gap: 2 }}>
                  {COMPOSITION_PERIODS.map(({ label }) => {
                    const active = period === label;
                    return (
                      <button
                        key={label}
                        onClick={() => setPeriod(label)}
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          letterSpacing: "0.08em",
                          padding: "5px 12px",
                          border: `1px solid ${active ? T.gold : T.border}`,
                          borderRadius: 4,
                          background: active ? T.gold : T.cardElev,
                          color: active ? T.bg : T.textDim,
                          cursor: "pointer",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <SegmentedToggle
                    options={[{ value: "class", label: "Class" }, { value: "ticker", label: "Ticker" }]}
                    value={viewBy}
                    onChange={setViewBy}
                  />
                  <SegmentedToggle
                    options={[{ value: "area", label: "Area" }, { value: "river", label: "River" }]}
                    value={chartStyle}
                    onChange={setChartStyle}
                  />
                </div>
              </div>

              <div
                style={{
                  background: T.cardElev,
                  border: `1px solid ${T.borderSoft}`,
                  borderRadius: 4,
                  padding: "20px 8px 8px",
                }}
              >
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart
                    data={chartRows}
                    stackOffset={chartStyle === "river" ? "wiggle" : "expand"}
                    margin={{ top: 4, right: 20, left: 8, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={chartStyle !== "river"} />
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
                    <YAxis
                      hide={chartStyle === "river"}
                      domain={chartStyle === "river" ? ["dataMin", "dataMax"] : [0, 1]}
                      tickFormatter={(v) => `${Math.round(v * 100)}%`}
                      tick={{ fontFamily: FONT_MONO, fontSize: 10, fill: T.textFaint }}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                    />
                    <Tooltip content={(props) => <CompositionTooltip {...props} valuesHidden={valuesHidden} />} />
                    {classList.map((cls) => (
                      <Area
                        key={cls}
                        type="monotone"
                        dataKey={cls}
                        name={cls}
                        stackId="composition"
                        stroke={seriesColors[cls] || T.textDim}
                        fill={seriesColors[cls] || T.textDim}
                        fillOpacity={0.55}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
                <CompositionLegend
                  classList={classList}
                  colors={seriesColors}
                  page={legendPage}
                  setPage={setLegendPage}
                />
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
                Excludes BRA Fixed Income
              </div>
            </>
          )}
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
  const [showTotalReturn, setShowTotalReturn] = useState(false); // independent toggle, adds Total Return line/KPI
  const [transactions, setTransactions] = useState([]);
  const [transactionsLoaded, setTransactionsLoaded] = useState(false); // true once Effect A has resolved, even if txs=[]
  const [divByTicker, setDivByTicker] = useState({});
  const [divEvents, setDivEvents] = useState([]);
  const [perfCardOpen, setPerfCardOpen] = useState(true);
  const [posTableOpen, setPosTableOpen] = useState(false);
  const [assetClassFilter, setAssetClassFilter] = useState(() => new Set()); // include-filter, empty = all
  const [tickerFilter, setTickerFilter] = useState(() => new Set()); // include-filter, empty = all
  // Composition Evolution's own Asset Class/Ticker filter — independent of
  // assetClassFilter/tickerFilter above (that pair drives the TWR chart).
  const [compAssetClassFilter, setCompAssetClassFilter] = useState(() => new Set());
  const [compTickerFilter, setCompTickerFilter] = useState(() => new Set());
  // Raw per-ticker composition series for the FULL portfolio, fetched once
  // (Effect C below) and never re-fetched when the card's own Asset
  // Class/Ticker filter changes — that filter is applied client-side over
  // `tickerValues`, so toggling it is instant instead of waiting on a fresh
  // Twelve Data/brapi round-trip.
  const [compositionRaw, setCompositionRaw] = useState({ dates: [], tickerValues: {}, tickerClass: {} });

  // ── Effect A: raw, unfiltered load on auth change ──────────────────────────
  // Loads transactions + bond income + dividend events. These also feed the
  // Position Performance table below, which is out of scope for the new
  // asset-class/ticker filters and must never be filtered.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setError(null);
    setTransactions([]);
    setTransactionsLoaded(false);
    setRawData([]);
    setMeta(null);
    setDivEvents([]);
    setDivByTicker({});
    setAssetClassFilter(new Set());
    setTickerFilter(new Set());
    setCompAssetClassFilter(new Set());
    setCompTickerFilter(new Set());
    setCompositionRaw({ dates: [], tickerValues: {}, tickerClass: {} });

    (async () => {
      try {
        const { transactions: txs, bondIncome } = await loadTransactions(auth);
        if (cancelled) return;
        setTransactions(txs);
        setTransactionsLoaded(true);

        let divJson = null;
        try {
          const r = await fetch("/api/dividends", {
            method: "POST",
            headers: { ...authHeaders(auth), "Content-Type": "application/json" },
            body: JSON.stringify({ transactions: txs, bondIncome }),
          });
          if (r.ok) divJson = await r.json();
        } catch {}

        if (cancelled) return;

        const stockEvents = Array.isArray(divJson?.events) ? divJson.events : [];
        const { events: bondEventsArr } = buildBondEvents(txs, bondIncome);
        const allEvents = [...stockEvents, ...bondEventsArr];
        setDivEvents(allEvents);
        const todayMs = Date.now();
        const ttmCutoff = new Date(todayMs - 365 * 86400000).toISOString().slice(0, 10);
        const map = {};
        for (const e of allEvents) {
          if (!e.ticker || !e.date) continue;
          const t = e.ticker;
          if (!map[t]) map[t] = { ttm: 0, total: 0 };
          map[t].total += e.totalReceived;
          if (e.date >= ttmCutoff) map[t].ttm += e.totalReceived;
        }
        setDivByTicker(map);
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

  // Asset-class filter options: intersection of PERF_ELIGIBLE_CLASSES and the
  // classes actually present in the (unfiltered) transactions.
  const assetClassOptions = useMemo(() => {
    const present = new Set(transactions.map((tx) => tx.assetClass).filter(Boolean));
    return [...present].filter((c) => PERF_ELIGIBLE_CLASSES.has(c)).sort();
  }, [transactions]);

  // Ticker filter options: tickers present after applying the already-selected
  // asset-class filter (asset class filter narrows ticker options, not vice versa).
  const tickerOptions = useMemo(() => {
    const base = assetClassFilter.size === 0
      ? transactions
      : transactions.filter((tx) => assetClassFilter.has(tx.assetClass));
    return [...new Set(base.map((tx) => tx.ticker?.toUpperCase()).filter(Boolean))].sort();
  }, [transactions, assetClassFilter]);

  // Include-filter semantics: empty set = everything included.
  const filteredTransactions = useMemo(
    () => transactions.filter(
      (tx) =>
        (assetClassFilter.size === 0 || assetClassFilter.has(tx.assetClass)) &&
        (tickerFilter.size === 0 || tickerFilter.has(tx.ticker?.toUpperCase()))
    ),
    [transactions, assetClassFilter, tickerFilter]
  );

  const filteredDivEvents = useMemo(
    () => divEvents.filter(
      (e) =>
        (assetClassFilter.size === 0 || assetClassFilter.has(e.assetClass)) &&
        (tickerFilter.size === 0 || tickerFilter.has(e.ticker?.toUpperCase?.() ?? e.ticker))
    ),
    [divEvents, assetClassFilter, tickerFilter]
  );

  const filtersActive = assetClassFilter.size > 0 || tickerFilter.size > 0;

  // Committing a new Asset Class filter can orphan the current Ticker filter
  // (e.g. switch from "BRA Stocks" + ticker "BBSE3" to "Stocks" without
  // touching the ticker chip) — the AND-combined intersection would then be
  // permanently empty. Prune any tickers that no longer belong to the newly
  // selected asset classes at commit time.
  function commitAssetClassFilter(newSet) {
    setAssetClassFilter(newSet);
    setTickerFilter((prev) => {
      if (prev.size === 0) return prev;
      const allowed = new Set(
        transactions
          .filter((tx) => newSet.size === 0 || newSet.has(tx.assetClass))
          .map((tx) => tx.ticker?.toUpperCase())
          .filter(Boolean)
      );
      const pruned = new Set([...prev].filter((t) => allowed.has(t)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }

  function clearFilters() {
    setAssetClassFilter(new Set());
    setTickerFilter(new Set());
  }

  // Composition Evolution's own Asset Class/Ticker filter options — scoped to
  // COMPOSITION_CLASS_ORDER (excludes BRA Fixed Income, unlike the TWR
  // filter above which uses PERF_ELIGIBLE_CLASSES).
  const compAssetClassOptions = useMemo(() => {
    const present = new Set(transactions.map((tx) => tx.assetClass).filter(Boolean));
    return COMPOSITION_CLASS_ORDER.filter((c) => present.has(c));
  }, [transactions]);

  const compTickerOptions = useMemo(() => {
    const base = transactions.filter((tx) => COMPOSITION_CLASS_ORDER.includes(tx.assetClass));
    const scoped = compAssetClassFilter.size === 0
      ? base
      : base.filter((tx) => compAssetClassFilter.has(tx.assetClass));
    return [...new Set(scoped.map((tx) => tx.ticker?.toUpperCase()).filter(Boolean))].sort();
  }, [transactions, compAssetClassFilter]);

  const compFilteredTransactions = useMemo(
    () => transactions.filter(
      (tx) =>
        (compAssetClassFilter.size === 0 || compAssetClassFilter.has(tx.assetClass)) &&
        (compTickerFilter.size === 0 || compTickerFilter.has(tx.ticker?.toUpperCase()))
    ),
    [transactions, compAssetClassFilter, compTickerFilter]
  );

  const compFiltersActive = compAssetClassFilter.size > 0 || compTickerFilter.size > 0;

  function commitCompAssetClassFilter(newSet) {
    setCompAssetClassFilter(newSet);
    setCompTickerFilter((prev) => {
      if (prev.size === 0) return prev;
      const allowed = new Set(
        transactions
          .filter((tx) => newSet.size === 0 || newSet.has(tx.assetClass))
          .map((tx) => tx.ticker?.toUpperCase())
          .filter(Boolean)
      );
      const pruned = new Set([...prev].filter((t) => allowed.has(t)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }

  function clearCompFilters() {
    setCompAssetClassFilter(new Set());
    setCompTickerFilter(new Set());
  }

  // ── Effect B: refetch the perf-history chart whenever the filtered
  // transaction set changes. Waits for Effect A to finish resolving
  // `transactions` (tracked via `transactionsLoaded`, not `transactions.length`
  // — an account with zero eligible transactions must still be able to reach
  // "done" state with the server's `no-eligible-transactions` empty message,
  // instead of leaving the spinner stuck on "loading" forever).
  //
  // Deliberately does NOT depend on `compFilteredTransactions` — this drives
  // `state`, which gates the rendering of every card on the page (Portfolio
  // Performance & Net Worth, Position Performance, Composition Evolution).
  // Composition Evolution's own Asset Class/Ticker filter is handled by
  // Effect C below, which never touches `state`, so toggling it only updates
  // that card's chart instead of flashing "loading" and collapsing everything.
  useEffect(() => {
    if (!transactionsLoaded) return;
    let cancelled = false;
    setState("loading");
    setError(null);

    (async () => {
      try {
        const { dates, portfolio, portfolioUSD, spy, meta: respMeta } = await postPerfHistory(auth, {
          transactions: filteredTransactions,
        });

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
  }, [auth, transactionsLoaded, filteredTransactions]);

  // ── Effect C: fetches the Composition Evolution series ONCE per full
  // portfolio load (deps: `transactions`, not the card's own filter state).
  // The response carries per-ticker series (`tickerValues`/`tickerClass`),
  // and the card's Asset Class/Ticker filter is applied client-side over
  // that data (see `filteredComposition` below) — so toggling the filter
  // never triggers a network request, fixing the 1-2s lag from when this
  // used to refetch on every filter change.
  useEffect(() => {
    if (!transactionsLoaded) return;
    let cancelled = false;

    (async () => {
      try {
        const { composition: compResp } = await postPerfHistory(auth, {
          transactions: [],
          allTransactions: transactions,
        });
        if (cancelled) return;
        setCompositionRaw(
          compResp && Array.isArray(compResp.dates)
            ? compResp
            : { dates: [], tickerValues: {}, tickerClass: {} }
        );
      } catch {
        // Silent — Composition Evolution simply keeps its last good series;
        // the shared error UI is owned by Effect B.
      }
    })();

    return () => { cancelled = true; };
  }, [auth, transactionsLoaded, transactions]);

  const hasUSD = rawData.some((d) => d.usd != null);

  const { data: chartData, lastPortfolio, lastSpy, lastUSD, lastTotalReturn } = useMemo(
    () => getWindowData(rawData, period, filteredDivEvents),
    [rawData, period, filteredDivEvents]
  );

  // pctMode decides between the USD-value chart and the %-return chart.
  // Forced true when the cached response predates portfolioUSD (old cache).
  const pctMode = comparing || showTotalReturn || !hasUSD;

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
    const bankBondsSnapshot = computeBankBondsValueAt(transactions);
    const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const positions = {};
    for (const tx of sorted) {
      const ticker = tx.ticker?.toUpperCase();
      if (!ticker) continue;
      if (!positions[ticker]) positions[ticker] = { totalQty: 0, totalCost: 0, noFx: false, assetClass: null, lastBuyDate: null, lastBuyNotes: null };
      const pos = positions[ticker];
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

      const divData = divByTicker[ticker] ?? null;
      const divTtm = divData ? divData.ttm : null;
      const totalDiv = divData ? divData.total : null;

      if (assetClass === "Bank Bonds") {
        const bb = bankBondsSnapshot.byTicker[ticker];
        if (!bb) continue;
        const { avgCost, totalCost, totalValue } = bb;
        const totalGainLoss = totalValue - totalCost;
        const gainLossPct = totalCost > 0 ? (totalValue / totalCost - 1) * 100 : null;
        const yoc = divTtm != null && totalCost > 0 ? (divTtm / totalCost) * 100 : null;
        rows.push({ ticker, assetClass, qty: bb.qty, avgCost, currentPrice: null, totalCost, totalValue, totalGainLoss, gainLossPct, divTtm, totalDiv, yoc });
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
      const yoc = divTtm != null && totalCost > 0 ? (divTtm / totalCost) * 100 : null;
      rows.push({ ticker, assetClass, qty: pos.totalQty, avgCost, currentPrice, totalCost, totalValue, totalGainLoss, gainLossPct, divTtm, totalDiv, yoc });
    }
    return rows;
  }, [transactions, priceMap, divByTicker]);

  const xAxis = useMemo(() => computeXAxis(chartData, period), [chartData, period]);

  // Applies the Composition Evolution card's own Asset Class/Ticker filter
  // client-side: sums `tickerValues` (from Effect C, the full-portfolio
  // per-ticker series) into per-class totals, including only tickers that
  // pass the filter. Instant — no network request involved.
  const filteredComposition = useMemo(() => {
    const { dates, tickerValues, tickerClass } = compositionRaw;
    if (!dates?.length) return { dates: [], classValues: {} };
    const includedTickers = Object.keys(tickerClass).filter(
      (t) =>
        (compAssetClassFilter.size === 0 || compAssetClassFilter.has(tickerClass[t])) &&
        (compTickerFilter.size === 0 || compTickerFilter.has(t))
    );
    const classValues = {};
    for (const t of includedTickers) {
      const cls = tickerClass[t];
      const vals = tickerValues[t] || [];
      if (!classValues[cls]) classValues[cls] = dates.map(() => 0);
      classValues[cls] = classValues[cls].map((v, i) => v + (vals[i] || 0));
    }
    return { dates, classValues };
  }, [compositionRaw, compAssetClassFilter, compTickerFilter]);

  // Overlays a client-computed Bank Bonds value series (accrued-interest
  // projection, same helper used by Position Performance above) onto
  // filteredComposition — the backend's own "Bank Bonds" ticker values are
  // naturally all-zero since CUSIPs have no candle source.
  const mergedComposition = useMemo(() => {
    const dates = filteredComposition.dates || [];
    if (!dates.length) return { dates: [], classValues: {} };
    const classValues = { ...filteredComposition.classValues };
    if (compFilteredTransactions.some((tx) => tx.assetClass === "Bank Bonds")) {
      classValues["Bank Bonds"] = dates.map((d) => computeBankBondsValueAt(compFilteredTransactions, d).total);
    }
    return { dates, classValues };
  }, [filteredComposition, compFilteredTransactions]);

  // Same Asset Class/Ticker filter as `filteredComposition`, but kept at
  // per-ticker granularity (no aggregation) — feeds the Composition
  // Evolution card's "Ticker" view.
  const filteredTickerComposition = useMemo(() => {
    const { dates, tickerValues, tickerClass } = compositionRaw;
    if (!dates?.length) return { dates: [], tickerValues: {}, tickerClass: {} };
    const includedTickers = Object.keys(tickerClass).filter(
      (t) =>
        (compAssetClassFilter.size === 0 || compAssetClassFilter.has(tickerClass[t])) &&
        (compTickerFilter.size === 0 || compTickerFilter.has(t))
    );
    const outValues = {};
    const outClass = {};
    for (const t of includedTickers) {
      outValues[t] = tickerValues[t] || [];
      outClass[t] = tickerClass[t];
    }
    return { dates, tickerValues: outValues, tickerClass: outClass };
  }, [compositionRaw, compAssetClassFilter, compTickerFilter]);

  // Overlays client-computed Bank Bonds values per CUSIP (via
  // computeBankBondsValueAt's `byTicker` breakdown) onto the per-ticker
  // series — CUSIPs have no candle source so the backend reports them as 0.
  // Field is named `classValues` (not `tickerValues`) so it matches the
  // `{ dates, classValues }` shape `getCompositionWindow` expects — here the
  // keys happen to be ticker symbols instead of asset class names.
  const mergedTickerComposition = useMemo(() => {
    const dates = filteredTickerComposition.dates || [];
    if (!dates.length) return { dates: [], classValues: {} };
    const classValues = { ...filteredTickerComposition.tickerValues };
    const bbTickers = new Set(
      compFilteredTransactions
        .filter((tx) => tx.assetClass === "Bank Bonds")
        .map((tx) => tx.ticker?.toUpperCase())
        .filter(Boolean)
    );
    if (bbTickers.size) {
      const perDate = dates.map((d) => computeBankBondsValueAt(compFilteredTransactions, d).byTicker);
      for (const t of bbTickers) {
        classValues[t] = perDate.map((byTicker) => byTicker[t]?.totalValue ?? 0);
      }
    }
    return { dates, classValues };
  }, [filteredTickerComposition, compFilteredTransactions]);

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

  // When the asset-class or ticker filter is active, the Net Worth KPI should
  // reflect only the filtered positions (positionRows already carry ticker +
  // assetClass). PositionPerformanceTable itself stays unfiltered (out of scope).
  const filteredNetWorth = useMemo(() => {
    if (!filtersActive) return null;
    return positionRows
      .filter(
        (r) =>
          (assetClassFilter.size === 0 || assetClassFilter.has(r.assetClass)) &&
          (tickerFilter.size === 0 || tickerFilter.has(r.ticker))
      )
      .reduce((s, r) => s + r.totalValue, 0);
  }, [positionRows, assetClassFilter, tickerFilter, filtersActive]);

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

            {/* Asset Class / Ticker filter chips — own line, above the period
                selector. Rendered whenever there is anything to filter,
                regardless of whether the current filter combination happens
                to produce zero results, so a "Clear filters" affordance is
                always reachable and the user is never stuck staring at the
                empty state with no way to recover without switching tabs. */}
            {state === "done" && assetClassOptions.length > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 12,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <FilterChip
                  label="Asset Class"
                  options={assetClassOptions}
                  committed={assetClassFilter}
                  onCommit={commitAssetClassFilter}
                />
                <FilterChip
                  label="Ticker"
                  options={tickerOptions}
                  committed={tickerFilter}
                  onCommit={setTickerFilter}
                />
                {filtersActive && (
                  <button
                    onClick={clearFilters}
                    style={{
                      background: "transparent",
                      border: `1px solid ${T.border}`,
                      borderRadius: 4,
                      color: T.textDim,
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      letterSpacing: "0.04em",
                      padding: "5px 10px",
                      cursor: "pointer",
                    }}
                  >
                    Clear filters
                  </button>
                )}
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
                {filtersActive
                  ? "No transactions match the selected filters."
                  : meta?.reason === "no-eligible-transactions"
                  ? "No transactions in eligible asset classes (Stocks, BRA Stocks, Alternative, Real Estate, Bonds, Bank Bonds, BRA Fixed Income, Unallocated USD)."
                  : meta?.reason === "no-priced-days"
                  ? "Could not fetch enough historical price data to build a chart."
                  : "No performance data available."}
              </div>
            )}

            {state === "done" && rawData.length > 0 && (
              <>
                {/* Period selector + toggles */}
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
                            padding: "5px 12px",
                            border: `1px solid ${active ? T.gold : T.border}`,
                            borderRadius: 4,
                            background: active ? T.gold : T.cardElev,
                            color: active ? T.bg : T.textDim,
                            cursor: "pointer",
                            transition: "color 0.15s, background 0.15s, border-color 0.15s",
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => setShowTotalReturn((v) => !v)}
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 11,
                        letterSpacing: "0.08em",
                        padding: "5px 12px",
                        border: `1px solid ${showTotalReturn ? T.green + "66" : T.border}`,
                        borderRadius: 3,
                        background: showTotalReturn ? T.green + "18" : "transparent",
                        color: showTotalReturn ? T.green : T.textDim,
                        cursor: "pointer",
                        transition: "color 0.15s, background 0.15s, border-color 0.15s",
                      }}
                    >
                      {showTotalReturn ? "✓ Total Return" : "Show Total Return"}
                    </button>
                    <button
                      onClick={() => setComparing((c) => !c)}
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 11,
                        letterSpacing: "0.08em",
                        padding: "5px 12px",
                        border: `1px solid ${comparing ? T.orange + "66" : T.border}`,
                        borderRadius: 3,
                        background: comparing ? T.orange + "18" : "transparent",
                        color: comparing ? T.orange : T.textDim,
                        cursor: "pointer",
                        transition: "color 0.15s, background 0.15s, border-color 0.15s",
                      }}
                    >
                      {comparing ? "← Net Worth" : "Compare vs S&P 500"}
                    </button>
                  </div>
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
                    label={filtersActive ? "Net Worth (filtered)" : "Net Worth"}
                    value={valuesHidden ? "$ ••••" : fmtUSD(filtersActive ? filteredNetWorth : (liveNetWorth ?? lastUSD))}
                    color={T.text}
                  />
                  <KpiCard
                    label={`Portfolio ${period}`}
                    value={fmt(lastPortfolio)}
                    color={kpiColor(lastPortfolio)}
                  />
                  {showTotalReturn && (
                    <KpiCard
                      label={`Total Return ${period}`}
                      value={fmt(lastTotalReturn)}
                      color={kpiColor(lastTotalReturn)}
                    />
                  )}
                  {comparing && (
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
                    {chartTitle(pctMode, comparing, showTotalReturn)}
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
                      {pctMode ? (
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
                      {pctMode && (
                        <Legend
                          wrapperStyle={{
                            fontFamily: FONT_MONO,
                            fontSize: 11,
                            paddingTop: 8,
                            color: T.textDim,
                          }}
                        />
                      )}
                      {pctMode ? (
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
                          {showTotalReturn && (
                            <Line
                              type="monotone"
                              dataKey="totalReturn"
                              name="Total Return"
                              stroke={T.green}
                              strokeWidth={2}
                              dot={false}
                              activeDot={{ r: 4, fill: T.green }}
                            />
                          )}
                          {comparing && (
                            <Line
                              type="monotone"
                              dataKey="spy"
                              name="S&P 500"
                              stroke={T.orange}
                              strokeWidth={2}
                              dot={false}
                              activeDot={{ r: 4, fill: T.orange }}
                            />
                          )}
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
                  Excludes Cash and Unallocated BRL assets. Updated daily after US market close.
                  {" "}Total Return includes US dividends only (BRA and fixed income excluded).
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

      {/* Composition Evolution card */}
      {state === "done" && transactionsLoaded && (
        <CompositionCard
          mergedComposition={mergedComposition}
          mergedTickerComposition={mergedTickerComposition}
          valuesHidden={valuesHidden}
          assetClassOptions={compAssetClassOptions}
          assetClassFilter={compAssetClassFilter}
          onCommitAssetClassFilter={commitCompAssetClassFilter}
          tickerOptions={compTickerOptions}
          tickerFilter={compTickerFilter}
          onCommitTickerFilter={setCompTickerFilter}
          filtersActive={compFiltersActive}
          onClearFilters={clearCompFilters}
        />
      )}
    </div>
  );
}
