import { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { Plus, Trash2, RefreshCw, AlertCircle, TrendingUp, TrendingDown, Minus, Upload, Scale, CheckCircle2, ChevronDown, ChevronRight, Lock, LogOut, Search, ArrowUpDown, Download, Wallet, Pencil, X, Eye, EyeOff, Cloud, CloudOff, Bell, LayoutGrid } from "lucide-react";
import TransactionsView, { applySplitToTransactions, saveTransactionsToServer, noteTransactionsSavedAt } from "./Transactions.jsx";
import { applyBankBondsHolding, BANK_BONDS_ID, computeBankBondsMarketValue } from "./lib/bankBonds.js";
const PerformanceView = lazy(() => import("./Performance.jsx"));
// Lazy so recharts (used by the treemap) stays out of the main bundle.
const TreemapCard = lazy(() => import("./TreemapCard.jsx"));
const AporteQuinzenalView = lazy(() => import("./AporteQuinzenal.jsx"));
const DividendsView = lazy(() => import("./Dividends.jsx"));
const EventsView = lazy(() => import("./Events.jsx"));

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700;9..144,800&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');`;

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
  redBg: "rgba(232, 140, 140, 0.08)",
};

// Earth-tone palette for donut segments (dark theme friendly)
const DONUT_COLORS = [
  "#c9a961", // gold
  "#7898a9", // dusty blue
  "#c97a61", // terracotta
  "#8aa978", // sage
  "#a978a9", // mauve
  "#d4a04e", // amber
  "#6a98a0", // teal
  "#b88858", // copper
  "#9a9a6a", // olive
  "#b87878", // rose
  "#788a98", // slate
  "#6a8a6a", // forest
];
const UNALLOCATED_COLOR = "#3a3f48";

// Rebalance: per-asset purchase cap in dollars
const PER_ASSET_CAP = 1000;

// Permanent Cash account — cannot be deleted, only value and target editable
const CASH_ID = "cash-permanent";

// Alert log: how many entries to keep in storage vs. show in the panel.
const MAX_ALERT_LOG = 50;
const ALERT_DISPLAY_COUNT = 10;

function alertLogKey(auth) {
  if (!auth) return "alertLog:anon";
  if (auth.kind === "google" && auth.email) {
    return `alertLog:g:${auth.email}`;
  }
  if (auth.kind === "password" && auth.password) {
    return `alertLog:p:${auth.password.slice(0, 8)}`;
  }
  return "alertLog:anon";
}

function ensureCashAccount(list) {
  const arr = Array.isArray(list) ? list : [];
  const hasCash = arr.some((h) => h && h.id === CASH_ID);
  if (hasCash) return arr;
  return [
    ...arr,
    {
      id: CASH_ID,
      type: "manual",
      manualMode: "value",
      ticker: "CASH",
      name: "Cash Account",
      assetClass: "Cash",
      assetClassOverride: "Cash",
      qty: 0,
      price: 1,
      manualValue: 0,
      manualPrice: 1,
      target: 0,
    },
  ];
}

const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_BODY = "'Manrope', system-ui, sans-serif";
const FONT_MONO = "'JetBrains Mono', 'Geist Mono', monospace";

function fmtMoney(n, opts = {}) {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts.short ? 0 : 2,
    maximumFractionDigits: opts.short ? 0 : 2,
  }).format(n);
}

// Returns masked dollar string when hidden=true, formatted money otherwise.
function maskMoney(n, hidden, opts = {}) {
  if (hidden) return "$ ••••";
  return fmtMoney(n, opts);
}

function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(n);
}

function timeAgo(iso) {
  if (!iso) return "never";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Build auth headers based on whether we have a Google token or just a password.
function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

// Local (not UTC) "today" as YYYY-MM-DD — avoids off-by-one-day issues for
// users in negative UTC offsets (e.g. Brazil, UTC-3).
function localTodayISO(d = new Date()) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

async function fetchPrice(ticker, auth, quoteOnly = false) {
  const params = new URLSearchParams({ ticker });
  if (quoteOnly) params.set("quoteOnly", "1");
  const res = await fetch(`/api/price?${params.toString()}`, {
    headers: authHeaders(auth),
  });

  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }

  const parsed = await res.json();
  if (parsed.error) throw new Error(parsed.error);
  if (parsed.price == null) throw new Error("No price returned");
  return parsed;
}

// Triggers a SimpleFin sync (POST, admin-only server-side — a non-admin call
// just resolves with whatever's already staged rather than throwing, since
// fetch() doesn't throw on a 403) and reads back the freshest staged
// balanceCandidates + bondHoldings. Real upstream fetches are throttled to
// once per 6h server-side (api/fidelity-pending.js) — calls inside that
// window just return the current staging state. Used by refreshAll/the Bank
// Bonds "Refresh price" button so Cash/Bank Bonds current values track
// SimpleFin the same way ticker prices do (jul/2026).
async function syncFidelityAndFetchCandidates(auth) {
  try {
    await fetch("/api/fidelity-pending?resource=sync", {
      method: "POST",
      headers: authHeaders(auth),
    });
  } catch {
    // Network hiccup on the sync trigger — the GET below still returns
    // whatever was staged from the last successful sync, so don't bail.
  }
  const res = await fetch("/api/fidelity-pending", { headers: authHeaders(auth) });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) return { balanceCandidates: [], bondHoldings: [] };
  const data = await res.json().catch(() => ({}));
  return {
    balanceCandidates: Array.isArray(data.balanceCandidates) ? data.balanceCandidates : [],
    bondHoldings: Array.isArray(data.bondHoldings) ? data.bondHoldings : [],
  };
}

// Batch quote fetch: one API call resolves many tickers (server fans out with
// bounded concurrency + shared 60s Redis cache). Returns { TICKER: payload }
// where a failed ticker's payload is { error }.
async function fetchPricesBatch(tickers, auth, quoteOnly = false) {
  if (!tickers.length) return {};
  const params = new URLSearchParams({ tickers: tickers.join(",") });
  if (quoteOnly) params.set("quoteOnly", "1");
  const res = await fetch(`/api/price?${params.toString()}`, {
    headers: authHeaders(auth),
  });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const d = await res.json();
  return d.quotes && typeof d.quotes === "object" ? d.quotes : {};
}

// --- BRA Fixed Income (manual, entered in BRL) -----------------------------
// These holdings (e.g. Tesouro balances copied from Nubank) are entered as a
// total value in BRL; the app converts to USD using a live USD/BRL rate.
function isBraFixedIncome(h) {
  return (
    h.type === "manual" &&
    (h.assetClass || "").trim().toLowerCase() === "bra fixed income"
  );
}

// Fetch the current USD/BRL rate (how many BRL per 1 USD).
async function fetchUsdBrlRate(auth) {
  const res = await fetch("/api/price?fx=USDBRL", { headers: authHeaders(auth) });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (!res.ok) throw new Error(`FX ${res.status}`);
  const d = await res.json();
  const rate = d?.rate ?? d?.fxRate;
  if (!rate || rate <= 0) throw new Error("No FX rate");
  return rate;
}

async function fetchIndexQuote(symbol, auth) {
  const res = await fetch(`/api/index-quote?symbol=${encodeURIComponent(symbol)}`, {
    headers: authHeaders(auth),
  });
  if (!res.ok) throw new Error(`Index ${res.status}`);
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return d;
}

// Server-side holdings sync (Upstash Redis backend)

// Last savedAt read from / written to the server. Sent as expectedSavedAt on
// PUT so the server can reject the write (409) if another device saved in
// between — instead of silently overwriting it. Module-level: one account
// per session.
let holdingsServerSavedAt = null;

