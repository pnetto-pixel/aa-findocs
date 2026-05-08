import { useState, useEffect, useMemo, useRef } from "react";
import { Plus, Trash2, RefreshCw, AlertCircle, TrendingUp, TrendingDown, Minus, Upload, Scale, CheckCircle2, ChevronDown, Lock, LogOut } from "lucide-react";
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

function fmtPct(n, digits = 1) {
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

  const totalValue = useMemo(
    () => holdings.reduce((s, h) => s + (h.price ? h.price * h.qty : 0), 0),
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
                name: data.name || h.name,
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
    if (holdings.length === 0) return;
    setRefreshing(true);
    await Promise.all(holdings.map((h) => refreshOne(h.id, h.ticker)));
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
      ticker: t,
      qty: q,
      target: tgt,
      price: null,
      name: null,
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
                ticker: r.ticker,
                qty: r.qty,
                target: r.target,
                price: null,
                name: null,
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

  // Rebalance: compute buy/sell per holding to hit target allocation
  const rebalance = useMemo(() => {
    const cash = parseFloat(newCash) || 0;
    const investableTotal = totalValue + cash;
    if (investableTotal <= 0) return [];

    return holdings
      .filter((h) => h.price && h.target > 0)
      .map((h) => {
        const currentValue = h.price * h.qty;
        const targetValue = investableTotal * (h.target / 100);
        const deltaDollars = targetValue - currentValue;
        const deltaShares = deltaDollars / h.price;
        return { holding: h, currentValue, targetValue, deltaDollars, deltaShares };
      });
  }, [holdings, totalValue, newCash]);

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
          padding: "20px 16px 60px",
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
              {fmtMoney(totalValue)}
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
                  Target alloc: <span style={{ color: T.text }}>{fmtPct(totalTarget, 0)}</span>
                  {Math.abs(totalTarget - 100) > 0.1 && (
                    <span style={{ color: T.gold, marginLeft: 6 }}>
                      ({totalTarget > 100 ? "+" : ""}{(totalTarget - 100).toFixed(1)} from 100)
                    </span>
                  )}
                </span>
              )}
            </div>
          </section>

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
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {holdings.map((h) => (
                <HoldingRow
                  key={h.id}
                  holding={h}
                  totalValue={totalValue}
                  busy={!!busyIds[h.id]}
                  onRefresh={() => refreshOne(h.id, h.ticker)}
                  onRemove={() => removeHolding(h.id)}
                />
              ))}
            </div>
          )}

          {/* Rebalance Section */}
          {rebalance.length > 0 && (
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
                      Adds this amount to investable total before computing target values.
                    </div>
                  </div>

                  {/* Rebalance rows */}
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
                      <RebalanceRow key={r.holding.id} item={r} />
                    ))}
                  </div>

                  {/* Summary */}
                  <RebalanceSummary items={rebalance} newCash={parseFloat(newCash) || 0} />

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
                        Targets sum to {fmtPct(totalTarget, 1)}, not 100%. Rebalance numbers
                        assume the targets you've set; cash may not be fully deployed.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </section>
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

function HoldingRow({ holding, totalValue, busy, onRefresh, onRemove }) {
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
            }}
          >
            {holding.ticker}
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
            {value != null ? fmtMoney(value) : busy ? "…" : "—"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: T.textDim,
              fontFamily: FONT_MONO,
              marginTop: 2,
            }}
          >
            {fmtNum(holding.qty)} × {holding.price != null ? fmtMoney(holding.price) : "—"}
          </div>
        </div>
      </div>

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
              Target <span style={{ color: T.text }}>{fmtPct(holding.target, 0)}</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4, color: driftColor }}>
              <DriftIcon size={10} strokeWidth={2.5} />
              {drift != null ? `${drift > 0 ? "+" : ""}${drift.toFixed(1)}` : "—"}
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

function RebalanceRow({ item }) {
  const { holding, currentValue, targetValue, deltaDollars, deltaShares } = item;
  // Threshold: if within $5 or 0.5% of target, consider on target
  const onTarget = Math.abs(deltaDollars) < Math.max(5, targetValue * 0.005);
  const action = onTarget ? "hold" : deltaDollars > 0 ? "buy" : "sell";
  const actionColor = action === "buy" ? T.green : action === "sell" ? T.red : T.textDim;
  const actionBg = action === "buy" ? T.greenBg : action === "sell" ? T.redBg : "transparent";

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
        <div
          style={{
            fontSize: 10,
            color: T.textFaint,
            fontFamily: FONT_MONO,
            letterSpacing: "0.04em",
          }}
        >
          {fmtMoney(currentValue, { short: true })} → {fmtMoney(targetValue, { short: true })}
        </div>
      </div>

      <div style={{ textAlign: "right" }}>
        {onTarget ? (
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: T.textDim,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              display: "flex",
              alignItems: "center",
              gap: 4,
              justifyContent: "flex-end",
            }}
          >
            <CheckCircle2 size={12} />
            On target
          </div>
        ) : (
          <>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                fontWeight: 600,
                color: actionColor,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                background: actionBg,
                padding: "2px 6px",
                borderRadius: 1,
                display: "inline-block",
                marginBottom: 3,
              }}
            >
              {action} {fmtNum(Math.abs(deltaShares).toFixed(2))}
            </div>
            <div
              style={{
                fontSize: 11,
                color: T.textDim,
                fontFamily: FONT_MONO,
              }}
            >
              ≈ {fmtMoney(Math.abs(deltaDollars))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RebalanceSummary({ items, newCash }) {
  const totalBuy = items.reduce((s, i) => s + (i.deltaDollars > 0 ? i.deltaDollars : 0), 0);
  const totalSell = items.reduce((s, i) => s + (i.deltaDollars < 0 ? -i.deltaDollars : 0), 0);
  const net = totalBuy - totalSell;

  if (totalBuy === 0 && totalSell === 0) return null;

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
          Buy
        </div>
        <div style={{ color: T.green, fontWeight: 600 }}>{fmtMoney(totalBuy)}</div>
      </div>
      <div>
        <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: T.textFaint, marginBottom: 2 }}>
          Sell
        </div>
        <div style={{ color: T.red, fontWeight: 600 }}>{fmtMoney(totalSell)}</div>
      </div>
      <div>
        <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: T.textFaint, marginBottom: 2 }}>
          Net cash {newCash > 0 ? "deployed" : "needed"}
        </div>
        <div style={{ color: T.text, fontWeight: 600 }}>{fmtMoney(net)}</div>
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
          padding: 20,
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
