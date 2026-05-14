import { useState, useEffect, useMemo, useRef } from "react";
import { Plus, Trash2, RefreshCw, AlertCircle, TrendingUp, TrendingDown, Minus, Upload, Scale, CheckCircle2, ChevronDown, Lock, LogOut, Search, ArrowUpDown, Download, Wallet, Pencil, X, Eye, EyeOff } from "lucide-react";
import Papa from "papaparse";

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

async function fetchPrice(ticker, password) {
  const res = await fetch(`/api/price?ticker=${encodeURIComponent(ticker)}`, {
    headers: { "x-app-password": password || "" },
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

// Flexible CSV field lookup — accepts variations in column naming
function normalizeCSVRow(row) {
  const find = (...keys) => {
    for (const k of keys) {
      for (const rk of Object.keys(row)) {
        if (rk.toLowerCase().trim().replace(/[%_\s]/g, "") === k.replace(/[%_\s]/g, "")) {
          return row[rk];
        }
      }
    }
    return null;
  };
  const ticker = String(find("ticker", "symbol", "stock") || "").trim().toUpperCase();
  const qty = parseFloat(find("qty", "quantity", "shares", "amount", "units"));
  const targetRaw = find("target", "targetpct", "allocation", "%", "percent", "target%", "alloc");
  const target = targetRaw != null ? parseFloat(String(targetRaw).replace("%", "")) : 0;
  return { ticker, qty, target: isNaN(target) ? 0 : target };
}

export default function App() {
  const [password, setPassword] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("app_password") || "" : ""
  );
  const [authed, setAuthed] = useState(!!password);

  function handleLogin(pw) {
    localStorage.setItem("app_password", pw);
    setPassword(pw);
    setAuthed(true);
  }

  function handleLogout() {
    localStorage.removeItem("app_password");
    setPassword("");
    setAuthed(false);
  }

  if (!authed) {
    return <LoginGate onAuth={handleLogin} />;
  }

  return <PortfolioTracker password={password} onLogout={handleLogout} onAuthFail={handleLogout} />;
}

function PortfolioTracker({ password, onLogout, onAuthFail }) {
  const [holdings, setHoldings] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [ticker, setTicker] = useState("");
  const [qty, setQty] = useState("");
  const [target, setTarget] = useState("");
  const [busyIds, setBusyIds] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [formError, setFormError] = useState("");
  const [csvStatus, setCsvStatus] = useState(null);
  const [showRebalance, setShowRebalance] = useState(false);
  const [newCash, setNewCash] = useState("");
  const fileInputRef = useRef(null);
  const importJsonRef = useRef(null);

  // Manual asset form state
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualMode, setManualMode] = useState("value"); // "value" | "qty_price"
  const [manualValueInput, setManualValueInput] = useState("");
  const [manualQty, setManualQty] = useState("");
  const [manualPriceInput, setManualPriceInput] = useState("");
  const [manualTarget, setManualTarget] = useState("");
  const [manualClass, setManualClass] = useState("");
  const [manualFormError, setManualFormError] = useState("");

  // Filter/sort state
  const [filterText, setFilterText] = useState("");
  const [filterClass, setFilterClass] = useState("");
  const [sortBy, setSortBy] = useState("value_desc"); // value_desc (default) | name | value | name_desc | value

  // Edit asset class state
  const [editingClassId, setEditingClassId] = useState(null);
  const [editingClassValue, setEditingClassValue] = useState("");

  // Allocation chart grouping mode
  const [chartGrouping, setChartGrouping] = useState("class"); // "class" | "holding"

  // Collapsed states for tracked and manual sub-sections
  const [trackedCollapsed, setTrackedCollapsed] = useState(false);
  const [manualCollapsed, setManualCollapsed] = useState(false);

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

  // Load holdings from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("holdings");
      if (raw) setHoldings(JSON.parse(raw));
    } catch (e) {}
    setLoaded(true);
  }, []);

  // Persist on change
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem("holdings", JSON.stringify(holdings));
    } catch (e) {}
  }, [holdings, loaded]);

  // Compute current value for any holding type
  function holdingValue(h) {
    if (h.type === "manual") {
      if (h.manualMode === "value") {
        return h.manualValue != null ? h.manualValue : 0;
      }
      // manualMode === "qty_price"
      return h.manualPrice != null && h.qty != null ? h.manualPrice * h.qty : 0;
    }
    // auto
    return h.price ? h.price * h.qty : 0;
  }

  const totalValue = useMemo(
    () => holdings.reduce((s, h) => s + holdingValue(h), 0),
    [holdings]
  );

  const totalTarget = useMemo(
    () => holdings.reduce((s, h) => s + (h.target || 0), 0),
    [holdings]
  );

  const setBusy = (id, v) =>
    setBusyIds((prev) => {
      const next = { ...prev };
      if (v) next[id] = true;
      else delete next[id];
      return next;
    });

  async function refreshOne(id, tickerSymbol) {
    setBusy(id, true);
    try {
      const data = await fetchPrice(tickerSymbol, password);
      setHoldings((prev) =>
        prev.map((h) =>
          h.id === id
            ? {
                ...h,
                price: data.price,
                previousClose: data.previousClose ?? h.previousClose ?? null,
                name:
                  data.name && data.name.toUpperCase() !== tickerSymbol.toUpperCase()
                    ? data.name
                    : h.name || data.name,
                assetClass: h.assetClassOverride || data.assetClass || h.assetClass || "Uncategorized",
                originalCurrency: data.originalCurrency ?? null,
                originalPrice: data.originalPrice ?? null,
                originalPreviousClose: data.originalPreviousClose ?? null,
                fxRate: data.fxRate ?? null,
                market: data.market ?? h.market ?? null,
                lastUpdated: new Date().toISOString(),
                error: null,
              }
            : h
        )
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

  async function refreshAll() {
    const autoHoldings = holdings.filter((h) => h.type !== "manual");
    if (autoHoldings.length === 0) return;
    setRefreshing(true);
    // Run in small batches with a short delay to avoid Finnhub search rate-limiting (60 req/min on free tier)
    const batchSize = 4;
    for (let i = 0; i < autoHoldings.length; i += batchSize) {
      const batch = autoHoldings.slice(i, i + batchSize);
      await Promise.all(batch.map((h) => refreshOne(h.id, h.ticker)));
      if (i + batchSize < autoHoldings.length) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    setRefreshing(false);
  }

  async function addHolding() {
    setFormError("");
    const t = ticker.trim().toUpperCase();
    const q = parseFloat(qty);
    const tgt = target === "" ? 0 : parseFloat(target);
    if (!t) return setFormError("Ticker required");
    if (!q || q <= 0) return setFormError("Quantity must be > 0");
    if (tgt < 0 || tgt > 100) return setFormError("Target % must be 0–100");

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const newH = {
      id,
      type: "auto",
      ticker: t,
      qty: q,
      target: tgt,
      price: null,
      name: null,
      assetClass: null,
      assetClassOverride: null,
      error: null,
      lastUpdated: null,
    };
    setHoldings((prev) => [...prev, newH]);
    setTicker("");
    setQty("");
    setTarget("");
    refreshOne(id, t);
  }

  function removeHolding(id) {
    setHoldings((prev) => prev.filter((h) => h.id !== id));
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
        setHoldings(incoming);
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  function handleCSVFile(file) {
    if (!file) return;
    setCsvStatus({ kind: "parsing", message: "Reading file…" });
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = (results.data || []).map(normalizeCSVRow);
        const valid = rows.filter((r) => r.ticker && r.qty > 0);
        const invalid = rows.length - valid.length;

        if (valid.length === 0) {
          setCsvStatus({
            kind: "error",
            message: "No valid rows found. Need columns: ticker, qty, target (optional).",
          });
          return;
        }

        // Merge: if ticker already exists, update qty/target; otherwise add
        const newPositions = [];
        setHoldings((prev) => {
          const existing = new Map(prev.map((h) => [h.ticker, h]));
          const merged = [...prev];
          for (const r of valid) {
            if (existing.has(r.ticker)) {
              const idx = merged.findIndex((h) => h.ticker === r.ticker);
              merged[idx] = { ...merged[idx], qty: r.qty, target: r.target };
            } else {
              const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
              const pos = {
                id,
                type: "auto",
                ticker: r.ticker,
                qty: r.qty,
                target: r.target,
                price: null,
                name: null,
                assetClass: null,
                assetClassOverride: null,
                error: null,
                lastUpdated: null,
              };
              merged.push(pos);
              newPositions.push(pos);
            }
          }
          return merged;
        });

        setCsvStatus({
          kind: "success",
          message: `Imported ${valid.length} ${valid.length === 1 ? "position" : "positions"}${invalid > 0 ? ` (${invalid} skipped)` : ""}. Fetching prices…`,
        });

        // Fetch prices for new positions
        Promise.all(newPositions.map((p) => refreshOne(p.id, p.ticker))).then(() => {
          setCsvStatus({
            kind: "success",
            message: `Imported ${valid.length} ${valid.length === 1 ? "position" : "positions"}.`,
          });
          setTimeout(() => setCsvStatus(null), 4000);
        });
      },
      error: (err) => {
        setCsvStatus({ kind: "error", message: `Parse failed: ${err.message}` });
      },
    });
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
        return 0;
      });
    }
    return result;
  }

  const filteredAutoHoldings = useMemo(
    () => applyFiltersAndSort(holdings.filter((h) => h.type !== "manual")),
    [holdings, filterText, filterClass, sortBy]
  );
  const filteredManualHoldings = useMemo(
    () => applyFiltersAndSort(holdings.filter((h) => h.type === "manual")),
    [holdings, filterText, filterClass, sortBy]
  );

  const hasActiveFilter = !!(filterText.trim() || filterClass || sortBy !== "value_desc");

  // Build allocation chart data: target vs actual, grouped by class or per holding
  const chartData = useMemo(() => {
    const keyOf = (h) =>
      chartGrouping === "class" ? h.assetClass || "Uncategorized" : h.name || h.ticker;

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
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          {/* Masthead */}
          <header style={{ marginBottom: 28 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 4,
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
                Portfolio · {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
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
                  onClick={onLogout}
                  title="Sign out"
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
              Holdings
            </h1>
            <div
              style={{
                height: 1,
                background: `linear-gradient(to right, ${T.gold}, ${T.border} 30%, transparent)`,
                marginTop: 14,
              }}
            />
          </header>

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
                fontSize: 38,
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

          {/* Allocation charts: Target vs Actual */}
          {(chartData.targetSlices.length > 0 || chartData.actualSlices.length > 0) && (
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
                      {chartData.portfolioDayChange.toFixed(2)}% today
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

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                  marginBottom: 14,
                }}
              >
                <DonutChart
                  slices={chartData.targetSlices}
                  centerLabel="Target"
                  centerValue={
                    chartData.totalTarget < 99.5
                      ? fmtPct(chartData.totalTarget)
                      : "100%"
                  }
                />
                <DonutChart
                  slices={chartData.actualSlices}
                  centerLabel="Actual"
                  centerValue={maskMoney(chartData.totalActualValue, valuesHidden, { short: true })}
                />
              </div>

              {/* Shared legend */}
              <ChartLegend
                colorMap={chartData.colorMap}
                targetSlices={chartData.targetSlices}
                actualSlices={chartData.actualSlices}
                dayChangeMap={chartData.dayChangeMap}
              />
            </section>
          )}
          {/* Rebalance Section */}
          {holdings.some((h) => h.target > 0) && (
            <section style={{ marginTop: 28 }}>
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
              No positions yet. Add your first ticker above.
            </div>
          ) : (
            <>
              {/* Filter / sort bar */}
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginBottom: 10,
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
                      setSortBy("value_desc");
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

              {/* Auto holdings */}
              {filteredAutoHoldings.length > 0 && (
                <>
                  <SectionLabel
                    label="Tracked"
                    count={filteredAutoHoldings.length}
                    of={holdings.filter((h) => h.type !== "manual").length}
                    collapsible
                    collapsed={trackedCollapsed}
                    onToggle={() => setTrackedCollapsed(!trackedCollapsed)}
                  />
                  {!trackedCollapsed && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {filteredAutoHoldings.map((h) => (
                        <HoldingRow
                          key={h.id}
                          holding={h}
                          totalValue={totalValue}
                          busy={!!busyIds[h.id]}
                          valuesHidden={valuesHidden}
                          onRefresh={() => refreshOne(h.id, h.ticker)}
                          onRemove={() => removeHolding(h.id)}
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
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Manual holdings */}
              {filteredManualHoldings.length > 0 && (
                <>
                  <SectionLabel
                    label="Manual"
                    count={filteredManualHoldings.length}
                    of={holdings.filter((h) => h.type === "manual").length}
                    icon={<Wallet size={11} />}
                    collapsible
                    collapsed={manualCollapsed}
                    onToggle={() => setManualCollapsed(!manualCollapsed)}
                  />
                  {!manualCollapsed && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {filteredManualHoldings.map((h) => (
                        <ManualHoldingRow
                          key={h.id}
                          holding={h}
                          totalValue={totalValue}
                          valuesHidden={valuesHidden}
                          onUpdate={(patch) => updateManualHolding(h.id, patch)}
                          onRemove={() => removeHolding(h.id)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* No results from filter */}
              {filteredAutoHoldings.length === 0 && filteredManualHoldings.length === 0 && (
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

          {/* Add form */}
          <section
            style={{
              background: T.card,
              border: `1px solid ${T.borderSoft}`,
              borderRadius: 4,
              padding: 16,
              marginBottom: 28,
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.18em",
                color: T.textDim,
                textTransform: "uppercase",
                marginBottom: 12,
              }}
            >
              Add Position
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <Input
                placeholder="Ticker"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                onEnter={addHolding}
                style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
              />
              <Input
                placeholder="Quantity"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                onEnter={addHolding}
                inputMode="decimal"
              />
              <Input
                placeholder="Target %"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                onEnter={addHolding}
                inputMode="decimal"
              />
            </div>
            {/^[A-Z]{4}\d{1,2}$/.test(ticker.trim()) && (
              <div
                style={{
                  fontSize: 10,
                  color: "#7898a9",
                  fontFamily: FONT_MONO,
                  letterSpacing: "0.06em",
                  marginBottom: 8,
                  marginTop: -4,
                }}
              >
                B3 ticker detected — price will be fetched in BRL and converted to USD.
              </div>
            )}
            <button
              onClick={addHolding}
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
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                borderRadius: 2,
              }}
            >
              <Plus size={14} strokeWidth={2.5} />
              Add to portfolio
            </button>
            {formError && (
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
                {formError}
              </div>
            )}

            {/* Divider + CSV upload */}
            <div
              style={{
                marginTop: 14,
                paddingTop: 14,
                borderTop: `1px dashed ${T.border}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: T.textDim,
                  fontFamily: FONT_MONO,
                  letterSpacing: "0.05em",
                }}
              >
                Or import from CSV
                <span style={{ color: T.textFaint, marginLeft: 6 }}>
                  (ticker, qty, target)
                </span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  handleCSVFile(f);
                  e.target.value = ""; // allow re-uploading same file
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.gold}`,
                  color: T.gold,
                  padding: "7px 12px",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  borderRadius: 2,
                }}
              >
                <Upload size={12} strokeWidth={2.5} />
                Upload CSV
              </button>
            </div>

            {csvStatus && (
              <div
                style={{
                  marginTop: 10,
                  padding: "8px 10px",
                  background:
                    csvStatus.kind === "error"
                      ? T.redBg
                      : csvStatus.kind === "success"
                      ? T.greenBg
                      : T.cardElev,
                  border: `1px solid ${
                    csvStatus.kind === "error"
                      ? T.red
                      : csvStatus.kind === "success"
                      ? T.green
                      : T.border
                  }33`,
                  borderRadius: 2,
                  fontSize: 12,
                  color:
                    csvStatus.kind === "error"
                      ? T.red
                      : csvStatus.kind === "success"
                      ? T.green
                      : T.textDim,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: FONT_MONO,
                }}
              >
                {csvStatus.kind === "error" && <AlertCircle size={12} />}
                {csvStatus.kind === "success" && <CheckCircle2 size={12} />}
                {csvStatus.kind === "parsing" && <RefreshCw size={12} className="spin" />}
                {csvStatus.message}
              </div>
            )}
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
                <Wallet size={12} />
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
                  <Input
                    placeholder="Current value (e.g. 5000)"
                    value={manualValueInput}
                    onChange={(e) => setManualValueInput(e.target.value)}
                    inputMode="decimal"
                    style={{ marginBottom: 8 }}
                  />
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
  onRefresh,
  onRemove,
  onUpdate,
  editingClass,
  editingClassValue,
  onEditClass,
  onSaveClass,
  onCancelEditClass,
  onChangeEditClassValue,
}) {
  const [editing, setEditing] = useState(false);
  const [draftQty, setDraftQty] = useState("");
  const [draftTarget, setDraftTarget] = useState("");

  function startEdit() {
    setDraftQty(holding.qty != null ? String(holding.qty) : "");
    setDraftTarget(holding.target != null ? String(holding.target) : "");
    setEditing(true);
  }

  function saveEdit() {
    const q = parseFloat(draftQty);
    const t = draftTarget === "" ? 0 : parseFloat(draftTarget);
    const patch = {};
    if (!isNaN(q) && q >= 0) patch.qty = q;
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

  const driftColor =
    drift == null ? T.textDim : Math.abs(drift) < 1 ? T.textDim : drift > 0 ? T.green : T.red;
  const DriftIcon =
    drift == null ? Minus : Math.abs(drift) < 1 ? Minus : drift > 0 ? TrendingUp : TrendingDown;

  return (
    <div
      className="card-enter"
      style={{
        background: T.card,
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 4,
        padding: 16,
        position: "relative",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: "0.04em",
              color: T.text,
              marginBottom: 2,
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            {holding.ticker}
            {holding.market === "B3" && (
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  color: "#7898a9",
                  background: "rgba(120, 152, 169, 0.12)",
                  border: "1px solid rgba(120, 152, 169, 0.4)",
                  padding: "1px 5px",
                  borderRadius: 1,
                }}
              >
                B3 · BRL
              </span>
            )}
          </div>
          {holding.name && (
            <div
              style={{
                fontSize: 12,
                color: T.textDim,
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
          {/* Asset class chip / edit */}
          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
            {editingClass ? (
              <>
                <input
                  value={editingClassValue}
                  onChange={(e) => onChangeEditClassValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSaveClass();
                    if (e.key === "Escape") onCancelEditClass();
                  }}
                  autoFocus
                  placeholder="Asset class"
                  style={{
                    background: T.cardElev,
                    border: `1px solid ${T.gold}`,
                    color: T.text,
                    padding: "3px 6px",
                    fontSize: 10,
                    fontFamily: FONT_MONO,
                    borderRadius: 1,
                    minWidth: 0,
                    flex: 1,
                    maxWidth: 180,
                  }}
                />
                <button
                  onClick={onSaveClass}
                  style={{
                    background: T.gold,
                    color: T.bg,
                    border: "none",
                    padding: "3px 6px",
                    fontSize: 10,
                    borderRadius: 1,
                    fontWeight: 600,
                  }}
                >
                  Save
                </button>
                <button
                  onClick={onCancelEditClass}
                  style={{
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    color: T.textDim,
                    padding: "3px 6px",
                    fontSize: 10,
                    borderRadius: 1,
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={onEditClass}
                title="Edit asset class"
                style={{
                  background: "rgba(201, 169, 97, 0.08)",
                  border: `1px solid ${T.goldDim}55`,
                  color: T.gold,
                  padding: "2px 7px",
                  fontSize: 9,
                  fontFamily: FONT_MONO,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  borderRadius: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {holding.assetClass || "Uncategorized"}
                <Pencil size={8} />
              </button>
            )}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 20,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              color: T.text,
              lineHeight: 1.1,
            }}
          >
            {value != null ? maskMoney(value, valuesHidden) : busy ? "…" : "—"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: T.textDim,
              fontFamily: FONT_MONO,
              marginTop: 2,
            }}
          >
            {fmtNum(holding.qty)} × {holding.price != null ? maskMoney(holding.price, valuesHidden) : "—"}
          </div>
          {holding.originalCurrency === "BRL" && holding.originalPrice != null && (
            <div
              style={{
                fontSize: 10,
                color: T.textFaint,
                fontFamily: FONT_MONO,
                marginTop: 2,
                letterSpacing: "0.04em",
              }}
            >
              {valuesHidden ? "R$ ••••" : `R$ ${holding.originalPrice.toFixed(2)}`}
              {holding.fxRate ? ` · ${holding.fxRate.toFixed(2)} BRL/USD` : ""}
            </div>
          )}
          {dayChangePct != null && (
            <div
              style={{
                fontSize: 10,
                fontFamily: FONT_MONO,
                marginTop: 2,
                color: dayColor,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 3,
                letterSpacing: "0.04em",
              }}
            >
              {dayChangePct > 0 ? (
                <TrendingUp size={9} strokeWidth={2.5} />
              ) : dayChangePct < 0 ? (
                <TrendingDown size={9} strokeWidth={2.5} />
              ) : (
                <Minus size={9} strokeWidth={2.5} />
              )}
              {dayChangePct > 0 ? "+" : ""}
              {dayChangePct.toFixed(2)}% today
            </div>
          )}
        </div>
      </div>

      {/* Inline edit panel for qty + target */}
      {editing && (
        <div
          style={{
            background: T.cardElev,
            border: `1px solid ${T.border}`,
            borderRadius: 2,
            padding: 10,
            marginTop: 10,
            marginBottom: 4,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginBottom: 8,
            }}
          >
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
                Quantity
              </label>
              <Input
                value={draftQty}
                onChange={(e) => setDraftQty(e.target.value)}
                onEnter={saveEdit}
                inputMode="decimal"
                autoFocus
              />
            </div>
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
              <Input
                value={draftTarget}
                onChange={(e) => setDraftTarget(e.target.value)}
                onEnter={saveEdit}
                inputMode="decimal"
              />
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

      {/* Allocation bar */}
      {holding.target > 0 && (
        <div style={{ marginTop: 12, marginBottom: 4 }}>
          <div
            style={{
              position: "relative",
              height: 6,
              background: T.cardElev,
              borderRadius: 1,
              overflow: "hidden",
            }}
          >
            {/* Actual */}
            {actualPct != null && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  height: "100%",
                  width: `${Math.min(actualPct, 100)}%`,
                  background: T.gold,
                  transition: "width 0.4s ease",
                }}
              />
            )}
            {/* Target marker */}
            <div
              style={{
                position: "absolute",
                top: -2,
                left: `${Math.min(holding.target, 100)}%`,
                width: 2,
                height: 10,
                background: T.text,
                transform: "translateX(-1px)",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 6,
              fontSize: 11,
              fontFamily: FONT_MONO,
              color: T.textDim,
            }}
          >
            <span>
              Actual <span style={{ color: T.gold }}>{fmtPct(actualPct)}</span>
            </span>
            <span>
              Target <span style={{ color: T.text }}>{fmtPct(holding.target)}</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4, color: driftColor }}>
              <DriftIcon size={10} strokeWidth={2.5} />
              {drift != null ? `${drift > 0 ? "+" : ""}${drift.toFixed(2)}` : "—"}
            </span>
          </div>
        </div>
      )}

      {/* Footer / actions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 14,
          paddingTop: 10,
          borderTop: `1px solid ${T.borderSoft}`,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: T.textFaint,
            fontFamily: FONT_MONO,
            letterSpacing: "0.05em",
          }}
        >
          {holding.error ? (
            <span style={{ color: T.red, display: "flex", alignItems: "center", gap: 4 }}>
              <AlertCircle size={10} />
              {holding.error}
            </span>
          ) : busy ? (
            "Fetching price…"
          ) : (
            `Updated ${timeAgo(holding.lastUpdated)}`
          )}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <IconButton onClick={editing ? () => setEditing(false) : startEdit} label="Edit">
            <Pencil size={13} />
          </IconButton>
          <IconButton onClick={onRefresh} disabled={busy} label="Refresh">
            <RefreshCw size={13} className={busy ? "spin" : ""} />
          </IconButton>
          <IconButton onClick={onRemove} label="Remove" danger>
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>
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

function LoginGate({ onAuth }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function submit() {
    if (!pw) {
      setError("Enter the password");
      return;
    }
    setError("");
    setChecking(true);
    // Test the password by hitting the API with a sentinel ticker
    try {
      const res = await fetch("/api/price?ticker=SPY", {
        headers: { "x-app-password": pw },
      });
      if (res.status === 401) {
        setError("Wrong password");
        setChecking(false);
        return;
      }
      // Any other status (200, 502, 500) means password was accepted
      onAuth(pw);
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
            Enter your password to continue. You'll only need to do this once on this device.
          </div>

          <div
            style={{
              background: T.card,
              border: `1px solid ${T.borderSoft}`,
              borderRadius: 4,
              padding: 16,
            }}
          >
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
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
              onClick={submit}
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
                "Unlock"
              )}
            </button>
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
          fontFamily: FONT_MONO,
          fontSize: 9,
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
    paddingBottom: 6,
    borderBottom: `1px solid ${T.borderSoft}`,
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
          padding: 0,
          paddingBottom: 6,
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

function ManualHoldingRow({ holding, totalValue, valuesHidden, onUpdate, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState("");
  const [draftQty, setDraftQty] = useState("");
  const [draftPrice, setDraftPrice] = useState("");
  const [draftTarget, setDraftTarget] = useState("");
  const [draftClass, setDraftClass] = useState("");

  const value =
    holding.manualMode === "value"
      ? holding.manualValue ?? 0
      : (holding.manualPrice ?? 0) * (holding.qty ?? 0);
  const actualPct = value && totalValue > 0 ? (value / totalValue) * 100 : null;
  const drift = actualPct != null && holding.target ? actualPct - holding.target : null;

  const driftColor =
    drift == null ? T.textDim : Math.abs(drift) < 1 ? T.textDim : drift > 0 ? T.green : T.red;
  const DriftIcon =
    drift == null ? Minus : Math.abs(drift) < 1 ? Minus : drift > 0 ? TrendingUp : TrendingDown;

  function startEdit() {
    setDraftValue(holding.manualValue != null ? String(holding.manualValue) : "");
    setDraftQty(holding.qty != null ? String(holding.qty) : "");
    setDraftPrice(holding.manualPrice != null ? String(holding.manualPrice) : "");
    setDraftTarget(holding.target != null ? String(holding.target) : "");
    setDraftClass(holding.assetClass || "");
    setEditing(true);
  }

  function saveEdit() {
    const patch = {
      target: draftTarget === "" ? 0 : parseFloat(draftTarget) || 0,
      assetClass: draftClass.trim() || "Manual",
      assetClassOverride: draftClass.trim() || null,
    };
    if (holding.manualMode === "value") {
      const v = parseFloat(draftValue);
      patch.manualValue = isNaN(v) ? 0 : v;
    } else {
      const q = parseFloat(draftQty);
      const p = parseFloat(draftPrice);
      patch.qty = isNaN(q) ? 0 : q;
      patch.manualPrice = isNaN(p) ? 0 : p;
    }
    onUpdate(patch);
    setEditing(false);
  }

  return (
    <div
      className="card-enter"
      style={{
        background: T.card,
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 4,
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 18,
              fontWeight: 500,
              fontStyle: "italic",
              color: T.text,
              marginBottom: 2,
              letterSpacing: "-0.01em",
            }}
          >
            {holding.name}
          </div>
          <div
            style={{
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                background: "rgba(201, 169, 97, 0.08)",
                border: `1px solid ${T.goldDim}55`,
                color: T.gold,
                padding: "2px 7px",
                fontSize: 9,
                fontFamily: FONT_MONO,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                borderRadius: 1,
              }}
            >
              {holding.assetClass || "Manual"}
            </span>
            <span
              style={{
                fontSize: 9,
                color: T.textFaint,
                fontFamily: FONT_MONO,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              · {holding.manualMode === "value" ? "Total value" : "Qty × price"}
            </span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 20,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              color: T.text,
              lineHeight: 1.1,
            }}
          >
            {maskMoney(value, valuesHidden)}
          </div>
          {holding.manualMode === "qty_price" && (
            <div
              style={{
                fontSize: 11,
                color: T.textDim,
                fontFamily: FONT_MONO,
                marginTop: 2,
              }}
            >
              {fmtNum(holding.qty)} × {maskMoney(holding.manualPrice, valuesHidden)}
            </div>
          )}
        </div>
      </div>

      {/* Edit form (inline) */}
      {editing && (
        <div
          style={{
            background: T.cardElev,
            border: `1px solid ${T.border}`,
            borderRadius: 2,
            padding: 10,
            marginBottom: 10,
          }}
        >
          {holding.manualMode === "value" ? (
            <Input
              placeholder="Current value"
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              inputMode="decimal"
              style={{ marginBottom: 8 }}
            />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <Input
                placeholder="Quantity"
                value={draftQty}
                onChange={(e) => setDraftQty(e.target.value)}
                inputMode="decimal"
              />
              <Input
                placeholder="Price"
                value={draftPrice}
                onChange={(e) => setDraftPrice(e.target.value)}
                inputMode="decimal"
              />
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <Input
              placeholder="Target %"
              value={draftTarget}
              onChange={(e) => setDraftTarget(e.target.value)}
              inputMode="decimal"
            />
            <Input
              placeholder="Class"
              value={draftClass}
              onChange={(e) => setDraftClass(e.target.value)}
            />
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

      {/* Allocation bar */}
      {holding.target > 0 && (
        <div style={{ marginTop: 12, marginBottom: 4 }}>
          <div
            style={{
              position: "relative",
              height: 6,
              background: T.cardElev,
              borderRadius: 1,
              overflow: "hidden",
            }}
          >
            {actualPct != null && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  height: "100%",
                  width: `${Math.min(actualPct, 100)}%`,
                  background: T.gold,
                  transition: "width 0.4s ease",
                }}
              />
            )}
            <div
              style={{
                position: "absolute",
                top: -2,
                left: `${Math.min(holding.target, 100)}%`,
                width: 2,
                height: 10,
                background: T.text,
                transform: "translateX(-1px)",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 6,
              fontSize: 11,
              fontFamily: FONT_MONO,
              color: T.textDim,
            }}
          >
            <span>
              Actual <span style={{ color: T.gold }}>{fmtPct(actualPct)}</span>
            </span>
            <span>
              Target <span style={{ color: T.text }}>{fmtPct(holding.target)}</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4, color: driftColor }}>
              <DriftIcon size={10} strokeWidth={2.5} />
              {drift != null ? `${drift > 0 ? "+" : ""}${drift.toFixed(2)}` : "—"}
            </span>
          </div>
        </div>
      )}

      {/* Footer / actions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 14,
          paddingTop: 10,
          borderTop: `1px solid ${T.borderSoft}`,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: T.textFaint,
            fontFamily: FONT_MONO,
            letterSpacing: "0.05em",
          }}
        >
          {holding.lastUpdated ? `Updated ${timeAgo(holding.lastUpdated)}` : "Manual"}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <IconButton onClick={editing ? () => setEditing(false) : startEdit} label="Edit">
            <Pencil size={13} />
          </IconButton>
          <IconButton onClick={onRemove} label="Remove" danger>
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>
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

function DonutChart({ slices, centerLabel, centerValue }) {
  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 60;
  const rInner = 38;

  const total = slices.reduce((s, sl) => s + sl.pct, 0);
  let cumulative = 0;

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

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div style={{ position: "relative", width: size, height: size }}>
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
              <circle cx={cx} cy={cy} r={rOuter} fill={slices[0].color} />
              <circle cx={cx} cy={cy} r={rInner} fill={T.card} />
            </>
          ) : (
            slices.map((sl, i) => {
              const startPct = cumulative;
              cumulative += sl.pct;
              const endPct = cumulative;
              if (sl.pct < 0.01) return null;
              return (
                <path
                  key={sl.key}
                  d={arcPath(startPct, endPct)}
                  fill={sl.color}
                  stroke={T.card}
                  strokeWidth="0.5"
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
              fontSize: 8,
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
              fontSize: 15,
              fontWeight: 500,
              color: T.text,
              letterSpacing: "-0.01em",
            }}
          >
            {centerValue}
          </div>
        </div>
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
        <div style={{ textAlign: "right", minWidth: colMin + 8 }}>Drift</div>
        <div style={{ textAlign: "right", minWidth: colMin + 8 }}>Day</div>
      </div>

      {allKeys.map((key) => {
        const t = targetMap.get(key);
        const a = actualMap.get(key);
        const drift = a != null && t != null ? a - t : null;
        const driftColor =
          drift == null
            ? T.textFaint
            : Math.abs(drift) < 0.5
            ? T.textDim
            : drift > 0
            ? T.green
            : T.red;

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