async function fetchHoldingsFromServer(auth) {
  const res = await fetch("/api/holdings", {
    headers: authHeaders(auth),
  });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (res.status === 503) {
    const err = new Error("Storage not configured");
    err.code = 503;
    throw err;
  }
  if (!res.ok) {
    let msg = `Storage ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  holdingsServerSavedAt = data.savedAt || null;
  return data;
}

// Cross-device sync for the Bell alert log's "read" state (item 128).
// Fetches the set of alert ids the user has marked as read on any device.
// Best-effort: returns an empty array on any failure so callers never block
// the UI or throw.
async function fetchAlertsReadFromServer(auth) {
  try {
    const res = await fetch("/api/contributions-history?resource=alerts-read", { headers: authHeaders(auth) });
    if (!res.ok) return [];
    const d = await res.json();
    return Array.isArray(d.readIds) ? d.readIds : [];
  } catch {
    return [];
  }
}

// Fire-and-forget PUT of newly-read alert ids. Never throws; silent on failure
// since this is just cross-device sync, not the source of truth for the UI.
function saveAlertsReadToServer(auth, ids) {
  if (!ids || !ids.length) return;
  fetch("/api/contributions-history?resource=alerts-read", {
    method: "PUT",
    headers: { ...authHeaders(auth), "Content-Type": "application/json" },
    body: JSON.stringify({ add: ids }),
  }).catch(() => {});
}

// Returns the transactions array (or null on failure). When `withMeta` is true,
// returns { transactions, splitEvents } instead so callers that need the split
// decision log can capture it from the same request.
async function fetchTransactionsForSync(auth, withMeta = false) {
  try {
    const res = await fetch("/api/transactions", { headers: authHeaders(auth) });
    if (!res.ok) return null;
    const d = await res.json();
    noteTransactionsSavedAt(d.savedAt);
    const transactions = d.exists && Array.isArray(d.transactions) ? d.transactions : [];
    if (withMeta) {
      return {
        transactions,
        splitEvents: Array.isArray(d.splitEvents) ? d.splitEvents : [],
        bondIncome: Array.isArray(d.bondIncome) ? d.bondIncome : [],
      };
    }
    return transactions;
  } catch {
    return null;
  }
}

// Fires once per session, ~3s after the initial data load: preloads the lazy
// tab chunks and warms the server-side caches behind the Performance and
// Dividends tabs by issuing the exact same POST bodies those tabs send on
// mount. The first tab visit then hits warm Redis caches instead of waiting
// on live candle / dividend-API fetches ("Fetching performance/dividends").
// The two perf-history calls run sequentially on purpose — the first warms
// the shared candle cache, so the composition call doesn't duplicate the
// same external fetches while both are cold.
let warmedUp = false;
function warmUpTabCaches(auth, transactions, bondIncome) {
  if (warmedUp || !Array.isArray(transactions) || transactions.length === 0) return;
  warmedUp = true;
  setTimeout(() => {
    import("./Performance.jsx").catch(() => {});
    import("./Dividends.jsx").catch(() => {});
    import("./Events.jsx").catch(() => {});
    const headers = { ...authHeaders(auth), "Content-Type": "application/json" };
    fetch("/api/perf-history", {
      method: "POST",
      headers,
      body: JSON.stringify({ transactions }),
    })
      .catch(() => {})
      .then(() =>
        fetch("/api/perf-history", {
          method: "POST",
          headers,
          body: JSON.stringify({ transactions: [], allTransactions: transactions }),
        }).catch(() => {})
      );
    fetch("/api/dividends", {
      method: "POST",
      headers,
      body: JSON.stringify({
        transactions,
        bondIncome: bondIncome || [],
        todayISO: localTodayISO(),
      }),
    }).catch(() => {});
  }, 3000);
}

function computeNetQty(transactions) {
  const net = {};
  for (const tx of transactions) {
    if (!tx.ticker || tx.qty == null) continue;
    const t = tx.ticker.toUpperCase();
    if (net[t] == null) net[t] = 0;
    if (tx.side === "buy") net[t] += Number(tx.qty);
    else if (tx.side === "sell") net[t] -= Number(tx.qty);
  }
  return net;
}

// --- Alert log helpers ----------------------------------------------------
// Group a newest-first alert list into date buckets, preserving order.
// Returns [{ date, items }] with the most recent date first.
function groupAlertsByDate(alerts) {
  const groups = [];
  const byDate = new Map();
  for (const a of alerts) {
    const d = a.sentDate || "—";
    if (!byDate.has(d)) {
      const bucket = { date: d, items: [] };
      byDate.set(d, bucket);
      groups.push(bucket);
    }
    byDate.get(d).items.push(a);
  }
  return groups;
}

// Human-friendly date header: "Today", "Yesterday", else "Mon D, YYYY".
function formatAlertDate(iso, todayISO) {
  if (!iso || iso === "—") return "Earlier";
  if (iso === todayISO) return "Today";
  const yesterday = new Date(new Date(todayISO + "T00:00:00Z").getTime() - 86400000)
    .toISOString()
    .slice(0, 10);
  if (iso === yesterday) return "Yesterday";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// --- Split detection helpers ----------------------------------------------
// US tickers eligible for split detection. Mirrors extractEligibleTickers in
// Events.jsx (duplicated inline to avoid coupling — same project convention).
const SPLIT_ELIGIBLE_CLASSES = new Set([
  "Stocks", "Real Estate", "Alternative", "Bonds", "BRA Stocks", "Unallocated USD",
]);

function extractEligibleSplitTickers(transactions) {
  const netQty = computeNetQty(transactions);
  const seen = new Set();
  for (const tx of transactions) {
    const t = (tx.ticker || "").toUpperCase();
    if (!t) continue;
    if (!SPLIT_ELIGIBLE_CLASSES.has(tx.assetClass)) continue;
    if (/^[A-Z]{4}\d{1,2}$/.test(t)) continue; // B3 / Brazilian
    if (/^[0-9A-Z]{9}$/.test(t)) continue; // CUSIP
    if (/^TESOURO-/i.test(t)) continue; // Tesouro
    if ((netQty[t] || 0) <= 0) continue;
    seen.add(t);
  }
  return [...seen].sort();
}

// Given the current transaction history, the splits detected by the API, and
// the decision log (splitEvents), return the splits that still need a decision
// and actually affect at least one un-adjusted transaction.
function detectPendingSplits(transactions, detectedSplits, splitEvents) {
  const decided = new Set(splitEvents.map((s) => `${s.ticker}|${s.date}|${s.numerator}|${s.denominator}`));
  const pending = [];
  for (const sp of detectedSplits) {
    const tkr = (sp.ticker || "").toUpperCase();
    const key = `${tkr}|${sp.date}|${sp.numerator}|${sp.denominator}`;
    if (decided.has(key)) continue;
    if (Number(sp.numerator) === Number(sp.denominator)) continue;
    const affected = transactions.filter((tx) =>
      (tx.ticker || "").toUpperCase() === tkr &&
      tx.date < sp.date &&
      !(tx.splitAdjusted && tx.splitDate === sp.date)
    );
    if (affected.length) pending.push({ ...sp, ticker: tkr, affectedCount: affected.length });
  }
  return pending;
}

// Returns true when a holding has zero value/qty and should be auto-hidden.
// Used by filteredHoldings to suppress zero-position holdings that have no
// target allocation set. Holdings with target > 0 are intentional placeholders
// and must remain visible regardless of qty/value.
function isZeroHolding(h) {
  if (h.type === "manual") {
    if (h.manualMode === "qty_price") return (h.qty ?? 0) === 0;
    return (h.manualValue ?? 0) === 0;
  }
  return (h.qty ?? 0) === 0;
}

// Returns patched holdings array if any qty changed, null otherwise.
// Updates ticker-backed (non-manual) holdings that have at least one transaction.
// Uses type !== "manual" — the app-wide convention — so legacy holdings
// that predate the type field (type === undefined) are correctly included.
function applyTxQty(holdings, netQty) {
  let changed = false;
  const updated = holdings.map((h) => {
    if (h.type === "manual" || !(h.ticker in netQty)) return h;
    const computed = Math.max(0, netQty[h.ticker]);
    if (h.qty === computed) return h;
    changed = true;
    return { ...h, qty: computed };
  });
  return changed ? updated : null;
}

// Permanent aggregated "US Bank Bonds" holding (item 37). One manual holding
// whose value/cost/reconciliation logic (applyBankBondsHolding, BANK_BONDS_ID)
// now lives in ./lib/bankBonds.js (bugfix aug/2026 - moved so it shares the
// exact same per-bond current-value resolution Performance.jsx's Position
// Performance uses, instead of a separately-implemented flat SimpleFin sum
// that could silently drop bonds SimpleFin didn't report), imported at the
// top of this file.

async function saveHoldingsToServer(auth, holdings) {
  const res = await fetch("/api/holdings", {
    method: "PUT",
    headers: {
      ...authHeaders(auth),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ holdings, expectedSavedAt: holdingsServerSavedAt }),
  });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (res.status === 409) {
    // Another device saved after we last read. Keep our stale marker so
    // further saves also fail — reloading the app is the way to resync.
    const err = new Error(
      "Holdings changed on another device. Reload the app to sync."
    );
    err.code = 409;
    throw err;
  }
  if (!res.ok) {
    let msg = `Save ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  holdingsServerSavedAt = data.savedAt || null;
  return data;
}

// Admin-only: list/invite/remove users from the allowlist.
async function fetchUsersList(auth) {
  const res = await fetch("/api/users", {
    headers: authHeaders(auth),
  });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (res.status === 403) {
    const err = new Error("Admin only");
    err.code = 403;
    throw err;
  }
  if (!res.ok) {
    let msg = `Users ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

async function inviteUser(auth, email) {
  const res = await fetch("/api/users", {
    method: "POST",
    headers: {
      ...authHeaders(auth),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    let msg = `Invite ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

async function removeUser(auth, email) {
  const res = await fetch("/api/users", {
    method: "DELETE",
    headers: {
      ...authHeaders(auth),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    let msg = `Remove ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

// Read admin emails from the meta tag (set via Vite from VITE_ADMIN_EMAILS).
function getAdminEmails() {
  if (typeof window === "undefined") return [];
  const meta = document.querySelector('meta[name="admin-emails"]');
  const raw = meta?.content || "";
  if (!raw || raw.includes("%")) return []; // Vite placeholder not replaced
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isUserAdmin(auth) {
  if (!auth || auth.kind !== "google" || !auth.email) return false;
  const admins = getAdminEmails();
  return admins.includes(auth.email.toLowerCase());
}

// How long client-side profile info is considered fresh (avoid asking the server for name/class on every refresh).
const PROFILE_REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const ASSET_CLASS_OPTIONS = [
  "Alternative",
  "BRA Fixed Income",
  "Bank Bonds",
  "Bonds",
  "Real Estate",
  "Stocks",
  "BRA Stocks",
  "Unallocated BRL",
  "Unallocated USD",
];

function parseAllocationCSV(text) {
  if (!text || !text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const delim = (() => {
    const first = lines.find((l) => l.trim());
    if (!first) return ",";
    if (first.includes("\t")) return "\t";
    if (first.includes(";")) return ";";
    return ",";
  })();
  const rows = [];
  const seenTickers = new Set();
  let startIdx = 0;
  const firstLine = lines[0] ? lines[0].toLowerCase() : "";
  if (firstLine.includes("ticker") || firstLine.includes("symbol") || firstLine.includes("ativo")) {
    startIdx = 1;
  }
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(delim);
    if (parts.length < 2) continue;
    const ticker = (parts[0] || "").trim().toUpperCase();
    if (!ticker) continue;
    const rawPct = (parts[1] || "").trim().replace(/[%\s]/g, "");
    const targetPct = parseFloat(rawPct);
    let error = null;
    if (isNaN(targetPct) || targetPct < 0 || targetPct > 100) {
      error = "invalid_target";
    } else if (seenTickers.has(ticker)) {
      error = "duplicate";
    }
    if (error !== "invalid_target") seenTickers.add(ticker);
    rows.push({ ticker, targetPct: error ? null : targetPct, error });
  }
  return rows;
}

function classifyCSVRows(rows, holdings, transactions) {
  return rows.map((row) => {
    if (row.error) {
      return {
        ...row,
        action: "error",
        existingHolding: null,
        txAssetClass: null,
        chosenAssetClass: "",
        apiStatus: null,
      };
    }
    const tickerUp = row.ticker.toUpperCase();
    const found = holdings.find(
      (h) => (h.ticker || "").toUpperCase() === tickerUp
    );
    if (found) {
      return {
        ...row,
        action: "update_target",
        existingHolding: found,
        txAssetClass: null,
        chosenAssetClass: found.assetClass || "",
        apiStatus: null,
      };
    }
    const txMatch = transactions
      .slice()
      .reverse()
      .find((tx) => (tx.ticker || "").toUpperCase() === tickerUp);
    if (txMatch) {
      return {
        ...row,
        action: "create_from_tx",
        existingHolding: null,
        txAssetClass: txMatch.assetClass || "Stocks",
        chosenAssetClass: txMatch.assetClass || "Stocks",
        apiStatus: null,
      };
    }
    return {
      ...row,
      action: "create_new",
      existingHolding: null,
      txAssetClass: null,
      chosenAssetClass: "",
      apiStatus: null,
    };
  });
}

function shouldSkipValidationCSV(ticker, assetClass) {
  if (!ticker) return true;
  if (/^tesouro-/i.test(ticker)) return true;
  if (assetClass === "BRA Fixed Income") return true;
  if (assetClass === "Bank Bonds") return true;
  if (/^[0-9A-Z]{9}[0-9]$/.test(ticker)) return true;
  return false;
}

async function validateTickerForCSV(ticker, assetClass, auth) {
  if (shouldSkipValidationCSV(ticker, assetClass)) return "skipped";
  try {
    const res = await fetch(`/api/price?ticker=${encodeURIComponent(ticker)}`, {
      headers: authHeaders(auth),
    });
    return res.ok ? "valid" : "invalid";
  } catch {
    return "skipped";
  }
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

function AllocationCSVImportModal({ auth, holdings, transactions, onClose, onApply }) {
  const TM = {
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
  const FM_BODY = "'Manrope', system-ui, sans-serif";
  const FM_MONO = "'JetBrains Mono', 'Geist Mono', monospace";

  const [step, setStep] = useState("upload");
  const [csvText, setCsvText] = useState("");
  const [rows, setRows] = useState([]);
  const [parseError, setParseError] = useState("");
  const fileRef = useRef(null);

  function handlePreview() {
    setParseError("");
    const parsed = parseAllocationCSV(csvText);
    if (!parsed.length) {
      setParseError("No rows found. Check your CSV format.");
      return;
    }
    const validCount = parsed.filter((r) => !r.error).length;
    if (validCount === 0) {
      setParseError("All rows have errors. Fix targets (must be 0-100) and duplicates.");
      return;
    }
    const classified = classifyCSVRows(parsed, holdings, transactions);
    setRows(classified);
    setStep("preview");
  }

  function handleFileUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setCsvText(ev.target.result || "");
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  useEffect(() => {
    if (step !== "preview") return;
    rows.forEach((row, idx) => {
      if (row.action !== "create_new") return;
      if (row.apiStatus !== null) return;
      setRows((prev) =>
        prev.map((r, i) => (i === idx ? { ...r, apiStatus: "pending" } : r))
      );
      validateTickerForCSV(row.ticker, row.chosenAssetClass, auth).then((status) => {
        setRows((prev) =>
          prev.map((r, i) => (i === idx ? { ...r, apiStatus: status } : r))
        );
      });
    });
  }, [step]);

  const validCount = rows.filter((r) => r.action !== "error").length;
  const applyBlocked = rows.some(
    (r) =>
      r.action === "create_new" &&
      (r.apiStatus === null ||
        r.apiStatus === "pending" ||
        r.apiStatus === "invalid" ||
        !r.chosenAssetClass)
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: TM.card,
          border: `1px solid ${TM.border}`,
          borderRadius: 12,
          padding: 24,
          maxWidth: 680,
          width: "90%",
          maxHeight: "80vh",
          overflowY: "auto",
          fontFamily: FM_BODY,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 20,
          }}
        >
          <div
            style={{
              fontFamily: FM_MONO,
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: TM.gold,
            }}
          >
            {step === "upload" ? "Import Allocation CSV" : `Review ${validCount} change${validCount !== 1 ? "s" : ""}`}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: TM.textDim,
              cursor: "pointer",
              padding: 4,
              display: "flex",
              alignItems: "center",
            }}
          >
            <X size={16} />
          </button>
        </div>

        {step === "upload" && (
          <div>
            <div
              style={{
                fontSize: 12,
                color: TM.textDim,
                fontFamily: FM_MONO,
                marginBottom: 10,
              }}
            >
              Paste CSV or upload a file. Format: ticker, target %
            </div>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder={"Paste CSV here (ticker, target %)\nAAPL, 10\nMSFT, 15"}
              rows={8}
              style={{
                width: "100%",
                background: TM.cardElev,
                border: `1px solid ${TM.border}`,
                color: TM.text,
                padding: 10,
                fontSize: 12,
                fontFamily: FM_MONO,
                borderRadius: 6,
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            {parseError && (
              <div
                style={{
                  color: TM.red,
                  fontSize: 12,
                  fontFamily: FM_MONO,
                  marginTop: 8,
                }}
              >
                {parseError}
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 12,
              }}
            >
              <button
                onClick={() => fileRef.current && fileRef.current.click()}
                style={{
                  background: TM.cardElev,
                  border: `1px solid ${TM.border}`,
                  color: TM.textDim,
                  padding: "8px 14px",
                  fontSize: 11,
                  fontFamily: FM_MONO,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Upload file
              </button>
              <input
                type="file"
                accept=".csv,.txt"
                ref={fileRef}
                onChange={handleFileUpload}
                style={{ display: "none" }}
              />
              <button
                onClick={handlePreview}
                disabled={!csvText.trim()}
                style={{
                  background: TM.gold,
                  border: "none",
                  color: TM.bg,
                  padding: "8px 18px",
                  fontSize: 11,
                  fontFamily: FM_MONO,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Preview
              </button>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div>
            <ScrollHintTable>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontFamily: FM_MONO,
                  fontSize: 12,
                  minWidth: 520,
                }}
              >
                <thead>
                  <tr>
                    {["Ticker", "Target %", "Action", "Asset Class", "API"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "8px 12px",
                          borderBottom: `1px solid ${TM.border}`,
                          fontSize: 10,
                          letterSpacing: "0.12em",
                          textTransform: "uppercase",
                          color: TM.textFaint,
                          fontWeight: 600,
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const actionLabels = {
                      update_target: "Update target",
                      create_from_tx: "From transactions",
                      create_new: "New holding",
                      error: row.error === "duplicate" ? "Duplicate" : "Invalid target",
                    };
                    const actionColors = {
                      update_target: { bg: "#2a1f00", border: "#b8860b", text: "#f0c040" },
                      create_from_tx: { bg: "#001a2e", border: "#1a6b9a", text: "#60c0f0" },
                      create_new: { bg: "#001a0a", border: "#2a6b3a", text: "#60d090" },
                      error: { bg: "#2e0000", border: "#8b1a1a", text: "#e88c8c" },
                    };
                    const ac = actionColors[row.action] || actionColors.error;
                    return (
                      <tr key={idx} style={{ opacity: row.action === "error" ? 0.6 : 1 }}>
                        <td style={{ padding: "8px 12px", borderBottom: `1px solid ${TM.borderSoft}`, fontFamily: FM_MONO, fontWeight: 600, color: TM.text }}>
                          {row.ticker}
                        </td>
                        <td style={{ padding: "8px 12px", borderBottom: `1px solid ${TM.borderSoft}`, color: TM.textDim }}>
                          {row.targetPct != null ? `${row.targetPct}%` : "—"}
                        </td>
                        <td style={{ padding: "8px 12px", borderBottom: `1px solid ${TM.borderSoft}` }}>
                          <span
                            style={{
                              background: ac.bg,
                              border: `1px solid ${ac.border}`,
                              color: ac.text,
                              padding: "2px 7px",
                              borderRadius: 3,
                              fontSize: 10,
                              letterSpacing: "0.06em",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {actionLabels[row.action]}
                          </span>
                        </td>
                        <td style={{ padding: "8px 12px", borderBottom: `1px solid ${TM.borderSoft}`, color: TM.textDim }}>
                          {row.action === "update_target" && (
                            <span style={{ color: TM.gold, fontSize: 11 }}>{row.chosenAssetClass || "—"}</span>
                          )}
                          {row.action === "create_from_tx" && (
                            <span style={{ color: TM.textDim, fontSize: 11 }}>{row.txAssetClass || "—"}</span>
                          )}
                          {row.action === "create_new" && (
                            <select
                              value={row.chosenAssetClass}
                              onChange={(e) => {
                                const cls = e.target.value;
                                setRows((prev) =>
                                  prev.map((r, i) =>
                                    i === idx
                                      ? { ...r, chosenAssetClass: cls, apiStatus: null }
                                      : r
                                  )
                                );
                                if (cls) {
                                  validateTickerForCSV(row.ticker, cls, auth).then((status) => {
                                    setRows((prev) =>
                                      prev.map((r, i) =>
                                        i === idx ? { ...r, apiStatus: status } : r
                                      )
                                    );
                                  });
                                }
                              }}
                              style={{
                                background: TM.cardElev,
                                border: `1px solid ${TM.border}`,
                                color: row.chosenAssetClass ? TM.text : TM.textFaint,
                                padding: "3px 6px",
                                fontSize: 11,
                                fontFamily: FM_MONO,
                                borderRadius: 3,
                              }}
                            >
                              <option value="">Select class...</option>
                              {ASSET_CLASS_OPTIONS.filter((c) => c !== "Bank Bonds").map((c) => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
                          )}
                          {row.action === "error" && (
                            <span style={{ color: TM.textFaint }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 12px", borderBottom: `1px solid ${TM.borderSoft}` }}>
                          {row.action === "create_new" ? (
                            row.apiStatus === null || row.apiStatus === "pending" ? (
                              <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>
                                <circle cx="7" cy="7" r="5" fill="none" stroke={TM.textFaint} strokeWidth="2" strokeDasharray="20 10" />
                              </svg>
                            ) : row.apiStatus === "valid" ? (
                              <span style={{ color: TM.green, fontWeight: 700 }}>✓</span>
                            ) : row.apiStatus === "invalid" ? (
                              <span style={{ color: TM.red, fontSize: 11 }}>✗ Not found</span>
                            ) : (
                              <span style={{ color: TM.textFaint }}>—</span>
                            )
                          ) : (
                            <span style={{ color: TM.textFaint }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollHintTable>
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 20,
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => setStep("upload")}
                style={{
                  background: TM.cardElev,
                  border: `1px solid ${TM.border}`,
                  color: TM.textDim,
                  padding: "8px 16px",
                  fontSize: 11,
                  fontFamily: FM_MONO,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                onClick={() => onApply(rows)}
                disabled={applyBlocked}
                style={{
                  background: applyBlocked ? TM.cardElev : TM.gold,
                  border: `1px solid ${applyBlocked ? TM.border : TM.gold}`,
                  color: applyBlocked ? TM.textFaint : TM.bg,
                  padding: "8px 18px",
                  fontSize: 11,
                  fontFamily: FM_MONO,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  borderRadius: 4,
                  cursor: applyBlocked ? "not-allowed" : "pointer",
                  fontWeight: 600,
                  opacity: applyBlocked ? 0.6 : 1,
                }}
              >
                Apply {validCount} change{validCount !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  // Auth state can be either Google or password.
  //   { kind: 'google', googleToken, email, name, picture }
  //   { kind: 'password', password }
  // Persisted in localStorage so user stays logged in.
  const [auth, setAuth] = useState(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem("auth");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.kind) return parsed;
      }
      // Backwards compat: old "app_password" → migrate to new shape
      const legacyPw = localStorage.getItem("app_password");
      if (legacyPw) return { kind: "password", password: legacyPw };
    } catch (e) {}
    return null;
  });

  function handleGoogleLogin(googleToken, claims) {
    const next = {
      kind: "google",
      googleToken,
      email: claims.email,
      name: claims.name,
      picture: claims.picture,
    };
    localStorage.setItem("auth", JSON.stringify(next));
    localStorage.removeItem("app_password");
    setAuth(next);
  }

  function handlePasswordLogin(pw) {
    const next = { kind: "password", password: pw };
    localStorage.setItem("auth", JSON.stringify(next));
    localStorage.removeItem("app_password");
    setAuth(next);
  }

  function handleLogout() {
    localStorage.removeItem("auth");
    localStorage.removeItem("app_password");
    setAuth(null);
  }

  if (!auth) {
    return <LoginGate onGoogleAuth={handleGoogleLogin} onPasswordAuth={handlePasswordLogin} />;
  }

  return (
    <PortfolioTracker
      auth={auth}
      onLogout={handleLogout}
      onAuthFail={handleLogout}
    />
  );
}

function PortfolioTracker({ auth, onLogout, onAuthFail }) {
  // View switcher (Dashboard | Transactions). Lazy-loaded.
  const [activeView, setActiveView] = useState("dashboard");

  const [holdings, setHoldings] = useState(() => ensureCashAccount([]));
  const [loaded, setLoaded] = useState(false);
  const [busyIds, setBusyIds] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  // Live USD/BRL rate (BRL per 1 USD), cached locally for offline/first paint.
  const [usdBrlRate, setUsdBrlRate] = useState(() => {
    const v = parseFloat(localStorage.getItem("usdBrlRate"));
    return isFinite(v) && v > 0 ? v : null;
  });
  const [showRebalance, setShowRebalance] = useState(false);
  const [showTreemap, setShowTreemap] = useState(false);
  const [newCash, setNewCash] = useState("");
  const importJsonRef = useRef(null);

  // Split detection/approval (Bell in header). `transactions` mirrors the log so
  // the approve/dismiss handlers can adjust history; `splitEvents` is the
  // persisted decision log (applied/dismissed); `pendingSplits` are detected
  // splits not yet reflected in the history nor decided on.
  const [transactions, setTransactions] = useState([]);
  const [splitEvents, setSplitEvents] = useState([]);
  const [pendingSplits, setPendingSplits] = useState([]);
  const [alertPanelOpen, setAlertPanelOpen] = useState(false);
  const [splitActionInFlight, setSplitActionInFlight] = useState(null); // key of split being processed
  // Rolling log of dividend/earnings/bond-maturity alerts, bundled by the date
  // each was first detected ("sentDate"). Persisted in localStorage; read state
  // and last-10 display are derived from it.
  const [alertLog, setAlertLog] = useState(() => {
    const key = alertLogKey(auth);
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
      // One-time migration from legacy unscoped key
      const legacy = localStorage.getItem("alertLog");
      if (legacy) {
        const parsed = JSON.parse(legacy);
        localStorage.setItem(key, legacy);
        localStorage.removeItem("alertLog");
        return parsed;
      }
    } catch {}
    return [];
  });
  // Alert ids the server says are already read on some other device. Populated
  // once by the load effect (fetchAlertsReadFromServer) and consulted by
  // mergeAlerts so a newly-detected alert that was already read elsewhere
  // doesn't show up as unread on this device.
  const serverReadIdsRef = useRef(new Set());

  const [showCSVImport, setShowCSVImport] = useState(false);
  const [csvImportRows, setCsvImportRows] = useState([]);
  const [csvImportStep, setCsvImportStep] = useState("upload");

  // Manual asset form state
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualMode, setManualMode] = useState("value"); // "value" | "qty_price"
  const [manualValueInput, setManualValueInput] = useState("");
  const [manualQty, setManualQty] = useState("");
  const [manualPriceInput, setManualPriceInput] = useState("");
  const [manualTarget, setManualTarget] = useState("");
  const [manualClass, setManualClass] = useState("");
  const [manualCurrency, setManualCurrency] = useState("USD"); // USD | BRL (BRA Fixed Income)
  const [manualFormError, setManualFormError] = useState("");

  // Filter/sort state
  const [filterText, setFilterText] = useState("");
  const [filterClass, setFilterClass] = useState("");
  const [sortBy, setSortBy] = useState("gap_desc"); // gap_desc (default) | gap | value_desc | value | name | name_desc | default

  // Edit asset class state
  const [editingClassId, setEditingClassId] = useState(null);
  const [editingClassValue, setEditingClassValue] = useState("");

  // Allocation chart grouping mode
  const [chartGrouping, setChartGrouping] = useState("class"); // "class" | "holding"

  // Responsive window width for scaling donuts
  const [windowWidth, setWindowWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 375));
  useEffect(() => {
    function handleResize() {
      setWindowWidth(window.innerWidth);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Collapsed states for tracked and manual sub-sections (default to collapsed for cleaner first view)
  // Collapsed states for the unified holdings section and the separate cash section.
  // Default collapsed for cleaner first view.
  const [trackedCollapsed, setTrackedCollapsed] = useState(true);
  const [cashCollapsed, setCashCollapsed] = useState(true);

  // Toast for background refresh status
  const [toast, setToast] = useState(null); // { kind: 'info'|'success'|'error', message: string }

  // Modal alert (blocks until user dismisses with OK)
  const [alertModal, setAlertModal] = useState(null); // { title, message, kind } | null

  // S&P 500 benchmark (via SPY)
  const [sp500, setSp500] = useState(null); // { price, previousClose, dayChangePct } | null
  const [sp500Loading, setSp500Loading] = useState(false);

  // Manage Users (admin only)
  const isAdmin = useMemo(() => isUserAdmin(auth), [auth]);
  const [usersOpen, setUsersOpen] = useState(false);
  const [usersList, setUsersList] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);

  async function loadUsers() {
    setUsersLoading(true);
    setUsersError("");
    try {
      const data = await fetchUsersList(auth);
      setUsersList(Array.isArray(data.users) ? data.users : []);
    } catch (e) {
      if (e.code === 401) {
        onAuthFail();
        return;
      }
      setUsersError(e.message || "Failed to load users");
    } finally {
      setUsersLoading(false);
    }
  }

  async function handleInvite() {
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    setInviteBusy(true);
    setUsersError("");
    try {
      await inviteUser(auth, email);
      setInviteEmail("");
      await loadUsers();
    } catch (e) {
      setUsersError(e.message || "Invite failed");
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRemoveUser(email) {
    const ok = window.confirm(
      `Remove ${email}? Their portfolio data will also be deleted.`
    );
    if (!ok) return;
    setUsersError("");
    try {
      await removeUser(auth, email);
      await loadUsers();
    } catch (e) {
      setUsersError(e.message || "Remove failed");
    }
  }

  // Load the user list the first time the admin opens the section.
  useEffect(() => {
    if (isAdmin && usersOpen && usersList.length === 0 && !usersLoading) {
      loadUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, usersOpen]);

  async function refreshSp500() {
    setSp500Loading(true);
    try {
      const d = await fetchIndexQuote("SPY", auth);
      setSp500(d);
    } catch (e) {
      // Silent fail; SP500 is just a reference
    } finally {
      setSp500Loading(false);
    }
  }

  // Fetch S&P 500 on mount and any time the user manually refreshes
  useEffect(() => {
    refreshSp500();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-dismiss toast after a few seconds (info toasts persist while refreshing)
  useEffect(() => {
    if (!toast) return;
    if (toast.kind === "info") return; // info toast stays until refreshAll replaces it
    const timeout = toast.kind === "error" ? 6000 : 3500;
    const t = setTimeout(() => setToast(null), timeout);
    return () => clearTimeout(t);
  }, [toast]);

  // Privacy mode: hide $ amounts (for showing the app to others)
  const [valuesHidden, setValuesHidden] = useState(() => {
    try {
      return localStorage.getItem("values_hidden") === "1";
    } catch (e) {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("values_hidden", valuesHidden ? "1" : "0");
    } catch (e) {}
  }, [valuesHidden]);
  // Persist the alert log so read state and bundling survive reloads.
  useEffect(() => {
    try {
      localStorage.setItem(alertLogKey(auth), JSON.stringify(alertLog));
    } catch (e) {}
  }, [alertLog, auth]);

  // Sync state: tracks server-side persistence health.
  // "loading" while initial load; "synced" when up-to-date; "saving" mid-write;
  // "offline" if server unreachable (using local cache); "local-only" if Redis not configured.
  const [syncState, setSyncState] = useState("loading");
  const [lastSavedAt, setLastSavedAt] = useState(null);

  // Load holdings: try server first, fall back to localStorage cache.
  // First-time migration: if server has nothing but localStorage has data, push it up.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Always read local cache immediately so the UI has something to render
      let localData = null;
      try {
        const raw = localStorage.getItem("holdings");
        if (raw) localData = JSON.parse(raw);
      } catch (e) {}

      try {
        const result = await fetchHoldingsFromServer(auth);
        if (cancelled) return;

        let loadedHoldings;
        if (result.exists && Array.isArray(result.holdings)) {
          // Server has data → use it
          loadedHoldings = ensureCashAccount(result.holdings);
          setSyncState("synced");
        } else if (localData && Array.isArray(localData) && localData.length > 0) {
          // Server empty but local has data → migrate up
          loadedHoldings = ensureCashAccount(localData);
          try {
            const saveResult = await saveHoldingsToServer(auth, loadedHoldings);
            if (!cancelled) {
              setLastSavedAt(saveResult.savedAt);
              setSyncState("synced");
            }
          } catch (e) {
            if (!cancelled) setSyncState("offline");
          }
        } else {
          // Both empty → fresh start, but cash always present
          loadedHoldings = ensureCashAccount([]);
          setSyncState("synced");
        }

        // Sync qty of auto holdings from the transactions log
        const txMeta = await fetchTransactionsForSync(auth, true);
        const txs = txMeta ? txMeta.transactions : null;
        const loadedSplitEvents = txMeta ? txMeta.splitEvents : [];
        const loadedBondIncome = txMeta ? txMeta.bondIncome : [];
        if (!cancelled && txs) {
          setTransactions(txs);
          setSplitEvents(loadedSplitEvents);
          // Non-blocking: surface any unreflected splits via the Bell badge.
          refreshPendingSplits(txs, loadedSplitEvents);
          // Cross-device "read" sync: fetch which alert ids were marked read
          // on any device, stash them for mergeAlerts, and overlay them onto
          // the alert log already loaded from localStorage so a device that
          // was marked read elsewhere shows up as read here too.
          fetchAlertsReadFromServer(auth).then((readIds) => {
            if (cancelled || !readIds.length) return;
            const readSet = new Set(readIds);
            serverReadIdsRef.current = readSet;
            setAlertLog((prev) =>
              prev.map((a) => (!a.read && readSet.has(a.id) ? { ...a, read: true } : a))
            );
          });
          refreshAlerts(txs, loadedBondIncome);
          // SimpleFin/Fidelity feed heartbeat (Fase 3) — admin-only, same
          // fire-and-forget spot as the other alert refreshers above.
          if (isAdmin) refreshSimplefinHeartbeat();
          // Warm the tabs the user visits next: preload the lazy JS chunks
          // and fire the exact POSTs Performance/Dividends will make, so the
          // server-side Redis caches (candles, dividends, composition) are
          // hot before the first tab switch. Delayed so it never competes
          // with the initial quote fetches for bandwidth.
          warmUpTabCaches(auth, txs, loadedBondIncome);
          let didChange = false;
          const patched = applyTxQty(loadedHoldings, computeNetQty(txs));
          if (patched) {
            loadedHoldings = patched;
            didChange = true;
          }
          // Item 37: sync the aggregated "US Bank Bonds" manual holding value
          // (current value + cost basis, both derived from the transaction
          // log via lib/bankBonds.js - same resolution Position Performance
          // uses).
          const hasBankBondTx = txs.some((t) => t && t.assetClass === "Bank Bonds");
          const bbPatched = applyBankBondsHolding(loadedHoldings, txs, hasBankBondTx);
          if (bbPatched) {
            loadedHoldings = bbPatched;
            didChange = true;
          }
          if (didChange) {
            saveHoldingsToServer(auth, loadedHoldings).catch(() => {});
          }
        }

        if (!cancelled) {
          setHoldings(loadedHoldings);
          try {
            localStorage.setItem("holdings", JSON.stringify(loadedHoldings));
          } catch (e) {}
        }
      } catch (e) {
        if (cancelled) return;
        if (e.code === 401) {
          onAuthFail();
          return;
        }
        // Server unreachable or Redis not configured → use local cache
        if (localData && Array.isArray(localData)) {
          setHoldings(ensureCashAccount(localData));
        } else {
          setHoldings(ensureCashAccount([]));
        }
        setSyncState(e.code === 503 ? "local-only" : "offline");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh the USD/BRL rate on mount (used to convert BRL manual holdings).
  useEffect(() => {
    refreshUsdBrlRate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save holdings: debounced server write + immediate localStorage cache.
  useEffect(() => {
    if (!loaded) return;
    // Cache locally immediately (so a reload always has the latest)
    try {
      localStorage.setItem("holdings", JSON.stringify(holdings));
    } catch (e) {}

    // Skip server save if we know it's unavailable
    if (syncState === "local-only") return;

    // Debounce: wait 1500ms after the last change before saving to server
    const handle = setTimeout(async () => {
      setSyncState("saving");
      try {
        const result = await saveHoldingsToServer(auth, holdings);
        setLastSavedAt(result.savedAt);
        setSyncState("synced");
      } catch (e) {
        if (e.code === 401) {
          onAuthFail();
          return;
        }
        if (e.code === 409) {
          setSyncState("offline");
          setToast({ kind: "error", message: e.message });
          return;
        }
        setSyncState("offline");
      }
    }, 1500);

    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdings, loaded]);

  // Compute current value for any holding type (always in USD)
  function holdingValue(h) {
    if (h.type === "manual") {
      if (h.manualMode === "value") {
        const v = h.manualValue != null ? h.manualValue : 0;
        // BRA Fixed Income values are entered in BRL → convert to USD via live rate.
        if (h.manualCurrency === "BRL") {
          return usdBrlRate ? v / usdBrlRate : 0;
        }
        return v;
      }
      // manualMode === "qty_price"
      return h.manualPrice != null && h.qty != null ? h.manualPrice * h.qty : 0;
    }
    // auto
    return h.price ? h.price * h.qty : 0;
  }

  // Cash accounts: manual assets with asset class "Cash" (case-insensitive).
  // Excluded from rebalance and sorting; rendered in a dedicated section.
  function isCash(h) {
    if (h.type !== "manual") return false;
    return (h.assetClass || "").trim().toLowerCase() === "cash";
  }

  const totalValue = useMemo(
    () => holdings.reduce((s, h) => s + holdingValue(h), 0),
    [holdings, usdBrlRate]
  );

  // Monthly TOTAL net-worth snapshot (write-side). Unlike the perf-history
  // series (which excludes Cash/Unallocated/BRA Fixed Income — no price
  // history), this records the live total so a true "all assets" history
  // accumulates organically from now on. Debounced so it fires once after
  // prices settle; idempotent overwrite of the current month per PUT.
  useEffect(() => {
    if (!loaded || !(totalValue > 0)) return;
    if (syncState === "local-only") return;
    const handle = setTimeout(() => {
      const month = localTodayISO().slice(0, 7);
      fetch("/api/contributions-history?resource=networth-history", {
        method: "PUT",
        headers: { ...authHeaders(auth), "Content-Type": "application/json" },
        body: JSON.stringify({ month, value: totalValue }),
      }).catch(() => {});
    }, 5000);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, totalValue]);

  const totalTarget = useMemo(
    () => holdings.reduce((s, h) => s + (h.target || 0), 0),
    [holdings]
  );

  const deltaColorMap = useMemo(() => {
    const ranked = holdings
      .filter((h) => !isCash(h) && h.target > 0)
      .map((h) => {
        const v = holdingValue(h);
        const actualPct = v && totalValue > 0 ? (v / totalValue) * 100 : null;
        const drift = actualPct != null ? actualPct - h.target : null;
        return { id: h.id, drift };
      })
      .filter((x) => x.drift != null)
      .sort((a, b) => b.drift - a.drift);
    const map = new Map();
    ranked.forEach((x, i) => {
      if (i < 10) map.set(x.id, T.red);
      else if (i >= ranked.length - 10) map.set(x.id, T.green);
      else map.set(x.id, T.textDim);
    });
    return map;
  }, [holdings, totalValue, usdBrlRate]);

  const setBusy = (id, v) =>
    setBusyIds((prev) => {
      const next = { ...prev };
      if (v) next[id] = true;
      else delete next[id];
      return next;
    });

  // Decide whether the cached client-side profile is still fresh.
  function profileIsFresh(h) {
    if (!h.name || h.name.toUpperCase() === h.ticker.toUpperCase()) return false;
    if (!h.assetClass || h.assetClass === "Uncategorized") return false;
    if (!h.profileLoadedAt) return false;
    return Date.now() - new Date(h.profileLoadedAt).getTime() < PROFILE_REFRESH_INTERVAL_MS;
  }

  // Build the updated holding object from fetched price data.
  // If `data` is quote-only (no name/assetClass), keep the existing profile fields.
  function buildHoldingPatch(existing, data, tickerSymbol) {
    const isQuoteOnly = data.name == null && data.assetClass == null;

    const patch = {
      ...existing,
      price: data.price,
      previousClose: data.previousClose ?? existing.previousClose ?? null,
      originalCurrency: data.originalCurrency ?? existing.originalCurrency ?? null,
      originalPrice: data.originalPrice ?? existing.originalPrice ?? null,
      originalPreviousClose:
        data.originalPreviousClose ?? existing.originalPreviousClose ?? null,
      fxRate: data.fxRate ?? existing.fxRate ?? null,
      market: data.market ?? existing.market ?? null,
      lastUpdated: new Date().toISOString(),
      error: null,
    };

    if (!isQuoteOnly) {
      patch.name =
        data.name && data.name.toUpperCase() !== tickerSymbol.toUpperCase()
          ? data.name
          : existing.name || data.name;
      patch.assetClass =
        existing.assetClassOverride ||
        data.assetClass ||
        existing.assetClass ||
        "Uncategorized";
      // Only mark profile loaded if we actually got a real name back
      if (patch.name && patch.name.toUpperCase() !== tickerSymbol.toUpperCase()) {
        patch.profileLoadedAt = new Date().toISOString();
      }
    }

    return patch;
  }

  async function refreshOne(id, tickerSymbol) {
    setBusy(id, true);
    try {
      const existing = holdings.find((h) => h.id === id);
      const quoteOnly = existing ? profileIsFresh(existing) : false;
      const data = await fetchPrice(tickerSymbol, auth, quoteOnly);
      setHoldings((prev) =>
        prev.map((h) => (h.id === id ? buildHoldingPatch(h, data, tickerSymbol) : h))
      );
    } catch (e) {
      if (e.code === 401) {
        onAuthFail();
        return;
      }
      setHoldings((prev) =>
        prev.map((h) =>
          h.id === id ? { ...h, error: e.message || "Price fetch failed" } : h
        )
      );
    } finally {
      setBusy(id, false);
    }
  }

  // Background refresh: stages all updates and applies them in a single setState at the end.
  // Shows a non-intrusive toast with progress. No per-row flickering.
  async function refreshAll() {
    // Refresh the USD/BRL rate (for BRL-entered holdings) regardless of auto count.
    refreshUsdBrlRate();
    // Cash + Bank Bonds current values via SimpleFin (jul/2026) — fired here,
    // ahead of the auto-holdings early return below, since Cash/Bank Bonds
    // are manual holdings and wouldn't otherwise be touched by this function.
    // Non-blocking: it applies its own setHoldings patches independently.
    refreshFromSimplefin();

    const autoHoldings = holdings.filter((h) => h.type !== "manual");
    if (autoHoldings.length === 0) return;
    setRefreshing(true);
    setToast({ kind: "info", message: `Refreshing ${autoHoldings.length} positions…` });

    // Kick off S&P 500 refresh and transactions fetch in parallel (silent)
    refreshSp500();
    const txsPromise = fetchTransactionsForSync(auth);

    const results = new Map(); // id -> { ok: true, data } | { ok: false, error }

    // Primary path: two batch calls (quoteOnly for holdings with a fresh
    // profile, full for the rest) — a single serverless invocation each,
    // instead of one request per holding.
    let batchFailed = false;
    try {
      const freshGroup = autoHoldings.filter((h) => profileIsFresh(h));
      const staleGroup = autoHoldings.filter((h) => !profileIsFresh(h));
      const uniq = (hs) => [...new Set(hs.map((h) => h.ticker.toUpperCase()))];
      const [freshQuotes, staleQuotes] = await Promise.all([
        fetchPricesBatch(uniq(freshGroup), auth, true),
        fetchPricesBatch(uniq(staleGroup), auth, false),
      ]);
      for (const h of autoHoldings) {
        const map = profileIsFresh(h) ? freshQuotes : staleQuotes;
        const q = map[h.ticker.toUpperCase()];
        if (q && !q.error && q.price != null) {
          results.set(h.id, { ok: true, data: q });
        } else {
          results.set(h.id, { ok: false, error: q?.error || "Price fetch failed" });
        }
      }
    } catch (e) {
      if (e.code === 401) {
        onAuthFail();
        setRefreshing(false);
        setToast(null);
        return;
      }
      batchFailed = true;
    }

    // Fallback: legacy per-ticker loop (3 at a time) if the batch call itself
    // failed (network error, older server build during deploy, etc.).
    if (batchFailed) {
      results.clear();
      const batchSize = 3;
      for (let i = 0; i < autoHoldings.length; i += batchSize) {
        const batch = autoHoldings.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (h) => {
            try {
              const quoteOnly = profileIsFresh(h);
              const data = await fetchPrice(h.ticker, auth, quoteOnly);
              results.set(h.id, { ok: true, data });
            } catch (e) {
              if (e.code === 401) {
                throw e; // bubble up to outer catch
              }
              results.set(h.id, { ok: false, error: e.message || "Failed" });
            }
          })
        ).catch((e) => {
          if (e.code === 401) onAuthFail();
        });
        if (i + batchSize < autoHoldings.length) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }

    // Apply price patches + qty sync atomically
    const txs = await txsPromise;
    const netQty = txs ? computeNetQty(txs) : null;
    setHoldings((prev) => {
      let updated = prev.map((h) => {
        const r = results.get(h.id);
        if (!r) return h;
        if (r.ok) return buildHoldingPatch(h, r.data, h.ticker);
        return { ...h, error: r.error };
      });
      if (netQty) {
        const patched = applyTxQty(updated, netQty);
        if (patched) updated = patched;
      }
      // Item 37: sync the aggregated "US Bank Bonds" manual holding value.
      if (txs) {
        const hasBankBondTx = txs.some((t) => t && t.assetClass === "Bank Bonds");
        const bbPatched = applyBankBondsHolding(updated, txs, hasBankBondTx);
        if (bbPatched) updated = bbPatched;
      }
      return updated;
    });

    const successes = Array.from(results.values()).filter((r) => r.ok).length;
    const failures = autoHoldings.length - successes;

    setRefreshing(false);
    setToast(null); // dismiss the "Refreshing…" toast
    if (failures === 0) {
      setAlertModal({
        kind: "success",
        title: "Refresh complete",
        message: `${successes} position${successes === 1 ? "" : "s"} updated.`,
      });
    } else {
      setAlertModal({
        kind: "error",
        title: "Refresh finished with errors",
        message: `${successes} of ${autoHoldings.length} positions updated. ${failures} failed — try refreshing individually.`,
      });
    }
  }

  // Refresh the live USD/BRL rate used to convert BRA Fixed Income (BRL) holdings.
  async function refreshUsdBrlRate() {
    try {
      const rate = await fetchUsdBrlRate(auth);
      setUsdBrlRate(rate);
      try { localStorage.setItem("usdBrlRate", String(rate)); } catch (e) {}
    } catch (e) {
      if (e.code === 401) onAuthFail();
      // otherwise keep the cached rate
    }
  }

  function handleTransactionsChange(txs) {
    const netQty = computeNetQty(txs);
    const hasBankBondTx = txs.some((t) => t && t.assetClass === "Bank Bonds");
    setHoldings((prev) => {
      let next = applyTxQty(prev, netQty) ?? prev;
      // Item 37: keep the aggregated "US Bank Bonds" holding in sync.
      const bbPatched = applyBankBondsHolding(next, txs, hasBankBondTx);
      if (bbPatched) next = bbPatched;
      return next;
    });
    // Mirror the log for split detection and re-check pending splits.
    setTransactions(txs);
    refreshPendingSplits(txs, splitEvents);
  }

  // Detect splits/groupings present in market data but not yet reflected in the
  // transaction history. Non-blocking and failure-silent — never disrupts the app.
  async function refreshPendingSplits(txs, splitEventsArr) {
    try {
      const tickers = extractEligibleSplitTickers(txs || []);
      if (!tickers.length) {
        setPendingSplits([]);
        return;
      }
      const res = await fetch("/api/split-detect", {
        method: "POST",
        headers: { ...authHeaders(auth), "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const splits = Array.isArray(data.splits) ? data.splits : [];
      setPendingSplits(detectPendingSplits(txs || [], splits, splitEventsArr || []));
    } catch {
      /* silent — split detection is best-effort */
    }
  }

  // Merge freshly detected alerts into the rolling log. Each new alert (by stable
  // `id`) is stamped with the detection date as `sentDate` and `read: false`.
  // Newest first; the stored log is capped at MAX_ALERT_LOG entries.
  function mergeAlerts(detected, todayISO) {
    if (!detected || !detected.length) return;
    setAlertLog((prev) => {
      const byId = new Map(prev.map((a) => [a.id, a]));
      const additions = [];
      // Existing alerts get their payload (message/detail/total/amount/etc.)
      // refreshed in place when the freshly detected version differs — e.g. a
      // dividend alert recorded before a data-source fix (Yahoo estimate → real
      // Fidelity amount) must not stay stuck showing the old number forever.
      // sentDate and read state are preserved; only the displayed content updates.
      let changed = false;
      const updated = prev.map((a) => {
        const fresh = detected.find((d) => d.id === a.id);
        if (!fresh) return a;
        const { id, ...rest } = fresh;
        const same = Object.keys(rest).every((k) => rest[k] === a[k]);
        if (same) return a;
        changed = true;
        return { ...a, ...rest };
      });
      for (const a of detected) {
        if (!byId.has(a.id)) {
          additions.push({
            ...a,
            sentDate: todayISO,
            // If another device already marked this alert as read (per the
            // server's readIds snapshot), don't surface it as unread here.
            read: serverReadIdsRef.current.has(a.id),
          });
        }
      }
      if (!additions.length && !changed) return prev;
      return [...additions, ...updated].slice(0, MAX_ALERT_LOG);
    });
  }

  function markAlertRead(id) {
    setAlertLog((prev) => prev.map((a) => (a.id === id ? { ...a, read: true } : a)));
    saveAlertsReadToServer(auth, [id]);
  }

  function markAllAlertsRead() {
    const newlyRead = alertLog.filter((a) => !a.read).map((a) => a.id);
    setAlertLog((prev) => prev.map((a) => (a.read ? a : { ...a, read: true })));
    saveAlertsReadToServer(auth, newlyRead);
  }

  // Detect today's dividend payouts, earnings, and bond maturities and merge them
  // into the alert log. Non-blocking; uses the same events Redis cache as the
  // Events tab. Dividend alerts compute the amount paid (qty held × $/share) from
  // a live Yahoo/Finnhub estimate — bondIncome (Fidelity-imported dividends, same
  // store the Dividends tab uses) overrides that estimate with the exact amount
  // when today's payout for that ticker was already imported. Without this, the
  // Alerts badge and the Dividends tab can disagree (confirmed case: AMT badge
  // showed $91.29 from a stale Yahoo $/share estimate while Fidelity's actual
  // import — and the Dividends tab — had $71.60).
  async function refreshAlerts(txs, bondIncome) {
    const todayISO = localTodayISO();
    const netQty = computeNetQty(txs);
    // Bond maturity within 7 days — derived from transactions, no API needed.
    // assetClass === "Bank Bonds" plus a maturityDate is already enough to
    // identify the bond; no need to also gate on the ticker's shape. That
    // used to require a 9-char CUSIP format, but Bank Bonds bought with no
    // public CUSIP source now carry an 11-char synthetic id (see
    // generateSyntheticBondTicker in lib/bond-meta.js) and still need this
    // alert.
    const seenBond = new Set();
    const bondAlerts = [];
    for (const tx of txs) {
      if (tx.assetClass !== "Bank Bonds" || !tx.maturityDate) continue;
      const cusip = (tx.ticker || "").toUpperCase();
      if (!cusip || seenBond.has(cusip)) continue;
      const daysLeft = Math.ceil(
        (new Date(tx.maturityDate + "T00:00:00Z") - new Date(todayISO + "T00:00:00Z")) / 86400000
      );
      if (daysLeft >= 0 && daysLeft <= 7) {
        seenBond.add(cusip);
        bondAlerts.push({
          id: `bond_maturity|${cusip}|${tx.maturityDate}`,
          type: "bond_maturity",
          ticker: cusip,
          message: daysLeft === 0 ? "Bond matures today" : `Bond matures in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
          detail: tx.maturityDate,
        });
      }
    }
    mergeAlerts(bondAlerts, todayISO);
    // Fetch today's dividend payouts and earnings from events API.
    try {
      const ELIGIBLE = new Set(["Stocks", "Real Estate", "Alternative", "Bonds", "BRA Stocks", "Unallocated USD"]);
      const tickers = [
        ...new Set(
          txs
            .filter((tx) => ELIGIBLE.has(tx.assetClass) && (netQty[(tx.ticker || "").toUpperCase()] || 0) > 0)
            .map((tx) => (tx.ticker || "").toUpperCase())
            .filter(
              (t) =>
                t &&
                !/^[A-Z]{4}\d{1,2}$/i.test(t) &&
                !/^[0-9A-Z]{9}$/.test(t) &&
                !/^tesouro-/i.test(t)
            )
        ),
      ];
      if (!tickers.length) return;
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { ...authHeaders(auth), "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const events = Array.isArray(data.events) ? data.events : [];
      // Fidelity-imported dividend payments already received today, keyed by
      // ticker — exact totalReceived, used instead of the live estimate below.
      // Foreign tax withheld the same day (e.g. TSM/VALE ADRs) is netted in too,
      // same as every other dividend total in the app — but only against a ticker
      // that actually has a dividend row for today (two passes: a stray tax-only
      // row, order-independent, must never by itself produce a negative override).
      const todaysBondIncome = (bondIncome || []).filter(
        (e) => e && e.date === todayISO && e.ticker && e.amount > 0
      );
      const fidelityToday = new Map();
      for (const e of todaysBondIncome) {
        if (e.kind !== "dividend") continue;
        const tk = e.ticker.toUpperCase();
        fidelityToday.set(tk, (fidelityToday.get(tk) || 0) + Number(e.amount));
      }
      for (const e of todaysBondIncome) {
        if (e.kind !== "tax") continue;
        const tk = e.ticker.toUpperCase();
        if (fidelityToday.has(tk)) fidelityToday.set(tk, fidelityToday.get(tk) - Number(e.amount));
      }
      const seenPayout = new Set();
      const seenEarnings = new Set();
      const apiAlerts = [];
      for (const ev of events) {
        if (ev.date !== todayISO) continue;
        const tk = (ev.ticker || "").toUpperCase();
        if (ev.type === "payout" && !seenPayout.has(tk)) {
          seenPayout.add(tk);
          const qty = netQty[tk] || 0;
          const perShare = Number(ev.amount) || 0;
          const realAmount = fidelityToday.get(tk);
          const total = realAmount != null
            ? realAmount
            : qty > 0 && perShare > 0 ? qty * perShare : 0;
          // When the real Fidelity amount overrides the estimate, re-derive $/share
          // from it (same total ÷ qty) so the "N sh × $X/sh" detail stays consistent
          // with the total shown — using the raw Yahoo perShare here would mismatch.
          const displayPerShare = realAmount != null && qty > 0 ? realAmount / qty : perShare;
          apiAlerts.push({
            id: `dividend|${tk}|${ev.date}`,
            type: "dividend",
            ticker: ev.ticker,
            amount: displayPerShare,
            qtyHeld: qty,
            total,
            message: total > 0 ? `Dividend paid: ${fmtMoney(total)}` : "Dividend paid today",
            detail: total > 0 ? `${fmtNum(qty)} sh × ${fmtMoney(displayPerShare)}/sh` : null,
          });
        } else if (ev.type === "earnings" && !seenEarnings.has(tk)) {
          seenEarnings.add(tk);
          apiAlerts.push({
            id: `earnings|${tk}|${ev.date}`,
            type: "earnings",
            ticker: ev.ticker,
            message: "Earnings released today",
          });
        }
      }
      mergeAlerts(apiAlerts, todayISO);

      // Reconcile already-recorded dividend alerts against Fidelity imports,
      // regardless of date — the "today" loop above only re-detects an event
      // while its date is still today's, so an alert recorded on the day a
      // dividend paid (using the live Yahoo/Finnhub estimate) never got a
      // chance to pick up a real import added on a *later* day, staying stuck
      // on the stale estimate forever (confirmed: AMT stuck at $91.29 even
      // after the estimate-preference fix above, because by the time the fix
      // shipped the payout date was no longer "today"). Full-history version
      // of the same dividend/tax netting used above.
      const fidelityByKey = new Map();
      for (const e of bondIncome || []) {
        if (!e || e.kind !== "dividend" || !e.ticker || !e.date || !(e.amount > 0)) continue;
        const key = `${e.ticker.toUpperCase()}|${e.date}`;
        fidelityByKey.set(key, (fidelityByKey.get(key) || 0) + Number(e.amount));
      }
      for (const e of bondIncome || []) {
        if (!e || e.kind !== "tax" || !e.ticker || !e.date || !(e.amount > 0)) continue;
        const key = `${e.ticker.toUpperCase()}|${e.date}`;
        if (fidelityByKey.has(key)) fidelityByKey.set(key, fidelityByKey.get(key) - Number(e.amount));
      }
      setAlertLog((prev) => {
        let changed = false;
        const next = prev.map((a) => {
          if (a.type !== "dividend") return a;
          const [, tk, date] = a.id.split("|");
          const real = fidelityByKey.get(`${tk}|${date}`);
          if (real == null || real === a.total) return a;
          changed = true;
          const qty = netQty[tk] || a.qtyHeld || 0;
          const displayPerShare = qty > 0 ? real / qty : a.amount;
          return {
            ...a,
            amount: displayPerShare,
            total: real,
            message: `Dividend paid: ${fmtMoney(real)}`,
            detail: `${fmtNum(qty)} sh × ${fmtMoney(displayPerShare)}/sh`,
          };
        });
        return changed ? next : prev;
      });
    } catch {
      /* silent — alerts are best-effort */
    }
  }

  // Admin-only heartbeat check for the SimpleFin/Fidelity sync feed (Fase 3).
  // Cheap read of ?resource=status (no fetch to SimpleFin itself, no throttle
  // hit). Surfaces a stable-id alert ("simplefin_heartbeat") when the last
  // sync attempt errored, or when the feed hasn't synced in over 48h (or
  // never has). Update-in-place follows the same mergeAlerts pattern as the
  // other alert types above; when healthy again the alert is explicitly
  // pruned from the log (its id is stable across days, unlike dividend/
  // earnings ids which embed the event date and so simply stop being
  // re-detected once resolved).
  async function refreshSimplefinHeartbeat() {
    try {
      const res = await fetch("/api/fidelity-pending?resource=status", {
        headers: authHeaders(auth),
      });
      if (!res.ok) return;
      const data = await res.json();
      const todayISO = localTodayISO();
      const HEARTBEAT_ID = "simplefin_heartbeat";
      const STALE_MS = 48 * 60 * 60 * 1000;
      const lastSyncMs = data.lastSync ? new Date(data.lastSync).getTime() : null;
      const isStale = lastSyncMs == null || Date.now() - lastSyncMs > STALE_MS;
      const hasError = !!data.lastError;
      if (hasError || isStale) {
        let message;
        if (hasError) {
          message = `SimpleFin: falha ao sincronizar — ${data.lastError}`;
        } else if (!data.lastSync) {
          message = "SimpleFin: nunca sincronizado";
        } else {
          const days = Math.floor((Date.now() - lastSyncMs) / 86400000);
          message = `SimpleFin: sem sincronizar ha ${days} dia${days === 1 ? "" : "s"}`;
        }
        mergeAlerts(
          [
            {
              id: HEARTBEAT_ID,
              type: "simplefin_heartbeat",
              ticker: "SimpleFin",
              message,
              detail: data.lastSync || null,
            },
          ],
          todayISO
        );
      } else {
        setAlertLog((prev) =>
          prev.some((a) => a.id === HEARTBEAT_ID) ? prev.filter((a) => a.id !== HEARTBEAT_ID) : prev
        );
      }
    } catch {
      /* silent — heartbeat is best-effort, same as split/dividend/earnings detection */
    }
  }

  // Approve a pending split: adjust history, record the decision, persist, and
  // cascade the holdings/qty + perf-cache invalidation via handleTransactionsChange.
  async function approveSplit(sp) {
    const key = `${sp.ticker}|${sp.date}|${sp.numerator}|${sp.denominator}`;
    setSplitActionInFlight(key);
    const next = applySplitToTransactions(transactions, sp);
    const nextSplitEvents = [
      ...splitEvents,
      {
        ticker: sp.ticker,
        date: sp.date,
        numerator: sp.numerator,
        denominator: sp.denominator,
        status: "applied",
        appliedAt: new Date().toISOString(),
      },
    ];
    try {
      // Omit bondIncome → server preserves the existing value.
      await saveTransactionsToServer(auth, next, undefined, nextSplitEvents);
    } catch (e) {
      setToast({ kind: "error", message: `Split save failed: ${e.message || "error"}` });
      setSplitActionInFlight(null);
      return;
    }
    setSplitActionInFlight(null);
    setSplitEvents(nextSplitEvents);
    setTransactions(next);
    setPendingSplits((prev) =>
      prev.filter(
        (p) =>
          !(p.ticker === sp.ticker && p.date === sp.date &&
            p.numerator === sp.numerator && p.denominator === sp.denominator)
      )
    );
    handleTransactionsChange(next); // cascade: applyTxQty + perf cache invalidation
  }

  // Dismiss a pending split: record the decision so it never re-surfaces.
  // Transactions are left unchanged.
  async function dismissSplit(sp) {
    const key = `${sp.ticker}|${sp.date}|${sp.numerator}|${sp.denominator}`;
    setSplitActionInFlight(key);
    const nextSplitEvents = [
      ...splitEvents,
      {
        ticker: sp.ticker,
        date: sp.date,
        numerator: sp.numerator,
        denominator: sp.denominator,
        status: "dismissed",
        appliedAt: new Date().toISOString(),
      },
    ];
    try {
      await saveTransactionsToServer(auth, transactions, undefined, nextSplitEvents);
    } catch (e) {
      setToast({ kind: "error", message: `Dismiss failed: ${e.message || "error"}` });
      setSplitActionInFlight(null);
      return;
    }
    setSplitActionInFlight(null);
    setSplitEvents(nextSplitEvents);
    setPendingSplits((prev) =>
      prev.filter(
        (p) =>
          !(p.ticker === sp.ticker && p.date === sp.date &&
            p.numerator === sp.numerator && p.denominator === sp.denominator)
      )
    );
  }

  // Applies an approved SimpleFin balance candidate (Cash or Bank Bonds,
  // see docs/plans/simplefin-fidelity-feed.md Fase 1) to the live holdings.
  // The staging-side bookkeeping (removing the candidate from
  // `:fidelity-pending`) is handled by TransactionsView, which owns that
  // state; this only updates `holdings`, which auto-saves via the existing
  // debounced effect.
  //
  // Cash writes straight to manualValue (the value actually displayed).
  // Bank Bonds DISPLAY a current value resolved per-bond via
  // computeBankBondsMarketValue (bugfix aug/2026 - see the comment further
  // down, on the "existing holding" branch, for why this is no longer a flat
  // sum): `manualValue` is that resolved total, `marketValueOverride` keeps
  // the raw flat SimpleFin sum only as a reference/back-compat field, and the
  // PER-BOND breakdown is stored in `bondMarketValues` (descKey -> market
  // value) so both this function and Position Performance resolve each bond
  // identically. `bondHoldings` is the sync's per-bond snapshot
  // (Transactions.jsx passes it through); each entry carries a descKey +
  // marketValue.
  function applyFidelityBalanceUpdate(candidate, bondHoldings = []) {
    if (!candidate) return;
    const asOf = candidate.asOf || new Date().toISOString();
    if (candidate.kind === "cash") {
      setHoldings((prev) =>
        prev.map((h) =>
          h.id === CASH_ID
            ? {
                ...h,
                manualValue: candidate.proposed,
                manualCurrency: "USD",
                lastUpdated: asOf,
                // Dedicated field for the "Last Synced (SimpleFin)" info block —
                // lastUpdated is generic (bumped by any edit, including Target%),
                // so it can't be reused to show sync recency specifically.
                simplefinSyncedAt: asOf,
              }
            : h
        )
      );
      setToast({ kind: "success", message: `Cash updated to ${candidate.proposed}` });
      return;
    }
    if (candidate.kind === "bank-bonds") {
      // Per-bond current values keyed by the stable descKey (issuer|coupon|
      // maturity), so Position Performance can match SimpleFin individually
      // per bond regardless of whether the bond is keyed by a CUSIP, a
      // synthetic id, or a manual ticker.
      const bondMarketValues = {};
      for (const h of Array.isArray(bondHoldings) ? bondHoldings : []) {
        const key = h && h.descKey;
        const mv = h && Number(h.marketValue);
        if (key && isFinite(mv)) bondMarketValues[key] = mv;
      }
      const found = holdings.some((h) => h.id === BANK_BONDS_ID);
      if (!found) {
        // No Bank Bonds holding exists yet (no Bank Bonds transactions have
        // been entered). Rather than discard the SimpleFin-reported value,
        // create the holding with it directly so it's visible immediately.
        // derivedFromTransactions: false marks it as not yet backed by a
        // real transaction — applyBankBondsHolding's guard (see there) must
        // not zero this back out on the next load/refresh, since with no
        // Bank Bonds transactions the computed principal is always 0.
        setHoldings((prev) => [
          ...prev,
          {
            id: BANK_BONDS_ID,
            type: "manual",
            manualMode: "value",
            ticker: "US BANK BONDS",
            name: "US Bank Bonds",
            assetClass: "Bank Bonds",
            assetClassOverride: "Bank Bonds",
            manualCurrency: "USD",
            qty: null,
            manualPrice: null,
            manualValue: candidate.proposed,
            costBasis: 0,
            price: null,
            target: 0,
            marketValueOverride: candidate.proposed,
            marketValueOverrideAsOf: asOf,
            bondMarketValues,
            bondMarketValuesAsOf: asOf,
            derivedFromTransactions: false,
            lastUpdated: new Date().toISOString(),
          },
        ]);
        setToast({
          kind: "success",
          message: "Bank Bonds holding created from SimpleFin balance.",
        });
        return;
      }
      // Existing holding: display the current value using the SAME per-bond
      // resolution applyBankBondsHolding/Position Performance use (bugfix
      // aug/2026) rather than the raw flat SimpleFin sum (`candidate.proposed`,
      // computeBalanceCandidates in lib/simplefin-map.js) - that flat sum
      // silently drops any bond present in the transaction log but missing
      // from this SimpleFin snapshot, which is exactly what produced the
      // Holdings-vs-Position-Performance mismatch this fix addresses. Writing
      // `candidate.proposed` straight into manualValue here would reintroduce
      // that same wrong total for as long as it takes the next
      // load/refresh/transaction-change to re-run applyBankBondsHolding - a
      // real race, since this SimpleFin sync (refreshFromSimplefin) runs
      // concurrently with "Refresh all"'s own applyBankBondsHolding call and
      // either can land last. `candidate.proposed` is still kept as
      // `marketValueOverride`, reference/back-compat only. Falls back to
      // `candidate.proposed` when there are no Bank Bonds transactions yet to
      // replay (mirrors applyBankBondsHolding's own not-yet-derived guard).
      const hasBankBondTxNow = (transactions || []).some(
        (t) => t && t.assetClass === "Bank Bonds"
      );
      const displayValue = hasBankBondTxNow
        ? computeBankBondsMarketValue(transactions, bondMarketValues).total
        : candidate.proposed;
      setHoldings((prev) =>
        prev.map((h) =>
          h.id === BANK_BONDS_ID
            ? {
                ...h,
                manualValue: displayValue,
                marketValueOverride: candidate.proposed,
                marketValueOverrideAsOf: asOf,
                bondMarketValues,
                bondMarketValuesAsOf: asOf,
              }
            : h
        )
      );
      setToast({
        kind: "success",
        message: "Bank Bonds current value updated from SimpleFin.",
      });
    }
  }

  // Pulls a fresh SimpleFin sync and applies any Cash/Bank Bonds balance
  // updates straight to holdings — the same effect Transactions.jsx's own
  // sync-and-auto-apply flow produces, reused here so both "Refresh all" and
  // the Bank Bonds card's "Refresh price" button track SimpleFin (jul/2026).
  // Silently no-ops on any failure (non-admin, sync not configured, network
  // error) — this is a background enhancement layered on top of the existing
  // ticker-price refresh, never something that should surface as an error on
  // the Holdings tab.
  async function refreshFromSimplefin() {
    try {
      const { balanceCandidates, bondHoldings } = await syncFidelityAndFetchCandidates(auth);
      for (const c of balanceCandidates) {
        if (c && (c.kind === "cash" || c.kind === "bank-bonds")) {
          applyFidelityBalanceUpdate(c, bondHoldings);
        }
      }
    } catch (e) {
      if (e.code === 401) onAuthFail();
    }
  }

  // Dedicated wrapper so the Bank Bonds card's "Refresh price" button can
  // show a spinner via the same busyIds map HoldingRow uses for ticker
  // refreshes (busyIds[BANK_BONDS_ID]).
  async function refreshBankBondsFromSimplefin() {
    setBusy(BANK_BONDS_ID, true);
    try {
      await refreshFromSimplefin();
    } finally {
      setBusy(BANK_BONDS_ID, false);
    }
  }

  function removeHolding(id) {
    if (id === CASH_ID) return; // cash account is permanent
    setHoldings((prev) => prev.filter((h) => h.id !== id));
  }

  function applyCSVImport(rows) {
    const actionRows = rows.filter((r) => r.action !== "error");
    setHoldings((prev) => {
      let updated = prev.map((h) => {
        const match = actionRows.find(
          (r) => r.action === "update_target" && r.existingHolding && r.existingHolding.id === h.id
        );
        if (match) return { ...h, target: match.targetPct };
        return h;
      });
      const toAdd = [];
      for (const r of actionRows) {
        if (r.action === "create_from_tx") {
          toAdd.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + toAdd.length,
            ticker: r.ticker,
            assetClass: r.txAssetClass,
            qty: 0,
            price: null,
            previousClose: null,
            target: r.targetPct,
            lastUpdated: new Date().toISOString(),
          });
        } else if (r.action === "create_new") {
          toAdd.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + toAdd.length,
            ticker: r.ticker,
            assetClass: r.chosenAssetClass,
            qty: 0,
            price: null,
            previousClose: null,
            target: r.targetPct,
            lastUpdated: new Date().toISOString(),
            fromCSVImport: true,
          });
        }
      }
      return [...updated, ...toAdd];
    });
    saveHoldingsToServer(auth, holdings).catch(() => {});
    setShowCSVImport(false);
    const n = actionRows.length;
    setToast({ kind: "success", message: `Imported ${n} holding${n !== 1 ? "s" : ""} updated` });
  }

  function addManualHolding() {
    setManualFormError("");
    const name = manualName.trim();
    if (!name) return setManualFormError("Name required");
    const tgt = manualTarget === "" ? 0 : parseFloat(manualTarget);
    if (tgt < 0 || tgt > 100) return setManualFormError("Target % must be 0–100");

    let qty = null;
    let manualPrice = null;
    let manualValue = null;

    if (manualMode === "value") {
      manualValue = parseFloat(manualValueInput);
      if (isNaN(manualValue) || manualValue < 0)
        return setManualFormError("Value must be ≥ 0");
    } else {
      qty = parseFloat(manualQty);
      manualPrice = parseFloat(manualPriceInput);
      if (isNaN(qty) || qty <= 0) return setManualFormError("Quantity must be > 0");
      if (isNaN(manualPrice) || manualPrice < 0)
        return setManualFormError("Price must be ≥ 0");
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setHoldings((prev) => [
      ...prev,
      {
        id,
        type: "manual",
        ticker: name.toUpperCase().slice(0, 12),
        name,
        manualMode,
        qty,
        manualPrice,
        manualValue,
        target: tgt,
        assetClass: manualClass.trim() || "Manual",
        assetClassOverride: manualClass.trim() || null,
        // BRL entry only applies to BRA Fixed Income value-mode holdings.
        manualCurrency:
          manualMode === "value" &&
          manualClass.trim().toLowerCase() === "bra fixed income" &&
          manualCurrency === "BRL"
            ? "BRL"
            : "USD",
        price: null,
        error: null,
        lastUpdated: new Date().toISOString(),
      },
    ]);
    // Reset form
    setManualName("");
    setManualValueInput("");
    setManualQty("");
    setManualPriceInput("");
    setManualTarget("");
    setManualClass("");
    setManualCurrency("USD");
    setShowManualForm(false);
  }

  function updateManualHolding(id, patch) {
    setHoldings((prev) =>
      prev.map((h) =>
        h.id === id
          ? { ...h, ...patch, lastUpdated: new Date().toISOString() }
          : h
      )
    );
  }

  // Inline edit for auto holdings: qty / target
  function updateHolding(id, patch) {
    setHoldings((prev) =>
      prev.map((h) => (h.id === id ? { ...h, ...patch } : h))
    );
  }

  function saveAssetClass(id) {
    setHoldings((prev) =>
      prev.map((h) =>
        h.id === id
          ? {
              ...h,
              assetClass: editingClassValue.trim() || "Uncategorized",
              assetClassOverride: editingClassValue.trim() || null,
            }
          : h
      )
    );
    setEditingClassId(null);
    setEditingClassValue("");
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ holdings, exportedAt: new Date().toISOString() }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `portfolio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        const incoming = Array.isArray(parsed) ? parsed : parsed.holdings;
        if (!Array.isArray(incoming)) throw new Error("Invalid format");
        if (!confirm(`Replace your current ${holdings.length} holdings with ${incoming.length} from backup?`)) return;
        setHoldings(ensureCashAccount(incoming));
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  // Rebalance: BUYS ONLY, integer shares, capped at $1000 per asset.
  // If newCash specified, total purchases ≤ newCash. Otherwise no overall limit.
  // Ordered by largest underweight first.
  const rebalance = useMemo(() => {
    const cash = parseFloat(newCash) || 0;
    const investableTotal = totalValue + cash;
    if (investableTotal <= 0) return [];

    // Build candidate list: only underweight holdings with valid prices
    const candidates = holdings
      .filter((h) => {
        if (isCash(h)) return false; // cash sits separately, not rebalanced
        if (h.target <= 0) return false;
        if (h.type === "manual") {
          // Manual value-only: no integer shares to buy. Skip from suggestions.
          if (h.manualMode === "value") return false;
          return h.manualPrice != null && h.manualPrice > 0 && h.qty != null;
        }
        return h.price != null && h.price > 0;
      })
      .map((h) => {
        const currentValue = holdingValue(h);
        const targetValue = investableTotal * (h.target / 100);
        const gap = targetValue - currentValue;
        const price = h.type === "manual" ? h.manualPrice : h.price;
        return { holding: h, currentValue, targetValue, gap, price };
      })
      .filter((c) => c.gap > 0); // underweight only

    // Sort: largest gap first
    candidates.sort((a, b) => b.gap - a.gap);

    // Allocate cash in $1K chunks (or up to gap, whichever is smaller)
    let remainingCash = cash > 0 ? cash : Infinity;
    const suggestions = [];
    for (const c of candidates) {
      if (remainingCash <= 0) break;
      const allocDollars = Math.min(PER_ASSET_CAP, c.gap, remainingCash);
      const qty = Math.floor(allocDollars / c.price);
      if (qty <= 0) continue; // price > $1K with cash too small to buy 1 share
      const actualDollars = qty * c.price;
      suggestions.push({
        holding: c.holding,
        currentValue: c.currentValue,
        targetValue: c.targetValue,
        deltaShares: qty,
        deltaDollars: actualDollars,
        gap: c.gap,
      });
      remainingCash -= actualDollars;
    }

    return suggestions;
  }, [holdings, totalValue, newCash]);

  // Build asset class dropdown options from existing holdings
  const assetClassOptions = useMemo(() => {
    const set = new Set();
    holdings.forEach((h) => {
      const c = h.assetClass || "Uncategorized";
      set.add(c);
    });
    return Array.from(set).sort();
  }, [holdings]);

  // Apply text filter, class filter, then sort
  function applyFiltersAndSort(list) {
    let result = list;
    if (filterText.trim()) {
      const q = filterText.trim().toLowerCase();
      result = result.filter(
        (h) =>
          (h.ticker || "").toLowerCase().includes(q) ||
          (h.name || "").toLowerCase().includes(q)
      );
    }
    if (filterClass) {
      result = result.filter((h) => (h.assetClass || "Uncategorized") === filterClass);
    }
    if (sortBy !== "default") {
      result = [...result].sort((a, b) => {
        if (sortBy === "name" || sortBy === "name_desc") {
          const an = (a.name || a.ticker || "").toLowerCase();
          const bn = (b.name || b.ticker || "").toLowerCase();
          return sortBy === "name" ? an.localeCompare(bn) : bn.localeCompare(an);
        }
        if (sortBy === "value" || sortBy === "value_desc") {
          const av = holdingValue(a);
          const bv = holdingValue(b);
          return sortBy === "value" ? av - bv : bv - av;
        }
        if (sortBy === "gap_desc" || sortBy === "gap") {
          // Signed gap = target% - actual%. Positive = underweight (needs buying).
          // gap_desc: most underweight first → most overweight last (matches rebalance logic).
          // gap: reverse.
          // Holdings with no target sink to the bottom.
          const gapOf = (h) => {
            if (!h.target || h.target <= 0) return null;
            const v = holdingValue(h);
            const actualPct = totalValue > 0 ? (v / totalValue) * 100 : 0;
            return h.target - actualPct;
          };
          const ag = gapOf(a);
          const bg = gapOf(b);
          if (ag == null && bg == null) return 0;
          if (ag == null) return 1;
          if (bg == null) return -1;
          return sortBy === "gap_desc" ? bg - ag : ag - bg;
        }
        return 0;
      });
    }
    return result;
  }

  // Consolidated holdings (auto + manual non-cash) — filtered & sorted together
  const filteredHoldings = useMemo(
    () =>
      applyFiltersAndSort(
        holdings
          .filter((h) => !isCash(h))
          .filter((h) => !(isZeroHolding(h) && !(h.target > 0)))
      ),
    [holdings, filterText, filterClass, sortBy, totalValue]
  );
  // Cash accounts — separate section, not affected by sort/filter (except text filter)
  const cashAccounts = useMemo(() => {
    let result = holdings.filter(isCash);
    if (filterText.trim()) {
      const q = filterText.trim().toLowerCase();
      result = result.filter(
        (h) =>
          (h.ticker || "").toLowerCase().includes(q) ||
          (h.name || "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [holdings, filterText]);

  const hasActiveFilter = !!(filterText.trim() || filterClass || sortBy !== "gap_desc");

  // Build allocation chart data: target vs actual, grouped by class or per holding
  const chartData = useMemo(() => {
    const keyOf = (h) =>
      chartGrouping === "class" ? h.assetClass || "Uncategorized" : h.ticker || h.name;

    const targetMap = new Map();
    const actualMap = new Map();
    // For day change: per-key sum(value) and sum(value * dayPct)
    const dayValueSum = new Map();
    const dayWeightedSum = new Map();

    holdings.forEach((h) => {
      const key = keyOf(h);
      if (h.target > 0) {
        targetMap.set(key, (targetMap.get(key) || 0) + h.target);
      }
      const v = holdingValue(h);
      if (v > 0) {
        actualMap.set(key, (actualMap.get(key) || 0) + v);
      }
      // Day change only applies to auto holdings with both prices
      if (
        h.type !== "manual" &&
        h.price != null &&
        h.previousClose != null &&
        h.previousClose !== 0 &&
        v > 0
      ) {
        const dayPct = ((h.price - h.previousClose) / h.previousClose) * 100;
        dayValueSum.set(key, (dayValueSum.get(key) || 0) + v);
        dayWeightedSum.set(key, (dayWeightedSum.get(key) || 0) + v * dayPct);
      }
    });

    // Compute weighted day change per key
    const dayChangeMap = new Map();
    for (const k of dayValueSum.keys()) {
      const totalV = dayValueSum.get(k);
      if (totalV > 0) {
        dayChangeMap.set(k, dayWeightedSum.get(k) / totalV);
      }
    }

    // Portfolio-wide weighted day change
    let portfolioDayValue = 0;
    let portfolioDayWeighted = 0;
    for (const k of dayValueSum.keys()) {
      portfolioDayValue += dayValueSum.get(k);
      portfolioDayWeighted += dayWeightedSum.get(k);
    }
    const portfolioDayChange =
      portfolioDayValue > 0 ? portfolioDayWeighted / portfolioDayValue : null;

    // Stable sort + color assignment
    const allKeys = Array.from(new Set([...targetMap.keys(), ...actualMap.keys()])).sort();
    const colorMap = {};
    allKeys.forEach((k, i) => {
      colorMap[k] = DONUT_COLORS[i % DONUT_COLORS.length];
    });

    const totalTarget = Array.from(targetMap.values()).reduce((s, v) => s + v, 0);
    const targetSlices = allKeys
      .filter((k) => targetMap.has(k))
      .map((k) => ({
        key: k,
        pct: targetMap.get(k),
        color: colorMap[k],
      }));
    if (totalTarget < 99.5) {
      targetSlices.push({
        key: "Unallocated",
        pct: 100 - totalTarget,
        color: UNALLOCATED_COLOR,
        isUnallocated: true,
      });
    }

    const totalActualValue = Array.from(actualMap.values()).reduce((s, v) => s + v, 0);
    const actualSlices = allKeys
      .filter((k) => actualMap.has(k))
      .map((k) => ({
        key: k,
        pct: totalActualValue > 0 ? (actualMap.get(k) / totalActualValue) * 100 : 0,
        value: actualMap.get(k),
        color: colorMap[k],
      }));

    return {
      targetSlices,
      actualSlices,
      totalTarget,
      totalActualValue,
      colorMap,
      dayChangeMap,
      portfolioDayChange,
    };
  }, [holdings, chartGrouping]);

  // Bell badge: unreviewed splits + unread alerts.
  const unreadAlertCount = alertLog.filter((a) => !a.read).length;
  const alertBadgeCount = pendingSplits.length + unreadAlertCount;

  return (
    <>
      <style>{FONT_IMPORT}</style>
      <style>{`
        * { box-sizing: border-box; }
        input::placeholder { color: ${T.textFaint}; }
        input:focus { outline: none; border-color: ${T.gold} !important; }
        button { font-family: ${FONT_BODY}; cursor: pointer; }
        button:disabled { cursor: not-allowed; opacity: 0.5; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        .spin { animation: spin 1s linear infinite; }
        .card-enter { animation: fadeIn 0.25s ease-out; }
      `}</style>

      <div
        style={{
          minHeight: "100vh",
          background: T.bg,
          color: T.text,
          fontFamily: FONT_BODY,
          padding:
            "max(50px, calc(20px + env(safe-area-inset-top, 0px))) calc(16px + env(safe-area-inset-right, 0px)) calc(60px + env(safe-area-inset-bottom, 0px)) calc(16px + env(safe-area-inset-left, 0px))",
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          {/* Modal alert (blocks until OK is tapped) */}
          {alertModal && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0, 0, 0, 0.65)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 2000,
                padding: 20,
                backdropFilter: "blur(2px)",
              }}
              onClick={() => setAlertModal(null)}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: T.card,
                  border: `1px solid ${
                    alertModal.kind === "error" ? T.red : T.gold
                  }55`,
                  borderRadius: 6,
                  padding: 20,
                  maxWidth: 360,
                  width: "100%",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 12,
                  }}
                >
                  {alertModal.kind === "success" ? (
                    <CheckCircle2 size={20} style={{ color: T.green }} />
                  ) : (
                    <AlertCircle size={20} style={{ color: T.red }} />
                  )}
                  <div
                    style={{
                      fontFamily: FONT_DISPLAY,
                      fontSize: 18,
                      fontWeight: 500,
                      color: T.text,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {alertModal.title}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: T.textDim,
                    fontFamily: FONT_BODY,
                    lineHeight: 1.5,
                    marginBottom: 18,
                  }}
                >
                  {alertModal.message}
                </div>
                <button
                  onClick={() => setAlertModal(null)}
                  autoFocus
                  style={{
                    width: "100%",
                    background: T.gold,
                    color: T.bg,
                    border: "none",
                    padding: "11px 16px",
                    fontFamily: FONT_BODY,
                    fontWeight: 600,
                    fontSize: 12,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    borderRadius: 3,
                    cursor: "pointer",
                  }}
                >
                  OK
                </button>
              </div>
            </div>
          )}

          {/* Alerts panel (Bell icon) */}
          {alertPanelOpen && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.75)",
                zIndex: 2100,
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "center",
                paddingTop: "calc(env(safe-area-inset-top, 0px) + 24px)",
                paddingBottom: "24px",
                paddingLeft: "16px",
                paddingRight: "16px",
                overflowY: "auto",
              }}
              onClick={() => setAlertPanelOpen(false)}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: T.cardElev,
                  border: `1px solid ${T.border}`,
                  borderRadius: 4,
                  padding: 20,
                  maxWidth: 460,
                  width: "100%",
                }}
              >
                {(() => {
                  const todayISO = localTodayISO();
                  const displayed = alertLog.slice(0, ALERT_DISPLAY_COUNT);
                  const groups = groupAlertsByDate(displayed);
                  const hasUnread = alertLog.some((a) => !a.read);
                  return (
                    <>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 16,
                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 10,
                            letterSpacing: "0.2em",
                            color: T.gold,
                            textTransform: "uppercase",
                          }}
                        >
                          Alerts
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {hasUnread && (
                            <button
                              onClick={markAllAlertsRead}
                              style={{
                                background: "transparent",
                                border: `1px solid ${T.border}`,
                                color: T.textDim,
                                cursor: "pointer",
                                padding: "4px 8px",
                                borderRadius: 3,
                                fontFamily: FONT_MONO,
                                fontSize: 9,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                              }}
                            >
                              Mark all read
                            </button>
                          )}
                          <button
                            onClick={() => setAlertPanelOpen(false)}
                            style={{
                              background: "transparent",
                              border: "none",
                              color: T.textDim,
                              cursor: "pointer",
                              padding: 4,
                            }}
                          >
                            <X size={16} />
                          </button>
                        </div>
                      </div>

                      {pendingSplits.length === 0 && alertLog.length === 0 ? (
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 12,
                            color: T.textDim,
                            padding: "24px 8px",
                            textAlign: "center",
                            lineHeight: 1.5,
                          }}
                        >
                          No alerts — all clear.
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                          {pendingSplits.length > 0 && (
                            <button
                              onClick={() => {
                                setActiveView("transactions");
                                setAlertPanelOpen(false);
                              }}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                padding: "12px 14px",
                                background: "rgba(201,169,97,0.08)",
                                border: `1px solid ${T.gold}44`,
                                borderRadius: 4,
                                cursor: "pointer",
                                textAlign: "left",
                                width: "100%",
                              }}
                            >
                              <AlertCircle size={14} style={{ color: T.gold, flexShrink: 0 }} />
                              <div>
                                <div
                                  style={{
                                    fontFamily: FONT_MONO,
                                    fontSize: 11,
                                    color: T.gold,
                                    letterSpacing: "0.08em",
                                  }}
                                >
                                  {pendingSplits.length} split/grouping{pendingSplits.length !== 1 ? "s" : ""} pending review
                                </div>
                                <div
                                  style={{
                                    fontFamily: FONT_MONO,
                                    fontSize: 9,
                                    color: T.textFaint,
                                    marginTop: 3,
                                    letterSpacing: "0.1em",
                                    textTransform: "uppercase",
                                  }}
                                >
                                  Review in Transactions tab →
                                </div>
                              </div>
                            </button>
                          )}

                          {groups.map((group) => (
                            <div key={group.date}>
                              <div
                                style={{
                                  fontFamily: FONT_MONO,
                                  fontSize: 9,
                                  letterSpacing: "0.15em",
                                  textTransform: "uppercase",
                                  color: T.textFaint,
                                  marginBottom: 8,
                                }}
                              >
                                {formatAlertDate(group.date, todayISO)}
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                {group.items.map((a) => {
                                  const isDividend = a.type === "dividend";
                                  const isEarnings = a.type === "earnings";
                                  const color = isDividend ? T.green : isEarnings ? "#a978a9" : T.red;
                                  const bgColor = a.read
                                    ? "transparent"
                                    : isDividend
                                    ? "rgba(125,211,164,0.06)"
                                    : isEarnings
                                    ? "rgba(169,120,169,0.06)"
                                    : T.redBg;
                                  const bdColor = a.read
                                    ? T.borderSoft
                                    : isDividend
                                    ? T.green + "33"
                                    : isEarnings
                                    ? "#a978a944"
                                    : T.red + "33";
                                  const icon = isDividend ? (
                                    <Wallet size={14} style={{ color, flexShrink: 0, opacity: a.read ? 0.5 : 1 }} />
                                  ) : isEarnings ? (
                                    <TrendingUp size={14} style={{ color, flexShrink: 0, opacity: a.read ? 0.5 : 1 }} />
                                  ) : (
                                    <AlertCircle size={14} style={{ color, flexShrink: 0, opacity: a.read ? 0.5 : 1 }} />
                                  );
                                  return (
                                    <div
                                      key={a.id}
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 12,
                                        padding: "12px 14px",
                                        background: bgColor,
                                        border: `1px solid ${bdColor}`,
                                        borderRadius: 4,
                                        opacity: a.read ? 0.6 : 1,
                                      }}
                                    >
                                      {icon}
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <span style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600, color: T.text }}>
                                          {a.ticker}
                                        </span>
                                        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color, marginLeft: 8 }}>
                                          {isDividend && a.total > 0
                                            ? `Dividend paid: ${maskMoney(a.total, valuesHidden)}`
                                            : a.message}
                                        </span>
                                        {a.detail && (
                                          <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: T.textFaint, marginTop: 2 }}>
                                            {isDividend && a.total > 0 && valuesHidden
                                              ? `${fmtNum(a.qtyHeld)} sh`
                                              : a.detail}
                                          </div>
                                        )}
                                      </div>
                                      {a.read ? (
                                        <span
                                          style={{
                                            fontFamily: FONT_MONO,
                                            fontSize: 8,
                                            letterSpacing: "0.12em",
                                            textTransform: "uppercase",
                                            color: T.textFaint,
                                            flexShrink: 0,
                                          }}
                                        >
                                          Read
                                        </span>
                                      ) : (
                                        <button
                                          onClick={() => markAlertRead(a.id)}
                                          title="Mark as read"
                                          style={{
                                            background: "transparent",
                                            border: "none",
                                            color: T.textDim,
                                            cursor: "pointer",
                                            padding: 2,
                                            display: "flex",
                                            alignItems: "center",
                                            flexShrink: 0,
                                          }}
                                        >
                                          <CheckCircle2 size={15} />
                                        </button>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Toast notification (fixed at bottom) */}
          {toast && (
            <div
              style={{
                position: "fixed",
                bottom: `calc(20px + env(safe-area-inset-bottom, 0px))`,
                left: "50%",
                transform: "translateX(-50%)",
                background:
                  toast.kind === "success"
                    ? "#1a2e22"
                    : toast.kind === "error"
                    ? "#2e1a1a"
                    : T.cardElev,
                border: `1px solid ${
                  toast.kind === "success"
                    ? T.green
                    : toast.kind === "error"
                    ? T.red
                    : T.gold
                }55`,
                color:
                  toast.kind === "success"
                    ? T.green
                    : toast.kind === "error"
                    ? T.red
                    : T.text,
                padding: "10px 16px",
                borderRadius: 4,
                fontFamily: FONT_MONO,
                fontSize: 12,
                letterSpacing: "0.04em",
                display: "flex",
                alignItems: "center",
                gap: 8,
                boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                zIndex: 1000,
                maxWidth: "calc(100% - 32px)",
              }}
            >
              {toast.kind === "info" && <RefreshCw size={13} className="spin" />}
              {toast.kind === "success" && <CheckCircle2 size={13} />}
              {toast.kind === "error" && <AlertCircle size={13} />}
              <span>{toast.message}</span>
              {toast.kind !== "info" && (
                <button
                  onClick={() => setToast(null)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "inherit",
                    opacity: 0.6,
                    padding: 0,
                    marginLeft: 6,
                    display: "flex",
                    alignItems: "center",
                  }}
                  aria-label="Dismiss"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          {/* Masthead */}
          <header style={{ marginBottom: 28 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginBottom: 4,
              }}
            >
              <div style={{ display: "flex", gap: 6 }}>
                {/* App version (package.json "version", format v0.0.0),
                    injected by Vite at build time. Bump the version on every
                    deploy so this number always identifies what's live —
                    see docs/CONTEXT.md "Versionamento". */}
                <span
                  title="App version — bumped on every deploy"
                  style={{
                    alignSelf: "center",
                    marginRight: 4,
                    fontFamily: FONT_MONO,
                    fontSize: 9,
                    letterSpacing: "0.08em",
                    color: T.textFaint,
                    whiteSpace: "nowrap",
                  }}
                >
                  {__APP_VERSION__}
                </span>
                <button
                  onClick={refreshAll}
                  disabled={refreshing || holdings.length === 0}
                  style={{
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    color: T.textDim,
                    padding: "6px 10px",
                    fontSize: 11,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <RefreshCw size={11} className={refreshing ? "spin" : ""} />
                  {refreshing ? "Refreshing" : "Refresh all"}
                </button>
                <button
                  onClick={() => setValuesHidden((v) => !v)}
                  title={valuesHidden ? "Show values" : "Hide values"}
                  style={{
                    background: valuesHidden ? "rgba(201, 169, 97, 0.12)" : "transparent",
                    border: `1px solid ${valuesHidden ? T.gold : T.border}`,
                    color: valuesHidden ? T.gold : T.textDim,
                    padding: "6px 8px",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  {valuesHidden ? <EyeOff size={11} /> : <Eye size={11} />}
                </button>
                <button
                  onClick={() => setAlertPanelOpen(true)}
                  title={
                    alertBadgeCount > 0
                      ? `${alertBadgeCount} alert${alertBadgeCount === 1 ? "" : "s"}`
                      : "Alerts — none"
                  }
                  style={{
                    position: "relative",
                    background: alertBadgeCount > 0 ? "rgba(201, 169, 97, 0.12)" : "transparent",
                    border: `1px solid ${alertBadgeCount > 0 ? T.gold : T.border}`,
                    color: alertBadgeCount > 0 ? T.gold : T.textDim,
                    padding: "6px 8px",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <Bell size={11} />
                  {alertBadgeCount > 0 && (
                    <span
                      style={{
                        position: "absolute",
                        top: -6,
                        right: -6,
                        minWidth: 15,
                        height: 15,
                        padding: "0 3px",
                        boxSizing: "border-box",
                        borderRadius: 8,
                        background: T.gold,
                        color: "#0b0d10",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 9,
                        fontWeight: 700,
                        lineHeight: "15px",
                        textAlign: "center",
                      }}
                    >
                      {alertBadgeCount}
                    </span>
                  )}
                </button>
                <SyncIndicator state={syncState} lastSavedAt={lastSavedAt} />
                {auth?.kind === "google" && auth?.picture && (
                  <img
                    src={auth.picture}
                    alt={auth.name || auth.email}
                    title={auth.email}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      border: `1px solid ${T.border}`,
                    }}
                  />
                )}
                <button
                  onClick={onLogout}
                  title={auth?.email ? `Sign out (${auth.email})` : "Sign out"}
                  style={{
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    color: T.textDim,
                    padding: "6px 8px",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <LogOut size={11} />
                </button>
              </div>
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.2em",
                color: T.gold,
                textTransform: "uppercase",
                marginTop: 6,
                textAlign: "right",
              }}
            >
              Last Refreshed · {(() => {
                const times = holdings
                  .map((h) => h.lastUpdated)
                  .filter(Boolean)
                  .map((t) => new Date(t).getTime())
                  .filter((n) => !isNaN(n));
                if (times.length === 0) return "—";
                const d = new Date(Math.max(...times));
                return d.toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                });
              })()}
            </div>
            <h1
              style={{
                fontFamily: FONT_DISPLAY,
                fontWeight: 500,
                fontSize: 44,
                lineHeight: 1,
                margin: "12px 0 4px",
                letterSpacing: "-0.02em",
                fontStyle: "italic",
              }}
            >
              {activeView === "transactions"
                ? "Transactions"
                : activeView === "performance"
                ? "Performance"
                : activeView === "dividends"
                ? "Dividends"
                : activeView === "events"
                ? "Events"
                : activeView === "aporte"
                ? "Contributions"
                : "Holdings"}
            </h1>
            {/* View switcher */}
            <div
              style={{
                display: "flex",
                gap: 18,
                marginTop: 14,
                borderBottom: `1px solid ${T.border}`,
                overflowX: "auto",
                overflowY: "hidden",
                touchAction: "pan-x",
                WebkitOverflowScrolling: "touch",
                scrollbarWidth: "none",
                msOverflowStyle: "none",
              }}
            >
              {[
                { id: "dashboard", label: "Holdings" },
                { id: "performance", label: "Performance" },
                { id: "dividends", label: "Dividends" },
                { id: "events", label: "Events" },
                { id: "transactions", label: "Transactions" },
                { id: "aporte", label: "Contributions" },
              ].map((tab) => {
                const active = activeView === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveView(tab.id)}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: "8px 0",
                      cursor: "pointer",
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      color: active ? T.gold : T.textDim,
                      borderBottom: active
                        ? `1px solid ${T.gold}`
                        : "1px solid transparent",
                      marginBottom: -1,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </header>

          {activeView === "transactions" && (
            <TransactionsView
              auth={auth}
              onAuthFail={onAuthFail}
              valuesHidden={valuesHidden}
              knownTickers={Array.from(
                new Set(
                  holdings
                    .map((h) => h && h.ticker)
                    .filter(Boolean)
                    .map((t) => String(t).toUpperCase())
                )
              ).sort()}
              onTransactionsChange={handleTransactionsChange}
              pendingSplits={pendingSplits}
              splitEvents={splitEvents}
              splitActionInFlight={splitActionInFlight}
              onApproveSplit={approveSplit}
              onDismissSplit={dismissSplit}
              holdings={holdings}
              onApproveFidelityBalance={applyFidelityBalanceUpdate}
            />
          )}

          {activeView === "performance" && (
            <Suspense
              fallback={
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    color: "#8a8f99",
                    padding: "40px 0",
                    textAlign: "center",
                  }}
                >
                  Loading…
                </div>
              }
            >
              <PerformanceView auth={auth} onAuthFail={onAuthFail} valuesHidden={valuesHidden} holdings={holdings} />
            </Suspense>
          )}

          {activeView === "dividends" && (
            <Suspense
              fallback={
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    color: "#8a8f99",
                    padding: "40px 0",
                    textAlign: "center",
                  }}
                >
                  Loading…
                </div>
              }
            >
              <DividendsView auth={auth} onAuthFail={onAuthFail} valuesHidden={valuesHidden} />
            </Suspense>
          )}

          {activeView === "events" && (
            <Suspense
              fallback={
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    color: "#8a8f99",
                    padding: "40px 0",
                    textAlign: "center",
                  }}
                >
                  Loading...
                </div>
              }
            >
              <EventsView auth={auth} onAuthFail={onAuthFail} valuesHidden={valuesHidden} />
            </Suspense>
          )}

          {activeView === "aporte" && (
            <Suspense
              fallback={
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    color: "#8a8f99",
                    padding: "40px 0",
                    textAlign: "center",
                  }}
                >
                  Loading…
                </div>
              }
            >
              <AporteQuinzenalView auth={auth} onAuthFail={onAuthFail} valuesHidden={valuesHidden} />
            </Suspense>
          )}

          {activeView === "dashboard" && (
          <>
          {/* Total value card */}
          <section
            style={{
              background: T.card,
              border: `1px solid ${T.borderSoft}`,
              borderRadius: 4,
              padding: "22px 22px 20px",
              marginBottom: 20,
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: 2,
                background: `linear-gradient(to right, ${T.gold}, transparent)`,
              }}
            />
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.18em",
                color: T.textDim,
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Total Value
            </div>
            <div
              style={{
                fontFamily: FONT_DISPLAY,
                fontSize: windowWidth >= 1024 ? 44 : 38,
                fontWeight: 500,
                letterSpacing: "-0.02em",
                lineHeight: 1.05,
                color: T.text,
              }}
            >
              {maskMoney(totalValue, valuesHidden)}
            </div>
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: T.textDim,
                display: "flex",
                gap: 14,
                fontFamily: FONT_MONO,
              }}
            >
              <span>{holdings.length} {holdings.length === 1 ? "position" : "positions"}</span>
              {totalTarget > 0 && (
                <span>
                  Target alloc: <span style={{ color: T.text }}>{fmtPct(totalTarget)}</span>
                  {Math.abs(totalTarget - 100) > 0.1 && (
                    <span style={{ color: T.gold, marginLeft: 6 }}>
                      ({totalTarget > 100 ? "+" : ""}{(totalTarget - 100).toFixed(1)} from 100)
                    </span>
                  )}
                </span>
              )}
            </div>
          </section>

          {/* Allocation chart (single column) */}
          {(() => {
            const showAlloc = chartData.targetSlices.length > 0 || chartData.actualSlices.length > 0;
            return (
              <div style={{ display: "block" }}>
                {/* Allocation charts: Target vs Actual */}
                {showAlloc && (
                  <section
                    style={{
                      background: T.card,
                      border: `1px solid ${T.borderSoft}`,
                      borderRadius: 4,
                      padding: 16,
                      marginBottom: 20,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 14,
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          letterSpacing: "0.18em",
                          color: T.textDim,
                          textTransform: "uppercase",
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        Allocation
                        {chartData.portfolioDayChange != null && (
                          <span
                            style={{
                              textTransform: "none",
                              letterSpacing: "0.04em",
                              fontSize: 11,
                              color:
                                chartData.portfolioDayChange > 0
                                  ? T.green
                                  : chartData.portfolioDayChange < 0
                                  ? T.red
                                  : T.textDim,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 3,
                            }}
                          >
                            {chartData.portfolioDayChange > 0 ? (
                              <TrendingUp size={10} strokeWidth={2.5} />
                            ) : chartData.portfolioDayChange < 0 ? (
                              <TrendingDown size={10} strokeWidth={2.5} />
                            ) : (
                              <Minus size={10} strokeWidth={2.5} />
                            )}
                            {chartData.portfolioDayChange > 0 ? "+" : ""}
                            {chartData.portfolioDayChange.toFixed(2)}%
                          </span>
                        )}
                        {sp500 && sp500.dayChangePct != null && (
                          <span
                            style={{
                              textTransform: "none",
                              letterSpacing: "0.04em",
                              fontSize: 11,
                              color: T.textDim,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              paddingLeft: 8,
                              borderLeft: `1px solid ${T.borderSoft}`,
                            }}
                          >
                            <span style={{ color: T.textFaint, fontSize: 9, letterSpacing: "0.1em" }}>
                              S&P
                            </span>
                            <span
                              style={{
                                color:
                                  sp500.dayChangePct > 0
                                    ? T.green
                                    : sp500.dayChangePct < 0
                                    ? T.red
                                    : T.textDim,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              {sp500.dayChangePct > 0 ? (
                                <TrendingUp size={10} strokeWidth={2.5} />
                              ) : sp500.dayChangePct < 0 ? (
                                <TrendingDown size={10} strokeWidth={2.5} />
                              ) : (
                                <Minus size={10} strokeWidth={2.5} />
                              )}
                              {sp500.dayChangePct > 0 ? "+" : ""}
                              {sp500.dayChangePct.toFixed(2)}%
                            </span>
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        <ToggleButton
                          active={chartGrouping === "class"}
                          onClick={() => setChartGrouping("class")}
                          label="By class"
                        />
                        <ToggleButton
                          active={chartGrouping === "holding"}
                          onClick={() => setChartGrouping("holding")}
                          label="Per holding"
                        />
                      </div>
                    </div>

                    {(() => {
                      // Responsive donut size: clamp [140, 220] based on available section width.
                      // Below 640px (mobile) the clamp floor of 140 ensures no regression.
                      const w = Math.min(windowWidth, 1200);
                      const containerW = w - 32; // outer padding 16px each side
                      const allocSectionW = containerW - 32;
                      const colW = (allocSectionW - 12) / 2; // gap between the two donuts
                      const donutSize = Math.round(Math.min(Math.max(colW * 0.75, 140), 220));
                      return (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 12,
                            marginBottom: 14,
                          }}
                        >
                          <DonutChart
                            size={donutSize}
                            slices={chartData.targetSlices}
                            centerLabel="Target"
                            centerValue={
                              chartData.totalTarget < 99.5
                                ? fmtPct(chartData.totalTarget)
                                : "100%"
                            }
                            valuesHidden={valuesHidden}
                          />
                          <DonutChart
                            size={donutSize}
                            slices={chartData.actualSlices}
                            centerLabel="Actual"
                            centerValue={maskMoney(chartData.totalActualValue, valuesHidden, { short: true })}
                            valuesHidden={valuesHidden}
                          />
                        </div>
                      );
                    })()}

                    {/* Shared legend */}
                    <ChartLegend
                      colorMap={chartData.colorMap}
                      targetSlices={chartData.targetSlices}
                      actualSlices={chartData.actualSlices}
                      dayChangeMap={chartData.dayChangeMap}
                    />
                  </section>
                )}
              </div>
            );
          })()}


          {/* Holdings */}
          {holdings.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "40px 20px",
                color: T.textFaint,
                fontStyle: "italic",
                fontFamily: FONT_DISPLAY,
                fontSize: 16,
              }}
            >
              No positions yet. Add transactions in the Transactions tab to get started.
            </div>
          ) : (
            <>
              {/* Portfolio Map — treemap of holdings (lazy: keeps recharts out
                  of main bundle). Sits right below the main holdings block,
                  above Filters & Sort (user request, jul/2026). */}
              <section style={{ marginTop: 18 }}>
                <button
                  onClick={() => setShowTreemap(!showTreemap)}
                  style={{
                    width: "100%",
                    background: T.card,
                    border: `1px solid ${T.borderSoft}`,
                    borderRadius: 4,
                    padding: "14px 16px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    color: T.text,
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
                    <LayoutGrid size={14} strokeWidth={2} />
                    Portfolio Map
                  </span>
                  <ChevronDown
                    size={16}
                    style={{
                      color: T.textDim,
                      transform: showTreemap ? "rotate(180deg)" : "none",
                      transition: "transform 0.2s",
                    }}
                  />
                </button>

                {showTreemap && (
                  <div
                    className="card-enter"
                    style={{
                      background: T.card,
                      border: `1px solid ${T.borderSoft}`,
                      borderTop: "none",
                      borderRadius: "0 0 4px 4px",
                      padding: 16,
                      marginTop: -1,
                    }}
                  >
                    <Suspense
                      fallback={
                        <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.textDim, padding: "24px 0", textAlign: "center" }}>
                          Loading map…
                        </div>
                      }
                    >
                      {/* Full holdings list (not filteredHoldings): the map should
                          show the whole portfolio, including Cash — zero-value
                          holdings are dropped inside the component. */}
                      <TreemapCard
                        holdings={holdings}
                        usdBrlRate={usdBrlRate}
                        valuesHidden={valuesHidden}
                      />
                    </Suspense>
                  </div>
                )}
              </section>

              {/* Filters & Sort — own card */}
              <section
                style={{
                  marginTop: 18,
                  background: T.card,
                  border: `1px solid ${T.borderSoft}`,
                  borderRadius: 4,
                  padding: 12,
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: T.textDim,
                    marginBottom: 10,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Search size={11} />
                  Filters & Sort
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
              >
                <div
                  style={{
                    flex: "1 1 140px",
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <Search
                    size={12}
                    style={{
                      position: "absolute",
                      left: 10,
                      color: T.textFaint,
                      pointerEvents: "none",
                    }}
                  />
                  <input
                    placeholder="Filter by ticker or name"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    style={{
                      background: T.cardElev,
                      border: `1px solid ${T.border}`,
                      color: T.text,
                      padding: "8px 10px 8px 28px",
                      fontSize: 12,
                      fontFamily: FONT_MONO,
                      borderRadius: 2,
                      width: "100%",
                    }}
                  />
                </div>
                <select
                  value={filterClass}
                  onChange={(e) => setFilterClass(e.target.value)}
                  style={{
                    background: T.cardElev,
                    border: `1px solid ${T.border}`,
                    color: filterClass ? T.text : T.textFaint,
                    padding: "8px 10px",
                    fontSize: 11,
                    fontFamily: FONT_MONO,
                    borderRadius: 2,
                    flex: "1 1 110px",
                    minWidth: 110,
                  }}
                >
                  <option value="">All classes</option>
                  {assetClassOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  style={{
                    background: T.cardElev,
                    border: `1px solid ${T.border}`,
                    color: sortBy !== "default" ? T.text : T.textFaint,
                    padding: "8px 10px",
                    fontSize: 11,
                    fontFamily: FONT_MONO,
                    borderRadius: 2,
                    flex: "1 1 110px",
                    minWidth: 110,
                  }}
                >
                  <option value="gap_desc">Underweight → Overweight</option>
                  <option value="gap">Overweight → Underweight</option>
                  <option value="value_desc">Value high→low</option>
                  <option value="value">Value low→high</option>
                  <option value="name">Name A→Z</option>
                  <option value="name_desc">Name Z→A</option>
                  <option value="default">Insertion order</option>
                </select>
                {hasActiveFilter && (
                  <button
                    onClick={() => {
                      setFilterText("");
                      setFilterClass("");
                      setSortBy("gap_desc");
                    }}
                    title="Clear filters"
                    style={{
                      background: "transparent",
                      border: `1px solid ${T.border}`,
                      color: T.textDim,
                      padding: "8px 10px",
                      borderRadius: 2,
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
                </div>
              </section>

              {/* Consolidated holdings (auto + manual non-cash) */}
              {filteredHoldings.length > 0 && (
                <>
                  <SectionLabel
                    label="Holdings"
                    count={filteredHoldings.length}
                    of={holdings.filter((h) => !isCash(h) && !(isZeroHolding(h) && !(h.target > 0))).length}
                    collapsible
                    collapsed={trackedCollapsed}
                    onToggle={() => setTrackedCollapsed(!trackedCollapsed)}
                  />
                  {!trackedCollapsed && (
                    <div style={{ background: T.card, border: `1px solid ${T.borderSoft}`, borderRadius: 4 }}>
                      {filteredHoldings.map((h, i) => (
                        <div key={h.id} style={i > 0 ? { borderTop: `1px solid ${T.borderSoft}` } : {}}>
                          {h.type === "manual" ? (
                            <ManualHoldingRow
                              holding={h}
                              usdBrlRate={usdBrlRate}
                              totalValue={totalValue}
                              valuesHidden={valuesHidden}
                              deltaColor={deltaColorMap.get(h.id) ?? T.textDim}
                              onUpdate={(patch) => updateManualHolding(h.id, patch)}
                              onRemove={() => removeHolding(h.id)}
                              onRefresh={h.id === BANK_BONDS_ID ? refreshBankBondsFromSimplefin : undefined}
                              busy={h.id === BANK_BONDS_ID ? !!busyIds[BANK_BONDS_ID] : false}
                            />
                          ) : (
                            <HoldingRow
                              holding={h}
                              totalValue={totalValue}
                              busy={!!busyIds[h.id]}
                              valuesHidden={valuesHidden}
                              deltaColor={deltaColorMap.get(h.id) ?? T.textDim}
                              onRefresh={() => refreshOne(h.id, h.ticker)}
                              onUpdate={(patch) => updateHolding(h.id, patch)}
                              editingClass={editingClassId === h.id}
                              editingClassValue={editingClassValue}
                              onEditClass={() => {
                                setEditingClassId(h.id);
                                setEditingClassValue(h.assetClassOverride || h.assetClass || "");
                              }}
                              onSaveClass={() => saveAssetClass(h.id)}
                              onCancelEditClass={() => {
                                setEditingClassId(null);
                                setEditingClassValue("");
                              }}
                              onChangeEditClassValue={setEditingClassValue}
                              fromCSVImport={!!h.fromCSVImport}
                              hasTransactions={transactions.some((tx) => (tx.ticker || "").toUpperCase() === (h.ticker || "").toUpperCase())}
                              onRemove={() => removeHolding(h.id)}
                              onAssetClassChange={(cls) => updateHolding(h.id, { assetClass: cls })}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Cash accounts — always visible; permanent Cash row is locked */}
              <SectionLabel
                label="Cash"
                count={cashAccounts.length}
                icon={<Wallet size={11} />}
                collapsible
                collapsed={cashCollapsed}
                onToggle={() => setCashCollapsed(!cashCollapsed)}
              />
              {!cashCollapsed && (
                <div style={{ background: T.card, border: `1px solid ${T.borderSoft}`, borderRadius: 4 }}>
                  {cashAccounts.map((h, i) => (
                    <div key={h.id} style={i > 0 ? { borderTop: `1px solid ${T.borderSoft}` } : {}}>
                      <ManualHoldingRow
                        holding={h}
                        totalValue={totalValue}
                        valuesHidden={valuesHidden}
                        deltaColor={deltaColorMap.get(h.id) ?? T.textDim}
                        onUpdate={(patch) => updateManualHolding(h.id, patch)}
                        onRemove={() => removeHolding(h.id)}
                        locked={h.id === CASH_ID}
                        valueLocked={h.id === CASH_ID && isAdmin}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* No results from filter */}
              {filteredHoldings.length === 0 && cashAccounts.filter((c) => c.id !== CASH_ID).length === 0 && (
                <div
                  style={{
                    textAlign: "center",
                    padding: "30px 20px",
                    color: T.textFaint,
                    fontStyle: "italic",
                    fontFamily: FONT_DISPLAY,
                    fontSize: 14,
                  }}
                >
                  No holdings match your filter.
                </div>
              )}
            </>
          )}

          {/* Import Allocation Targets — moved out of Holdings card */}
          <section
            style={{
              marginTop: 18,
              background: T.card,
              border: `1px solid ${T.borderSoft}`,
              borderRadius: 4,
              padding: 14,
            }}
          >
            <button
              onClick={() => { setShowCSVImport(true); setCsvImportStep("upload"); setCsvImportRows([]); }}
              style={{
                background: "transparent",
                border: "none",
                color: T.gold,
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: 0,
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              <Upload size={12} />
              Import Allocation Targets
            </button>
          </section>

          {/* Add manual asset section */}
          <section
            style={{
              marginTop: 18,
              background: T.card,
              border: `1px solid ${T.borderSoft}`,
              borderRadius: 4,
              padding: 14,
            }}
          >
            <button
              onClick={() => setShowManualForm(!showManualForm)}
              style={{
                background: "transparent",
                border: "none",
                color: T.text,
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: 0,
              }}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: T.gold,
                }}
              >
                <Plus size={12} />
                Add Manual Asset
              </span>
              <ChevronDown
                size={14}
                style={{
                  color: T.textDim,
                  transform: showManualForm ? "rotate(180deg)" : "none",
                  transition: "transform 0.2s",
                }}
              />
            </button>

            {showManualForm && (
              <div style={{ marginTop: 14 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: T.textDim,
                    fontFamily: FONT_MONO,
                    marginBottom: 8,
                    lineHeight: 1.5,
                  }}
                >
                  For assets without a public ticker (Cash, Bonds, Tesouro SELIC, Tesouro IPCA, etc.). Price won't auto-update.
                </div>

                {/* Mode toggle */}
                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  <ModeButton
                    active={manualMode === "value"}
                    onClick={() => setManualMode("value")}
                    label="Total value"
                  />
                  <ModeButton
                    active={manualMode === "qty_price"}
                    onClick={() => setManualMode("qty_price")}
                    label="Qty × price"
                  />
                </div>

                <Input
                  placeholder="Name (e.g. Cash, Tesouro SELIC)"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  style={{ marginBottom: 8 }}
                />

                {manualMode === "value" ? (
                  <div style={{ marginBottom: 8 }}>
                    <Input
                      placeholder={
                        manualClass.trim().toLowerCase() === "bra fixed income" &&
                        manualCurrency === "BRL"
                          ? "Value in BRL (e.g. Nubank balance)"
                          : "Current value (e.g. 5000)"
                      }
                      value={manualValueInput}
                      onChange={(e) => setManualValueInput(e.target.value)}
                      inputMode="decimal"
                    />
                    {manualClass.trim().toLowerCase() === "bra fixed income" && (
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        {["USD", "BRL"].map((c) => {
                          const active = manualCurrency === c;
                          return (
                            <button
                              key={c}
                              type="button"
                              onClick={() => setManualCurrency(c)}
                              style={{
                                flex: 1,
                                background: active ? T.gold : "transparent",
                                color: active ? T.bg : T.textDim,
                                border: `1px solid ${active ? T.gold : T.border}`,
                                padding: "6px 8px",
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: "0.1em",
                                borderRadius: 2,
                                fontFamily: FONT_MONO,
                                cursor: "pointer",
                              }}
                            >
                              {c === "BRL" ? "R$ BRL" : "$ USD"}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <Input
                      placeholder="Quantity"
                      value={manualQty}
                      onChange={(e) => setManualQty(e.target.value)}
                      inputMode="decimal"
                    />
                    <Input
                      placeholder="Price"
                      value={manualPriceInput}
                      onChange={(e) => setManualPriceInput(e.target.value)}
                      inputMode="decimal"
                    />
                  </div>
                )}

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  <Input
                    placeholder="Target % (e.g. 5.5)"
                    value={manualTarget}
                    onChange={(e) => setManualTarget(e.target.value)}
                    inputMode="decimal"
                  />
                  <Input
                    placeholder="Class (e.g. Cash)"
                    value={manualClass}
                    onChange={(e) => setManualClass(e.target.value)}
                  />
                </div>

                <button
                  onClick={addManualHolding}
                  style={{
                    width: "100%",
                    background: T.gold,
                    color: T.bg,
                    border: "none",
                    padding: "11px 16px",
                    fontWeight: 600,
                    fontSize: 12,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    fontFamily: FONT_BODY,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    borderRadius: 2,
                  }}
                >
                  <Plus size={14} strokeWidth={2.5} />
                  Add manual asset
                </button>
                {manualFormError && (
                  <div
                    style={{
                      marginTop: 10,
                      fontSize: 12,
                      color: T.red,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <AlertCircle size={12} />
                    {manualFormError}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Rebalance Suggestion — placed below Add Manual Asset */}
          {holdings.some((h) => h.target > 0) && (
            <section style={{ marginTop: 18 }}>
              <button
                onClick={() => setShowRebalance(!showRebalance)}
                style={{
                  width: "100%",
                  background: T.card,
                  border: `1px solid ${T.borderSoft}`,
                  borderRadius: 4,
                  padding: "14px 16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  color: T.text,
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
                  <Scale size={14} strokeWidth={2} />
                  Rebalance Suggestion
                </span>
                <ChevronDown
                  size={16}
                  style={{
                    color: T.textDim,
                    transform: showRebalance ? "rotate(180deg)" : "none",
                    transition: "transform 0.2s",
                  }}
                />
              </button>

              {showRebalance && (
                <div
                  className="card-enter"
                  style={{
                    background: T.card,
                    border: `1px solid ${T.borderSoft}`,
                    borderTop: "none",
                    borderRadius: "0 0 4px 4px",
                    padding: 16,
                    marginTop: -1,
                  }}
                >
                  {/* New cash input */}
                  <div style={{ marginBottom: 16 }}>
                    <label
                      style={{
                        display: "block",
                        fontSize: 10,
                        letterSpacing: "0.18em",
                        textTransform: "uppercase",
                        color: T.textDim,
                        fontFamily: FONT_MONO,
                        marginBottom: 6,
                      }}
                    >
                      New cash to deploy <span style={{ color: T.textFaint }}>(optional)</span>
                    </label>
                    <Input
                      placeholder="0.00"
                      value={newCash}
                      onChange={(e) => setNewCash(e.target.value)}
                      inputMode="decimal"
                    />
                    <div
                      style={{
                        fontSize: 11,
                        color: T.textFaint,
                        fontFamily: FONT_MONO,
                        marginTop: 6,
                        lineHeight: 1.4,
                      }}
                    >
                      Suggestions are buys only, integer shares, capped at ${PER_ASSET_CAP.toLocaleString()} per asset. If cash is set, total purchases stay within it (most underweight first).
                    </div>
                  </div>

                  {/* Rebalance rows */}
                  {rebalance.length === 0 ? (
                    <div
                      style={{
                        background: T.cardElev,
                        borderRadius: 2,
                        padding: "16px",
                        textAlign: "center",
                        fontSize: 12,
                        color: T.textDim,
                        fontFamily: FONT_DISPLAY,
                        fontStyle: "italic",
                      }}
                    >
                      Nothing to buy — you're at or above target on every holding.
                    </div>
                  ) : (
                    <>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 1,
                          background: T.borderSoft,
                          border: `1px solid ${T.borderSoft}`,
                          borderRadius: 2,
                          overflow: "hidden",
                        }}
                      >
                        {rebalance.map((r) => (
                          <RebalanceRow key={r.holding.id} item={r} valuesHidden={valuesHidden} />
                        ))}
                      </div>

                      {/* Summary */}
                      <RebalanceSummary items={rebalance} newCash={parseFloat(newCash) || 0} valuesHidden={valuesHidden} />
                    </>
                  )}

                  {Math.abs(totalTarget - 100) > 0.5 && (
                    <div
                      style={{
                        marginTop: 12,
                        padding: "8px 10px",
                        fontSize: 11,
                        color: T.gold,
                        background: "rgba(201, 169, 97, 0.06)",
                        border: `1px solid ${T.goldDim}33`,
                        borderRadius: 2,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 6,
                        fontFamily: FONT_MONO,
                        lineHeight: 1.5,
                      }}
                    >
                      <AlertCircle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
                      <span>
                        Targets sum to {fmtPct(totalTarget)}, not 100%. Rebalance numbers
                        assume the targets you've set; cash may not be fully deployed.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Backup / restore */}
          <div
            style={{
              marginTop: 18,
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <input
              ref={importJsonRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importData(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={exportData}
              disabled={holdings.length === 0}
              style={{
                flex: 1,
                background: "transparent",
                border: `1px solid ${T.border}`,
                color: T.textDim,
                padding: "9px 12px",
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                fontFamily: FONT_BODY,
                fontWeight: 500,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                borderRadius: 2,
              }}
            >
              <Download size={12} />
              Export backup
            </button>
            <button
              onClick={() => importJsonRef.current?.click()}
              style={{
                flex: 1,
                background: "transparent",
                border: `1px solid ${T.border}`,
                color: T.textDim,
                padding: "9px 12px",
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                fontFamily: FONT_BODY,
                fontWeight: 500,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                borderRadius: 2,
              }}
            >
              <Upload size={12} />
              Restore backup
            </button>
          </div>

          {/* Manage Users — admin only */}
          {isAdmin && (
            <section
              style={{
                marginTop: 28,
                background: T.card,
                border: `1px solid ${T.borderSoft}`,
                borderRadius: 4,
                padding: "16px 18px",
              }}
            >
              <button
                onClick={() => setUsersOpen((v) => !v)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: T.text,
                  padding: 0,
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                }}
              >
                <span style={{ color: T.gold }}>Manage Users</span>
                <ChevronDown
                  size={14}
                  style={{
                    color: T.textDim,
                    transform: usersOpen ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.15s",
                  }}
                />
              </button>

              {usersOpen && (
                <div style={{ marginTop: 14 }}>
                  <div
                    style={{
                      fontSize: 11,
                      color: T.textDim,
                      fontFamily: FONT_MONO,
                      lineHeight: 1.5,
                      marginBottom: 12,
                    }}
                  >
                    Invite an email to the Redis allowlist. They also need to be
                    added as a Test User in Google Cloud Console while the app
                    is in Testing mode.
                  </div>

                  <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                    <Input
                      type="email"
                      placeholder="friend@gmail.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      onEnter={handleInvite}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                    <button
                      onClick={handleInvite}
                      disabled={inviteBusy || !inviteEmail.trim()}
                      style={{
                        background: T.gold,
                        border: `1px solid ${T.gold}`,
                        color: T.bg,
                        padding: "8px 14px",
                        fontSize: 11,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        fontFamily: FONT_BODY,
                        fontWeight: 600,
                        cursor: inviteBusy ? "wait" : "pointer",
                        opacity: inviteBusy || !inviteEmail.trim() ? 0.5 : 1,
                        borderRadius: 2,
                      }}
                    >
                      {inviteBusy ? "..." : "Invite"}
                    </button>
                  </div>

                  {usersError && (
                    <div
                      style={{
                        color: T.red,
                        fontSize: 11,
                        fontFamily: FONT_MONO,
                        marginBottom: 10,
                      }}
                    >
                      {usersError}
                    </div>
                  )}

                  {usersLoading ? (
                    <div
                      style={{
                        fontSize: 11,
                        color: T.textDim,
                        fontFamily: FONT_MONO,
                      }}
                    >
                      Loading users…
                    </div>
                  ) : usersList.length === 0 ? (
                    <div
                      style={{
                        fontSize: 11,
                        color: T.textFaint,
                        fontFamily: FONT_MONO,
                      }}
                    >
                      No users yet.
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      {usersList.map((u) => {
                        const roleLabel =
                          u.role === "admin"
                            ? "Admin"
                            : u.role === "env"
                            ? "Env"
                            : "Invited";
                        const roleColor =
                          u.role === "admin"
                            ? T.gold
                            : u.role === "env"
                            ? T.textDim
                            : T.green;
                        const removable = u.role === "invited";
                        return (
                          <div
                            key={u.email}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "8px 10px",
                              background: T.cardElev,
                              border: `1px solid ${T.borderSoft}`,
                              borderRadius: 2,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                minWidth: 0,
                              }}
                            >
                              <span
                                style={{
                                  fontFamily: FONT_MONO,
                                  fontSize: 11,
                                  color: roleColor,
                                  border: `1px solid ${roleColor}`,
                                  padding: "1px 6px",
                                  borderRadius: 2,
                                  letterSpacing: "0.05em",
                                  textTransform: "uppercase",
                                  flexShrink: 0,
                                }}
                              >
                                {roleLabel}
                              </span>
                              <span
                                style={{
                                  fontSize: 12,
                                  color: T.text,
                                  fontFamily: FONT_MONO,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {u.email}
                              </span>
                            </div>
                            {removable ? (
                              <button
                                onClick={() => handleRemoveUser(u.email)}
                                title={`Remove ${u.email}`}
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  color: T.textDim,
                                  padding: 4,
                                  cursor: "pointer",
                                  display: "flex",
                                  alignItems: "center",
                                }}
                              >
                                <Trash2 size={12} />
                              </button>
                            ) : (
                              <span style={{ width: 20 }} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {showCSVImport && (
            <AllocationCSVImportModal
              auth={auth}
              holdings={holdings}
              transactions={transactions}
              onClose={() => setShowCSVImport(false)}
              onApply={applyCSVImport}
            />
          )}

          </>
          )}

          <footer
            style={{
              marginTop: 36,
              fontSize: 10,
              color: T.textFaint,
              textAlign: "center",
              fontFamily: FONT_MONO,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            Prices via web search · Not investment advice
          </footer>
        </div>
      </div>
    </>
  );
}

function Input({ style, onEnter, ...props }) {
  return (
    <input
      {...props}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) onEnter();
      }}
      style={{
        background: T.cardElev,
        border: `1px solid ${T.border}`,
        color: T.text,
        padding: "10px 12px",
        fontSize: 14,
        fontFamily: FONT_MONO,
        borderRadius: 2,
        width: "100%",
        ...style,
      }}
    />
  );
}

function HoldingRow({
  holding,
  totalValue,
  busy,
  valuesHidden,
  deltaColor,
  onRefresh,
  onUpdate,
  editingClass,
  editingClassValue,
  onEditClass,
  onSaveClass,
  onCancelEditClass,
  onChangeEditClassValue,
  fromCSVImport,
  hasTransactions,
  onRemove,
  onAssetClassChange,
}) {
  const [editing, setEditing] = useState(false);
  const [draftTarget, setDraftTarget] = useState("");

  function startEdit() {
    setDraftTarget(holding.target != null ? String(holding.target) : "");
    setEditing(true);
  }

  function saveEdit() {
    const t = draftTarget === "" ? 0 : parseFloat(draftTarget);
    const patch = {};
    if (!isNaN(t) && t >= 0 && t <= 100) patch.target = t;
    onUpdate(patch);
    setEditing(false);
  }

  // Day change %
  const dayChangePct =
    holding.price != null && holding.previousClose != null && holding.previousClose !== 0
      ? ((holding.price - holding.previousClose) / holding.previousClose) * 100
      : null;
  const dayColor =
    dayChangePct == null
      ? T.textFaint
      : dayChangePct > 0
      ? T.green
      : dayChangePct < 0
      ? T.red
      : T.textDim;
  const value = holding.price ? holding.price * holding.qty : null;
  const actualPct = value && totalValue > 0 ? (value / totalValue) * 100 : null;
  const drift = actualPct != null && holding.target ? actualPct - holding.target : null;
  const driftUSD = drift != null && totalValue > 0 ? (drift / 100) * totalValue : null;

  const [driftOpen, setDriftOpen] = useState(false);

  return (
    <div className="card-enter" style={{ padding: "10px 14px" }}>
      {/* Line 1: ticker (tap to expand) | value + day change */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: 1 }}>
          <div style={{ flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setDriftOpen((o) => !o)}
              style={{
                background: "none",
                border: "none",
                padding: "6px 2px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 4,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.05em", color: T.text }}>
                {holding.ticker}
              </span>
              <ChevronDown
                size={11}
                style={{
                  color: T.textFaint,
                  transform: driftOpen ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.15s ease",
                }}
              />
            </button>
          </div>
          {holding.market === "B3" && (
            <span style={{ fontSize: 8, fontWeight: 600, letterSpacing: "0.1em", color: "#7898a9", background: "rgba(120,152,169,0.12)", border: "1px solid rgba(120,152,169,0.4)", padding: "1px 4px", borderRadius: 1, flexShrink: 0 }}>
              B3
            </span>
          )}
          {holding.name && (
            <span style={{ fontSize: 11, color: T.textDim, fontFamily: FONT_DISPLAY, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {holding.name}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
          {dayChangePct != null && (
            <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: dayColor, letterSpacing: "0.04em" }}>
              {dayChangePct > 0 ? "+" : ""}
              {dayChangePct.toFixed(2)}%
            </span>
          )}
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 15, fontWeight: 500, color: T.text, letterSpacing: "-0.01em" }}>
            {value != null ? maskMoney(value, valuesHidden) : busy ? "…" : "—"}
          </span>
        </div>
      </div>

      {/* Line 2: labeled qty · price · drift | edit + remove */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, overflow: "hidden" }}>
          <span style={{ fontSize: 11, color: T.textDim, fontFamily: FONT_MONO, flexShrink: 0 }}>
            <span style={{ fontSize: 9, color: T.textFaint, letterSpacing: "0.08em", textTransform: "uppercase" }}>Qty </span>
            {fmtNum(holding.qty)}
          </span>
          <span style={{ fontSize: 11, color: T.textDim, fontFamily: FONT_MONO, flexShrink: 0 }}>
            <span style={{ fontSize: 9, color: T.textFaint, letterSpacing: "0.08em", textTransform: "uppercase" }}>Price </span>
            {holding.price != null ? maskMoney(holding.price, valuesHidden) : "—"}
          </span>
          {drift != null && (
            <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: deltaColor, flexShrink: 0 }}>
              <span style={{ fontSize: 9, color: T.textFaint, letterSpacing: "0.08em", textTransform: "uppercase" }}>DELTA </span>
              {drift > 0 ? "+" : ""}{drift.toFixed(2)}%
            </span>
          )}
          {holding.error && (
            <span style={{ fontSize: 10, color: T.red, fontFamily: FONT_MONO, display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
              <AlertCircle size={9} />{holding.error}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 3, flexShrink: 0, alignItems: "center" }}>
          {fromCSVImport && onAssetClassChange && !hasTransactions && (
            <select
              value={holding.assetClass || ""}
              onChange={(e) => onAssetClassChange(e.target.value)}
              style={{
                background: T.cardElev,
                border: `1px solid ${T.border}`,
                color: T.text,
                padding: "3px 6px",
                fontSize: 10,
                fontFamily: FONT_MONO,
                borderRadius: 2,
              }}
            >
              {ASSET_CLASS_OPTIONS.filter((c) => c !== "Bank Bonds").map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
          <IconButton onClick={editing ? () => setEditing(false) : startEdit} label="Edit">
            <Pencil size={12} />
          </IconButton>
          {!hasTransactions && onRemove && (
            <IconButton onClick={onRemove} label="Remove" danger>
              <Trash2 size={12} />
            </IconButton>
          )}
        </div>
      </div>

      {/* Inline accordion expansion */}
      {driftOpen && (
        <div
          style={{
            background: T.cardElev,
            border: `1px solid ${T.border}`,
            borderRadius: 2,
            padding: "10px 12px",
            marginTop: 8,
          }}
        >
          {holding.target > 0 ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Actual</span>
                <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: T.gold }}>{fmtPct(actualPct)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Target</span>
                <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: T.text }}>{fmtPct(holding.target)}</span>
              </div>
              {driftUSD != null && (
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>DELTA</span>
                  <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: deltaColor }}>
                    {driftUSD > 0 ? "+" : ""}{maskMoney(driftUSD, valuesHidden)} ({drift > 0 ? "+" : ""}{drift.toFixed(2)}%)
                  </span>
                </div>
              )}
            </>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Allocated</span>
              <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: T.gold }}>{fmtPct(actualPct)}</span>
            </div>
          )}
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Position</span>
              <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: T.textDim }}>
                {fmtNum(holding.qty)} × {holding.price != null ? maskMoney(holding.price, valuesHidden) : "—"}
              </span>
            </div>
            {holding.originalCurrency === "BRL" && holding.fxRate != null && (
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>BRL/USD</span>
                <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: T.textDim }}>{holding.fxRate.toFixed(2)}</span>
              </div>
            )}
          </div>
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Class</span>
              {hasTransactions ? (
                <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.08em", textTransform: "uppercase", color: T.gold, padding: "1px 6px" }}>{holding.assetClass || "Uncategorized"}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => { onEditClass(); setDriftOpen(false); }}
                  style={{ background: "rgba(201,169,97,0.08)", border: `1px solid ${T.goldDim}55`, color: T.gold, padding: "1px 6px", fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.08em", textTransform: "uppercase", borderRadius: 1, display: "flex", alignItems: "center", gap: 3 }}
                >
                  {holding.assetClass || "Uncategorized"}
                  <Pencil size={7} />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => { onRefresh(); setDriftOpen(false); }}
              disabled={busy}
              style={{ width: "100%", background: "transparent", border: `1px solid ${T.border}`, color: busy ? T.textFaint : T.textDim, padding: "5px 8px", fontSize: 10, fontFamily: FONT_MONO, letterSpacing: "0.08em", textTransform: "uppercase", borderRadius: 2, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
            >
              <RefreshCw size={10} className={busy ? "spin" : ""} />
              Refresh price
            </button>
          </div>
        </div>
      )}

      {/* Asset class inline edit — triggered from accordion, expands below */}
      {editingClass && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <select
            value={editingClassValue}
            onChange={(e) => onChangeEditClassValue(e.target.value)}
            autoFocus
            style={{ background: T.cardElev, border: `1px solid ${T.gold}`, color: T.text, padding: "3px 6px", fontSize: 10, fontFamily: FONT_MONO, borderRadius: 1, minWidth: 0, flex: 1, maxWidth: 200 }}
          >
            {ASSET_CLASS_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button type="button" onClick={onSaveClass} style={{ background: T.gold, color: T.bg, border: "none", padding: "3px 8px", fontSize: 10, borderRadius: 1, fontWeight: 600 }}>Save</button>
          <button type="button" onClick={onCancelEditClass} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "3px 8px", fontSize: 10, borderRadius: 1 }}>Cancel</button>
        </div>
      )}

      {/* Inline edit panel for qty + target */}
      {editing && (
        <div
          style={{
            background: T.cardElev,
            border: `1px solid ${T.border}`,
            borderRadius: 2,
            padding: 10,
            marginTop: 8,
          }}
        >
          <div style={{ marginBottom: 8 }}>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 9,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: T.textFaint,
                  fontFamily: FONT_MONO,
                  marginBottom: 4,
                }}
              >
                Target %
              </label>
              <Input value={draftTarget} onChange={(e) => setDraftTarget(e.target.value)} onEnter={saveEdit} inputMode="decimal" autoFocus />
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={saveEdit}
              style={{
                flex: 1,
                background: T.gold,
                color: T.bg,
                border: "none",
                padding: "8px 12px",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                borderRadius: 2,
                fontFamily: FONT_BODY,
              }}
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                color: T.textDim,
                padding: "8px 12px",
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                borderRadius: 2,
                fontFamily: FONT_BODY,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function IconButton({ children, onClick, disabled, danger, label }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      style={{
        background: "transparent",
        border: `1px solid ${T.border}`,
        color: danger ? T.red : T.textDim,
        width: 30,
        height: 30,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 2,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function RebalanceRow({ item, valuesHidden }) {
  const { holding, deltaShares, deltaDollars } = item;

  return (
    <div
      style={{
        background: T.card,
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontWeight: 600,
            fontSize: 13,
            color: T.text,
            letterSpacing: "0.04em",
            marginBottom: 2,
          }}
        >
          {holding.ticker}
        </div>
        {holding.name && (
          <div
            style={{
              fontSize: 10,
              color: T.textFaint,
              fontFamily: FONT_DISPLAY,
              fontStyle: "italic",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {holding.name}
          </div>
        )}
      </div>

      <div style={{ textAlign: "right" }}>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 12,
            fontWeight: 600,
            color: T.green,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            background: T.greenBg,
            padding: "3px 8px",
            borderRadius: 1,
            display: "inline-block",
          }}
        >
          BUY {deltaShares}
        </div>
        <div
          style={{
            fontSize: 12,
            color: T.green,
            fontFamily: FONT_MONO,
            fontWeight: 500,
            marginTop: 4,
          }}
        >
          {maskMoney(deltaDollars, valuesHidden)}
        </div>
      </div>
    </div>
  );
}

function RebalanceSummary({ items, newCash, valuesHidden }) {
  const totalBuy = items.reduce((s, i) => s + (i.deltaDollars > 0 ? i.deltaDollars : 0), 0);

  if (totalBuy === 0) return null;

  return (
    <div
      style={{
        marginTop: 14,
        padding: "10px 12px",
        background: T.cardElev,
        borderRadius: 2,
        display: "flex",
        gap: 16,
        fontFamily: FONT_MONO,
        fontSize: 11,
        color: T.textDim,
        flexWrap: "wrap",
      }}
    >
      <div>
        <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: T.textFaint, marginBottom: 2 }}>
          Total to buy
        </div>
        <div style={{ color: T.green, fontWeight: 600 }}>{maskMoney(totalBuy, valuesHidden)}</div>
      </div>
    </div>
  );
}

// Reads the Google OAuth client ID from a meta tag injected at build time, or window global.
function getGoogleClientId() {
  if (typeof window === "undefined") return null;
  if (window.__GOOGLE_CLIENT_ID__) return window.__GOOGLE_CLIENT_ID__;
  const meta = document.querySelector('meta[name="google-client-id"]');
  return meta?.content || null;
}

// Decode a JWT payload (no verification — server validates).
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    return JSON.parse(atob(payload));
  } catch (e) {
    return null;
  }
}

function LoginGate({ onGoogleAuth, onPasswordAuth }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const googleButtonRef = useRef(null);
  const clientId = getGoogleClientId();

  // Load the Google Identity Services script and render the button.
  useEffect(() => {
    if (!clientId) return;

    function init() {
      if (!window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          const claims = decodeJwtPayload(response.credential);
          if (!claims) {
            setError("Could not decode Google response");
            return;
          }
          onGoogleAuth(response.credential, {
            email: claims.email,
            name: claims.name,
            picture: claims.picture,
          });
        },
        auto_select: false,
        cancel_on_tap_outside: false,
      });
      if (googleButtonRef.current) {
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: "filled_black",
          size: "large",
          type: "standard",
          text: "signin_with",
          shape: "rectangular",
          logo_alignment: "left",
          width: 320,
        });
      }
      setGoogleReady(true);
    }

    // Already loaded?
    if (window.google?.accounts?.id) {
      init();
      return;
    }

    // Load the script
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener("load", init);
      return () => existing.removeEventListener("load", init);
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = init;
    script.onerror = () => setError("Failed to load Google Sign-In");
    document.head.appendChild(script);
  }, [clientId, onGoogleAuth]);

  async function submitPassword() {
    if (!pw) {
      setError("Enter the password");
      return;
    }
    setError("");
    setChecking(true);
    try {
      const res = await fetch("/api/price?ticker=SPY", {
        headers: { "x-app-password": pw },
      });
      if (res.status === 401) {
        setError("Wrong password");
        setChecking(false);
        return;
      }
      onPasswordAuth(pw);
    } catch (e) {
      setError("Could not reach server");
      setChecking(false);
    }
  }

  return (
    <>
      <style>{FONT_IMPORT}</style>
      <style>{`
        * { box-sizing: border-box; }
        input::placeholder { color: ${T.textFaint}; }
        input:focus { outline: none; border-color: ${T.gold} !important; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
      `}</style>
      <div
        style={{
          minHeight: "100vh",
          background: T.bg,
          color: T.text,
          fontFamily: FONT_BODY,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding:
            "calc(20px + env(safe-area-inset-top, 0px)) calc(20px + env(safe-area-inset-right, 0px)) calc(20px + env(safe-area-inset-bottom, 0px)) calc(20px + env(safe-area-inset-left, 0px))",
        }}
      >
        <div style={{ width: "100%", maxWidth: 360 }}>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.2em",
              color: T.gold,
              textTransform: "uppercase",
              marginBottom: 14,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Lock size={11} />
            Private Access
          </div>
          <h1
            style={{
              fontFamily: FONT_DISPLAY,
              fontWeight: 500,
              fontSize: 40,
              lineHeight: 1,
              margin: "0 0 8px",
              letterSpacing: "-0.02em",
              fontStyle: "italic",
            }}
          >
            Portfolio
          </h1>
          <div
            style={{
              fontSize: 13,
              color: T.textDim,
              marginBottom: 28,
              lineHeight: 1.5,
            }}
          >
            Sign in to access your portfolio. Each user has an isolated set of holdings.
          </div>

          <div
            style={{
              background: T.card,
              border: `1px solid ${T.borderSoft}`,
              borderRadius: 4,
              padding: 16,
            }}
          >
            {clientId ? (
              <div
                ref={googleButtonRef}
                style={{
                  display: "flex",
                  justifyContent: "center",
                  minHeight: 44,
                }}
              />
            ) : (
              <div
                style={{
                  fontSize: 12,
                  color: T.red,
                  fontFamily: FONT_MONO,
                  textAlign: "center",
                  padding: 12,
                }}
              >
                Google Sign-In not configured.
                <br />
                Set GOOGLE_CLIENT_ID env var.
              </div>
            )}

            {!showPasswordFallback ? (
              <button
                onClick={() => setShowPasswordFallback(true)}
                style={{
                  marginTop: 14,
                  background: "transparent",
                  border: "none",
                  color: T.textDim,
                  fontSize: 11,
                  fontFamily: FONT_MONO,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  width: "100%",
                  textAlign: "center",
                  padding: "8px",
                  textDecoration: "underline",
                }}
              >
                Use password instead
              </button>
            ) : (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.borderSoft}` }}>
                <div
                  style={{
                    fontSize: 10,
                    color: T.textFaint,
                    fontFamily: FONT_MONO,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    marginBottom: 10,
                    textAlign: "center",
                  }}
                >
                  Backup access
                </div>
                <input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitPassword()}
                  placeholder="Password"
                  autoFocus
                  style={{
                    background: T.cardElev,
                    border: `1px solid ${T.border}`,
                    color: T.text,
                    padding: "12px 14px",
                    fontSize: 14,
                    fontFamily: FONT_MONO,
                    borderRadius: 2,
                    width: "100%",
                    marginBottom: 12,
                  }}
                />
                <button
                  onClick={submitPassword}
                  disabled={checking}
                  style={{
                    width: "100%",
                    background: T.gold,
                    color: T.bg,
                    border: "none",
                    padding: "12px 16px",
                    fontWeight: 600,
                    fontSize: 12,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    fontFamily: FONT_BODY,
                    borderRadius: 2,
                    cursor: checking ? "not-allowed" : "pointer",
                    opacity: checking ? 0.6 : 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                  }}
                >
                  {checking ? (
                    <>
                      <RefreshCw size={12} className="spin" /> Checking
                    </>
                  ) : (
                    "Unlock with password"
                  )}
                </button>
                <button
                  onClick={() => {
                    setShowPasswordFallback(false);
                    setPw("");
                    setError("");
                  }}
                  style={{
                    marginTop: 8,
                    background: "transparent",
                    border: "none",
                    color: T.textFaint,
                    fontSize: 10,
                    fontFamily: FONT_MONO,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    width: "100%",
                    padding: 4,
                  }}
                >
                  ← Back to Google
                </button>
              </div>
            )}

            {error && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 12,
                  color: T.red,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <AlertCircle size={12} />
                {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function SectionLabel({ label, count, of, icon, collapsible, collapsed, onToggle }) {
  const content = (
    <>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(to right, ${T.gold}, transparent)`,
        }}
      />
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: T.gold,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {icon}
        {label}
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: T.textFaint,
          flex: 1,
        }}
      >
        {count}
        {of != null && of !== count ? ` / ${of}` : ""}
      </div>
      {collapsible && (
        <ChevronDown
          size={14}
          style={{
            color: T.textDim,
            transform: collapsed ? "rotate(-90deg)" : "none",
            transition: "transform 0.2s",
          }}
        />
      )}
    </>
  );

  const baseStyle = {
    marginTop: 18,
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
    gap: 8,
    paddingTop: 13,
    paddingBottom: 7,
    borderBottom: `1px solid ${T.borderSoft}`,
    position: "relative",
    overflow: "hidden",
  };

  if (collapsible) {
    return (
      <button
        onClick={onToggle}
        style={{
          ...baseStyle,
          width: "100%",
          background: "transparent",
          border: "none",
          paddingLeft: 0,
          paddingRight: 0,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {content}
      </button>
    );
  }

  return <div style={baseStyle}>{content}</div>;
}

function ModeButton({ active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: active ? T.gold : "transparent",
        border: `1px solid ${active ? T.gold : T.border}`,
        color: active ? T.bg : T.textDim,
        padding: "7px 10px",
        fontSize: 10,
        fontFamily: FONT_MONO,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        fontWeight: 600,
        borderRadius: 2,
      }}
    >
      {label}
    </button>
  );
}

function ManualHoldingRow({ holding, usdBrlRate, totalValue, valuesHidden, deltaColor, onUpdate, onRemove, locked, valueLocked = false, onRefresh, busy = false }) {
  const isBankBonds = (holding.assetClass || "").includes("Bank Bonds") || holding.derivedFromTransactions === true;
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState("");
  const [draftQty, setDraftQty] = useState("");
  const [draftPrice, setDraftPrice] = useState("");
  const [draftTarget, setDraftTarget] = useState("");
  const [draftClass, setDraftClass] = useState("");
  const [draftCurrency, setDraftCurrency] = useState("USD");

  // BRA Fixed Income holdings are entered in BRL and converted to USD via the live rate.
  const isBrl = holding.manualMode === "value" && holding.manualCurrency === "BRL";
  const brlAmount = holding.manualValue ?? 0;

  const value =
    holding.manualMode === "value"
      ? isBrl
        ? usdBrlRate
          ? brlAmount / usdBrlRate
          : 0
        : holding.manualValue ?? 0
      : (holding.manualPrice ?? 0) * (holding.qty ?? 0);
  const actualPct = value && totalValue > 0 ? (value / totalValue) * 100 : null;
  const drift = actualPct != null && holding.target ? actualPct - holding.target : null;
  const driftUSD = drift != null && totalValue > 0 ? (drift / 100) * totalValue : null;

  // Bank Bonds DISPLAY the current value as `value` (manualValue is kept in
  // sync with SimpleFin's market value by applyBankBondsHolding) — same
  // treatment as an auto ticker's price. `costBasis` (the transaction
  // principal) is used only to derive the gain/loss %, shown beside the value
  // like a ticker's day change; it's not displayed as its own line (jul/2026 —
  // card standardized to match the auto-ticker layout, e.g. IVV).
  const costBasis =
    holding.costBasis != null && isFinite(holding.costBasis) ? holding.costBasis : null;
  const hasCostRef = isBankBonds && costBasis != null;
  const bondGainLoss = hasCostRef ? value - costBasis : null;
  const bondGainLossColor =
    bondGainLoss == null
      ? T.textDim
      : bondGainLoss > 0
      ? T.green
      : bondGainLoss < 0
      ? T.red
      : T.textDim;
  const bondGainLossPct = hasCostRef && costBasis > 0 ? (value / costBasis - 1) * 100 : null;

  // SimpleFin-reported Cash balance sync recency (see applyFidelityBalanceUpdate
  // in App.jsx). `simplefinSyncedAt` is dedicated (unlike `lastUpdated`, which
  // is bumped by any edit including Target%), so this only reflects sync writes.
  const simplefinSyncedAsOf = holding.simplefinSyncedAt
    ? new Date(holding.simplefinSyncedAt.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  const [driftOpen, setDriftOpen] = useState(false);
  const [editingPopupClass, setEditingPopupClass] = useState(false);
  const [draftPopupClass, setDraftPopupClass] = useState("");

  function startEdit() {
    setDraftValue(holding.manualValue != null ? String(holding.manualValue) : "");
    setDraftQty(holding.qty != null ? String(holding.qty) : "");
    setDraftPrice(holding.manualPrice != null ? String(holding.manualPrice) : "");
    setDraftTarget(holding.target != null ? String(holding.target) : "");
    setDraftClass(holding.assetClass || "");
    setDraftCurrency(holding.manualCurrency === "BRL" ? "BRL" : "USD");
    setEditing(true);
  }

  // BRL value entry is offered only for BRA Fixed Income holdings.
  const editClass = locked ? holding.assetClass : draftClass;
  const allowBrl =
    (editClass || "").trim().toLowerCase() === "bra fixed income";

  function saveEdit() {
    const patch = {
      target: draftTarget === "" ? 0 : parseFloat(draftTarget) || 0,
    };
    if (!locked && !isBankBonds) {
      patch.assetClass = draftClass.trim() || "Manual";
      patch.assetClassOverride = draftClass.trim() || null;
    }
    if (!isBankBonds && !valueLocked) {
      if (holding.manualMode === "value") {
        const v = parseFloat(draftValue);
        patch.manualValue = isNaN(v) ? 0 : v;
        patch.manualCurrency = allowBrl && draftCurrency === "BRL" ? "BRL" : "USD";
      } else {
        const q = parseFloat(draftQty);
        const p = parseFloat(draftPrice);
        patch.qty = isNaN(q) ? 0 : q;
        patch.manualPrice = isNaN(p) ? 0 : p;
      }
    }
    onUpdate(patch);
    setEditing(false);
  }

  return (
    <div className="card-enter" style={{ padding: "10px 14px" }}>
      {/* Line 1: name (tap to expand) | value */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <button
            type="button"
            onClick={() => setDriftOpen((o) => !o)}
            style={{
              background: "none",
              border: "none",
              padding: "6px 2px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 5,
              maxWidth: "100%",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 13, fontWeight: 500, fontStyle: "italic", color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {holding.name}
            </span>
            <ChevronDown
              size={11}
              style={{
                color: T.textFaint,
                flexShrink: 0,
                transform: driftOpen ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.15s ease",
              }}
            />
          </button>
        </div>
        <span style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          {isBrl && (
            <span
              title={
                usdBrlRate
                  ? `R$ ${fmtNum(brlAmount, 2)} ÷ ${usdBrlRate.toFixed(2)} BRL/USD`
                  : "Awaiting USD/BRL rate"
              }
              style={{ fontSize: 9, fontFamily: FONT_MONO, color: T.textFaint, letterSpacing: "0.06em" }}
            >
              {valuesHidden ? "BRL" : `R$${fmtNum(brlAmount, 0)}`}
            </span>
          )}
          {/* Bank Bonds gain/loss %, beside the value — same treatment as an
              auto ticker's day change (% only, no parens, no $ amount). */}
          {hasCostRef && bondGainLossPct != null && (
            <span
              title={`Market value vs cost${costBasis != null ? ` (cost ${fmtMoney(costBasis)})` : ""}`}
              style={{ fontSize: 10, fontFamily: FONT_MONO, color: bondGainLossColor, letterSpacing: "0.04em" }}
            >
              {bondGainLossPct > 0 ? "+" : ""}{bondGainLossPct.toFixed(2)}%
            </span>
          )}
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 15, fontWeight: 500, color: T.text, letterSpacing: "-0.01em" }}>
            {maskMoney(value, valuesHidden)}
          </span>
        </span>
      </div>

      {/* Line 2: labeled qty · price · drift | edit + remove */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, overflow: "hidden" }}>
          {holding.manualMode === "qty_price" && (
            <>
              <span style={{ fontSize: 11, color: T.textDim, fontFamily: FONT_MONO, flexShrink: 0 }}>
                <span style={{ fontSize: 9, color: T.textFaint, letterSpacing: "0.08em", textTransform: "uppercase" }}>Qty </span>
                {fmtNum(holding.qty)}
              </span>
              <span style={{ fontSize: 11, color: T.textDim, fontFamily: FONT_MONO, flexShrink: 0 }}>
                <span style={{ fontSize: 9, color: T.textFaint, letterSpacing: "0.08em", textTransform: "uppercase" }}>Price </span>
                {maskMoney(holding.manualPrice, valuesHidden)}
              </span>
            </>
          )}
          {drift != null && (
            <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: deltaColor, flexShrink: 0 }}>
              <span style={{ fontSize: 9, color: T.textFaint, letterSpacing: "0.08em", textTransform: "uppercase" }}>DELTA </span>
              {drift > 0 ? "+" : ""}{drift.toFixed(2)}%
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
          <IconButton onClick={editing ? () => setEditing(false) : startEdit} label="Edit">
            <Pencil size={12} />
          </IconButton>
          {!locked && !isBankBonds && (
            <IconButton onClick={onRemove} label="Remove" danger>
              <Trash2 size={12} />
            </IconButton>
          )}
        </div>
      </div>

      {/* Inline accordion expansion */}
      {driftOpen && (
        <div
          style={{
            background: T.cardElev,
            border: `1px solid ${T.border}`,
            borderRadius: 2,
            padding: "10px 12px",
            marginTop: 8,
          }}
        >
          {holding.target > 0 ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Actual</span>
                <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: T.gold }}>{fmtPct(actualPct)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Target</span>
                <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: T.text }}>{fmtPct(holding.target)}</span>
              </div>
              {driftUSD != null && (
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>DELTA</span>
                  <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: deltaColor }}>
                    {driftUSD > 0 ? "+" : ""}{maskMoney(driftUSD, valuesHidden)} ({drift > 0 ? "+" : ""}{drift.toFixed(2)}%)
                  </span>
                </div>
              )}
            </>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Allocated</span>
              <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: T.gold }}>{fmtPct(actualPct)}</span>
            </div>
          )}
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}>
            {editingPopupClass ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <select
                  value={draftPopupClass}
                  onChange={(e) => setDraftPopupClass(e.target.value)}
                  autoFocus
                  style={{ background: T.bg, border: `1px solid ${T.gold}`, color: T.text, padding: "3px 6px", fontSize: 10, fontFamily: FONT_MONO, borderRadius: 1, flex: 1, minWidth: 0 }}
                >
                  {ASSET_CLASS_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <button type="button" onClick={() => { onUpdate({ assetClass: draftPopupClass, assetClassOverride: draftPopupClass || null }); setEditingPopupClass(false); }} style={{ background: T.gold, color: T.bg, border: "none", padding: "3px 8px", fontSize: 10, borderRadius: 1, fontWeight: 600 }}>Save</button>
                <button type="button" onClick={() => setEditingPopupClass(false)} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "3px 8px", fontSize: 10, borderRadius: 1 }}>✕</button>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Class</span>
                {!locked && !isBankBonds ? (
                  <button
                    type="button"
                    onClick={() => { setDraftPopupClass(holding.assetClass || ""); setEditingPopupClass(true); }}
                    style={{ background: "rgba(201,169,97,0.08)", border: `1px solid ${T.goldDim}55`, color: T.gold, padding: "1px 6px", fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.08em", textTransform: "uppercase", borderRadius: 1, display: "flex", alignItems: "center", gap: 3 }}
                  >
                    {holding.assetClass || "Manual"}<Pencil size={7} />
                  </button>
                ) : (
                  <span style={{ fontSize: 9, fontFamily: FONT_MONO, color: T.gold, letterSpacing: "0.08em", textTransform: "uppercase" }}>{holding.assetClass || "Manual"}</span>
                )}
              </div>
            )}
          </div>
          {/* "Refresh price" button — same block/style as HoldingRow's (auto
              tickers, e.g. IVV), reused verbatim so the Bank Bonds card reads
              identically. Only rendered when the parent wires onRefresh (see
              App.jsx's holdings list: only the aggregated Bank Bonds holding
              gets it, pulling Cash + Bank Bonds current values from
              SimpleFin — jul/2026). */}
          {onRefresh && (
            <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}>
              <button
                type="button"
                onClick={() => { onRefresh(); setDriftOpen(false); }}
                disabled={busy}
                style={{ width: "100%", background: "transparent", border: `1px solid ${T.border}`, color: busy ? T.textFaint : T.textDim, padding: "5px 8px", fontSize: 10, fontFamily: FONT_MONO, letterSpacing: "0.08em", textTransform: "uppercase", borderRadius: 2, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
              >
                <RefreshCw size={10} className={busy ? "spin" : ""} />
                Refresh price
              </button>
            </div>
          )}
          {simplefinSyncedAsOf && (
            <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 9, fontFamily: FONT_MONO, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textFaint }}>Last Synced (SimpleFin)</span>
                <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: T.textDim }}>{simplefinSyncedAsOf}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Edit form (inline) */}
      {editing && (
        <div
          style={{
            background: T.cardElev,
            border: `1px solid ${T.border}`,
            borderRadius: 2,
            padding: 10,
            marginTop: 8,
          }}
        >
          {isBankBonds ? (
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: T.textDim, fontSize: 13, fontFamily: FONT_MONO }}>Auto-calculated from transactions</span>
            </div>
          ) : valueLocked ? (
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: T.textDim, fontSize: 13, fontFamily: FONT_MONO }}>Synced automatically via SimpleFin</span>
            </div>
          ) : holding.manualMode === "value" ? (
            <div style={{ marginBottom: 8 }}>
              <Input
                placeholder={allowBrl && draftCurrency === "BRL" ? "Value in BRL (e.g. Nubank)" : "Current value"}
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                inputMode="decimal"
              />
              {allowBrl && (
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  {["USD", "BRL"].map((c) => {
                    const active = draftCurrency === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setDraftCurrency(c)}
                        style={{
                          flex: 1,
                          background: active ? T.gold : "transparent",
                          color: active ? T.bg : T.textDim,
                          border: `1px solid ${active ? T.gold : T.border}`,
                          padding: "5px 8px",
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: "0.1em",
                          borderRadius: 2,
                          fontFamily: FONT_MONO,
                          cursor: "pointer",
                        }}
                      >
                        {c === "BRL" ? "R$ BRL" : "$ USD"}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <Input placeholder="Quantity" value={draftQty} onChange={(e) => setDraftQty(e.target.value)} inputMode="decimal" />
              <Input placeholder="Price" value={draftPrice} onChange={(e) => setDraftPrice(e.target.value)} inputMode="decimal" />
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: (locked || isBankBonds) ? "1fr" : "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <Input placeholder="Target %" value={draftTarget} onChange={(e) => setDraftTarget(e.target.value)} inputMode="decimal" />
            {!locked && !isBankBonds && (
              <select
                value={draftClass}
                onChange={(e) => setDraftClass(e.target.value)}
                style={{ background: T.cardElev, border: `1px solid ${T.border}`, color: T.text, padding: "10px 12px", fontSize: 14, fontFamily: FONT_MONO, borderRadius: 2, width: "100%" }}
              >
                {ASSET_CLASS_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={saveEdit}
              style={{
                flex: 1,
                background: T.gold,
                color: T.bg,
                border: "none",
                padding: "8px 12px",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                borderRadius: 2,
                fontFamily: FONT_BODY,
              }}
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                color: T.textDim,
                padding: "8px 12px",
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                borderRadius: 2,
                fontFamily: FONT_BODY,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ToggleButton({ active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? T.gold : "transparent",
        border: `1px solid ${active ? T.gold : T.border}`,
        color: active ? T.bg : T.textDim,
        padding: "5px 10px",
        fontSize: 9,
        fontFamily: FONT_MONO,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontWeight: 600,
        borderRadius: 2,
      }}
    >
      {label}
    </button>
  );
}

function DonutChart({ slices, centerLabel, centerValue, valuesHidden, size = 140 }) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = Math.round(size * 0.4286);
  const rInner = Math.round(size * 0.2714);

  const [hoveredKey, setHoveredKey] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);

  const total = slices.reduce((s, sl) => s + sl.pct, 0);
  let cumulative = 0;

  function handleEnter(key, e) {
    setHoveredKey(key);
    updateTooltipPos(e);
  }

  function updateTooltipPos(e) {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    let clientX, clientY;
    if (e.touches && e.touches[0]) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    setTooltipPos({ x: clientX - rect.left, y: clientY - rect.top });
  }

  function handleLeave() {
    setHoveredKey(null);
  }

  // Generate SVG arc path for one segment
  function arcPath(startPct, endPct) {
    const startAngle = (startPct / 100) * 2 * Math.PI - Math.PI / 2;
    const endAngle = (endPct / 100) * 2 * Math.PI - Math.PI / 2;
    const largeArc = endPct - startPct > 50 ? 1 : 0;

    const x1 = cx + rOuter * Math.cos(startAngle);
    const y1 = cy + rOuter * Math.sin(startAngle);
    const x2 = cx + rOuter * Math.cos(endAngle);
    const y2 = cy + rOuter * Math.sin(endAngle);
    const x3 = cx + rInner * Math.cos(endAngle);
    const y3 = cy + rInner * Math.sin(endAngle);
    const x4 = cx + rInner * Math.cos(startAngle);
    const y4 = cy + rInner * Math.sin(startAngle);

    return `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4} ${y4} Z`;
  }

  // Special case: single slice = 100% = full ring (need different rendering, can't draw a full arc)
  const isFullCircle = slices.length === 1 && Math.abs(slices[0].pct - 100) < 0.5;

  // Hovered slice for tooltip
  const hoveredSlice = hoveredKey ? slices.find((s) => s.key === hoveredKey) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div ref={containerRef} style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* Background ring (visible if no slices) */}
          {slices.length === 0 && (
            <circle
              cx={cx}
              cy={cy}
              r={(rOuter + rInner) / 2}
              fill="none"
              stroke={T.cardElev}
              strokeWidth={rOuter - rInner}
            />
          )}
          {isFullCircle ? (
            <>
              <circle
                cx={cx}
                cy={cy}
                r={rOuter}
                fill={slices[0].color}
                onMouseEnter={(e) => handleEnter(slices[0].key, e)}
                onMouseMove={updateTooltipPos}
                onMouseLeave={handleLeave}
                onTouchStart={(e) => handleEnter(slices[0].key, e)}
                onTouchMove={updateTooltipPos}
                onTouchEnd={handleLeave}
                style={{ cursor: "pointer" }}
              />
              <circle cx={cx} cy={cy} r={rInner} fill={T.card} style={{ pointerEvents: "none" }} />
            </>
          ) : (
            slices.map((sl, i) => {
              const startPct = cumulative;
              cumulative += sl.pct;
              const endPct = cumulative;
              if (sl.pct < 0.01) return null;
              const isDim = hoveredKey != null && hoveredKey !== sl.key;
              return (
                <path
                  key={sl.key}
                  d={arcPath(startPct, endPct)}
                  fill={sl.color}
                  stroke={T.card}
                  strokeWidth="0.5"
                  opacity={isDim ? 0.35 : 1}
                  onMouseEnter={(e) => handleEnter(sl.key, e)}
                  onMouseMove={updateTooltipPos}
                  onMouseLeave={handleLeave}
                  onTouchStart={(e) => handleEnter(sl.key, e)}
                  onTouchMove={updateTooltipPos}
                  onTouchEnd={handleLeave}
                  style={{ cursor: "pointer", transition: "opacity 0.15s" }}
                />
              );
            })
          )}
        </svg>
        {/* Center label */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: Math.round(size * 0.057),
              letterSpacing: "0.18em",
              color: T.textDim,
              textTransform: "uppercase",
              marginBottom: 2,
            }}
          >
            {centerLabel}
          </div>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: Math.round(size * 0.107),
              fontWeight: 500,
              color: T.text,
              letterSpacing: "-0.01em",
            }}
          >
            {centerValue}
          </div>
        </div>
        {/* Floating tooltip near cursor / tap */}
        {hoveredSlice && (
          <div
            style={{
              position: "absolute",
              left: Math.max(4, Math.min(size - 4, tooltipPos.x)) + 10,
              top: Math.max(4, Math.min(size - 4, tooltipPos.y)) - 10,
              transform: tooltipPos.x > size / 2 ? "translateX(-100%) translateX(-20px)" : "none",
              background: T.cardElev,
              border: `1px solid ${hoveredSlice.color}`,
              borderRadius: 3,
              padding: "5px 8px",
              pointerEvents: "none",
              zIndex: 10,
              whiteSpace: "nowrap",
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 9,
                color: hoveredSlice.color,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                marginBottom: 2,
              }}
            >
              {hoveredSlice.key}
            </div>
            <div
              style={{
                fontFamily: FONT_DISPLAY,
                fontSize: 13,
                fontWeight: 500,
                color: T.text,
                letterSpacing: "-0.01em",
                lineHeight: 1.1,
              }}
            >
              {fmtPct(hoveredSlice.pct)}
              {hoveredSlice.value != null && (
                <span style={{ color: T.textDim, marginLeft: 6, fontSize: 11 }}>
                  · {maskMoney(hoveredSlice.value, valuesHidden, { short: true })}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChartLegend({ colorMap, targetSlices, actualSlices, dayChangeMap }) {
  // Build unified rows showing target % vs actual % per key
  const targetMap = new Map(targetSlices.filter((s) => !s.isUnallocated).map((s) => [s.key, s.pct]));
  const actualMap = new Map(actualSlices.map((s) => [s.key, s.pct]));
  const allKeys = Array.from(new Set([...targetMap.keys(), ...actualMap.keys()])).sort();

  const hasUnallocated = targetSlices.some((s) => s.isUnallocated);
  const unallocPct = hasUnallocated ? targetSlices.find((s) => s.isUnallocated).pct : 0;

  // Build top-10 / bottom-10 sets for rank-based DELTA coloring
  const driftList = allKeys
    .map((key) => {
      const t = targetMap.get(key);
      const a = actualMap.get(key);
      return { key, drift: a != null && t != null ? a - t : null };
    })
    .filter((x) => x.drift != null)
    .sort((a, b) => b.drift - a.drift);
  const top10Keys = new Set(driftList.slice(0, 10).map((x) => x.key));
  const bottom10Keys = new Set(driftList.slice(-10).map((x) => x.key));

  // 5-column grid: name | target | actual | drift | day
  const grid = "1fr auto auto auto auto";
  const colMin = 38;

  return (
    <div
      style={{
        background: T.cardElev,
        borderRadius: 2,
        padding: "8px 10px",
        fontFamily: FONT_MONO,
        fontSize: 11,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: grid,
          gap: 8,
          paddingBottom: 6,
          marginBottom: 4,
          borderBottom: `1px solid ${T.borderSoft}`,
          fontSize: 9,
          color: T.textFaint,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        <div></div>
        <div style={{ textAlign: "right", minWidth: colMin }}>Target</div>
        <div style={{ textAlign: "right", minWidth: colMin }}>Actual</div>
        <div style={{ textAlign: "right", minWidth: colMin + 8 }}>DELTA</div>
        <div style={{ textAlign: "right", minWidth: colMin + 8 }}>Day</div>
      </div>

      {allKeys.map((key) => {
        const t = targetMap.get(key);
        const a = actualMap.get(key);
        const drift = a != null && t != null ? a - t : null;
        const driftColor =
          drift == null
            ? T.textFaint
            : top10Keys.has(key)
            ? T.red
            : bottom10Keys.has(key)
            ? T.green
            : T.textDim;

        const day = dayChangeMap?.get(key);
        const dayColor =
          day == null
            ? T.textFaint
            : day > 0
            ? T.green
            : day < 0
            ? T.red
            : T.textDim;

        return (
          <div
            key={key}
            style={{
              display: "grid",
              gridTemplateColumns: grid,
              gap: 8,
              padding: "5px 0",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  background: colorMap[key],
                  borderRadius: 1,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  color: T.text,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {key}
              </span>
            </div>
            <div style={{ textAlign: "right", color: T.textDim, minWidth: colMin }}>
              {t != null ? fmtPct(t) : "—"}
            </div>
            <div style={{ textAlign: "right", color: T.text, minWidth: colMin }}>
              {a != null ? fmtPct(a) : "—"}
            </div>
            <div style={{ textAlign: "right", color: driftColor, minWidth: colMin + 8 }}>
              {drift != null
                ? `${drift > 0 ? "+" : ""}${drift.toFixed(2)}`
                : "—"}
            </div>
            <div style={{ textAlign: "right", color: dayColor, minWidth: colMin + 8, fontSize: 10 }}>
              {day != null ? `${day > 0 ? "+" : ""}${day.toFixed(2)}%` : "—"}
            </div>
          </div>
        );
      })}

      {hasUnallocated && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: grid,
            gap: 8,
            padding: "5px 0",
            alignItems: "center",
            opacity: 0.7,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 10,
                height: 10,
                background: UNALLOCATED_COLOR,
                borderRadius: 1,
              }}
            />
            <span style={{ color: T.textDim, fontStyle: "italic" }}>Unallocated</span>
          </div>
          <div style={{ textAlign: "right", color: T.textDim, minWidth: colMin }}>
            {fmtPct(unallocPct)}
          </div>
          <div style={{ textAlign: "right", color: T.textFaint, minWidth: colMin }}>—</div>
          <div style={{ textAlign: "right", color: T.textFaint, minWidth: colMin + 8 }}>—</div>
          <div style={{ textAlign: "right", color: T.textFaint, minWidth: colMin + 8 }}>—</div>
        </div>
      )}
    </div>
  );
}

function SyncIndicator({ state, lastSavedAt }) {
  let icon;
  let color = T.textDim;
  let title = "";
  let spinning = false;

  if (state === "loading") {
    icon = <RefreshCw size={11} />;
    title = "Loading from server…";
    spinning = true;
  } else if (state === "saving") {
    icon = <Cloud size={11} />;
    color = T.gold;
    title = "Saving…";
  } else if (state === "synced") {
    icon = <Cloud size={11} />;
    color = T.green;
    title = lastSavedAt
      ? `Synced · last saved ${new Date(lastSavedAt).toLocaleTimeString()}`
      : "Synced";
  } else if (state === "offline") {
    icon = <CloudOff size={11} />;
    color = T.red;
    title = "Offline — changes saved locally only";
  } else if (state === "local-only") {
    icon = <CloudOff size={11} />;
    color = T.textFaint;
    title = "Cloud sync not configured — local only";
  } else {
    icon = <Cloud size={11} />;
    title = "";
  }

  return (
    <div
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "6px 8px",
        border: `1px solid ${T.border}`,
        color,
        background: "transparent",
        borderRadius: 2,
      }}
    >
      <span className={spinning ? "spin" : ""} style={{ display: "flex" }}>
        {icon}
      </span>
    </div>
  );
}
