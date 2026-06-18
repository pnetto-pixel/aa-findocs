// src/Events.jsx
// Tab: Events — calendar of ex-dividends, payouts, earnings, and splits
// for US tickers in the portfolio. Items 20, 21, 22.
// Lazy-loaded, same pattern as Dividends.jsx / Performance.jsx.

import { useState, useEffect, useMemo } from "react";
import { Calendar, ChevronDown } from "lucide-react";

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
  blue: "#60a5fa",
  mauve: "#a978a9",
};

// Badge colors per event type
const TYPE_COLOR = {
  ex_dividend: T.gold,
  payout: T.gold,
  earnings: T.blue,
  split: T.mauve,
};

const TYPE_LABEL = {
  ex_dividend: "Ex-Div",
  payout: "Payout",
  earnings: "Earnings",
  split: "Split",
};

const FILTER_TYPES = ["All", "Ex-Div", "Payout", "Earnings", "Split"];

const TYPE_BY_FILTER = {
  "All": null,
  "Ex-Div": "ex_dividend",
  "Payout": "payout",
  "Earnings": "earnings",
  "Split": "split",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
}

function isCUSIP(t) {
  return /^[0-9A-Z]{9}$/.test(t);
}

function isTesouro(t) {
  return /^tesouro-/i.test(t);
}

// Classes eligible for events (same logic as api/dividends.js AUTO_CLASSES)
const ELIGIBLE_CLASSES = new Set([
  'Stocks', 'Real Estate', 'Alternative', 'Bonds', 'BRA Stocks', 'Unallocated USD',
]);

// Compute net quantity per ticker across all transactions (buy adds, sell subtracts).
function computeNetQty(transactions) {
  const net = {};
  for (const tx of transactions) {
    const t = (tx.ticker || '').toUpperCase();
    if (!t) continue;
    const qty = Number(tx.qty) || 0;
    if (tx.side === 'buy') net[t] = (net[t] || 0) + qty;
    else if (tx.side === 'sell') net[t] = (net[t] || 0) - qty;
  }
  return net;
}

// Derive unique US tickers from transactions (only those with net qty > 0).
function extractEligibleTickers(transactions) {
  const netQty = computeNetQty(transactions);
  const seen = new Set();
  for (const tx of transactions) {
    const t = (tx.ticker || '').toUpperCase();
    if (!t) continue;
    if (!ELIGIBLE_CLASSES.has(tx.assetClass)) continue;
    if (isBrazilianTicker(t)) continue;
    if (isCUSIP(t)) continue;
    if (isTesouro(t)) continue;
    if ((netQty[t] || 0) <= 0) continue;
    seen.add(t);
  }
  return [...seen].sort();
}

// Format a date as "Jun 15, 2026"
function fmtDateLong(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const dt = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Format a date as "Jun 15"
function fmtDateShort(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const dt = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtAmount(n) {
  if (n == null || isNaN(n)) return null;
  return `$${Number(n).toFixed(2)}/share`;
}

function fmtEPS(n) {
  if (n == null || isNaN(n)) return null;
  const sign = n >= 0 ? '' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

// Build a human-readable group header label from an ISO date relative to today.
function groupLabel(iso, todayISO) {
  if (!iso) return 'Other';
  const itemDate = new Date(iso + 'T00:00:00Z');
  const today = new Date(todayISO + 'T00:00:00Z');
  const diffDays = Math.round((itemDate - today) / 86400000);

  // Past
  if (diffDays < 0) {
    if (diffDays >= -7) return 'Last 7 Days';
    return 'Last 30 Days';
  }

  // Future / today
  if (diffDays === 0) return 'Today';
  if (diffDays <= 7) return 'This Week';
  if (diffDays <= 14) return 'Next Week';

  const [y, m] = iso.split('-');
  const dt = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
}

// Group events into chronological sections
function groupEvents(events, todayISO) {
  const groups = [];
  let currentLabel = null;
  let currentItems = [];

  for (const ev of events) {
    const label = groupLabel(ev.date, todayISO);
    if (label !== currentLabel) {
      if (currentItems.length) groups.push({ label: currentLabel, items: currentItems });
      currentLabel = label;
      currentItems = [];
    }
    currentItems.push(ev);
  }
  if (currentItems.length) groups.push({ label: currentLabel, items: currentItems });
  return groups;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TypeBadge({ type }) {
  const color = TYPE_COLOR[type] || T.textDim;
  const label = TYPE_LABEL[type] || type;
  return (
    <span
      style={{
        fontFamily: FONT_MONO,
        fontSize: 9,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color,
        border: `1px solid ${color}55`,
        borderRadius: 3,
        padding: "2px 6px",
        marginLeft: 8,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function EventDetail({ ev }) {
  const detailStyle = {
    fontFamily: FONT_MONO,
    fontSize: 11,
    color: T.textDim,
    marginTop: 4,
    letterSpacing: "0.02em",
  };

  if (ev.type === 'earnings') {
    if (ev.epsActual != null) {
      if (ev.epsEstimate != null) {
        const beat = ev.epsActual > ev.epsEstimate;
        const miss = ev.epsActual < ev.epsEstimate;
        const beatMissLabel = beat ? 'beat' : miss ? 'miss' : 'in-line';
        const beatMissColor = beat ? T.green : miss ? T.red : T.textDim;
        return (
          <div style={detailStyle}>
            {`EPS est. ${fmtEPS(ev.epsEstimate)} → reported ${fmtEPS(ev.epsActual)}`}
            {' · '}
            <span style={{ color: beatMissColor }}>{beatMissLabel}</span>
          </div>
        );
      }
      return <div style={detailStyle}>{`EPS reported ${fmtEPS(ev.epsActual)}`}</div>;
    }
    if (ev.epsEstimate != null) {
      return <div style={detailStyle}>{`EPS est. ${fmtEPS(ev.epsEstimate)}`}</div>;
    }
    return null;
  }

  const lines = [];
  if (ev.type === 'ex_dividend') {
    const amt = fmtAmount(ev.amount);
    if (amt) lines.push(amt);
    if (ev.payDate) lines.push(`Pay ${fmtDateShort(ev.payDate)}`);
  } else if (ev.type === 'payout') {
    const amt = fmtAmount(ev.amount);
    if (amt) lines.push(amt);
  } else if (ev.type === 'split') {
    if (ev.splitRatio) {
      // Reverse split: denominator > numerator — display as "1:10 reverse split"
      const isReverse =
        ev.splitDenominator != null &&
        ev.splitNumerator != null &&
        ev.splitDenominator > ev.splitNumerator;
      lines.push(`${ev.splitRatio}${isReverse ? ' reverse split' : ' split'} effective`);
    }
  }

  if (!lines.length) return null;
  return (
    <div style={detailStyle}>
      {lines.join(' · ')}
    </div>
  );
}

function EventCard({ ev, todayISO }) {
  const isPast = ev.date < todayISO;
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 4,
        padding: "12px 16px",
        opacity: isPast ? 0.55 : 1,
        marginBottom: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2 }}>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: T.textFaint,
            marginRight: 2,
            whiteSpace: "nowrap",
          }}
        >
          {fmtDateShort(ev.date)}
        </span>
        <span
          style={{
            fontFamily: FONT_BODY,
            fontSize: 13,
            fontWeight: 700,
            color: T.text,
            marginLeft: 6,
          }}
        >
          {ev.ticker}
        </span>
        <TypeBadge type={ev.type} />
      </div>
      <EventDetail ev={ev} />
    </div>
  );
}

function GroupHeader({ label, collapsed, onToggle }) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: T.textFaint,
        padding: "16px 0 6px",
        borderBottom: `1px solid ${T.borderSoft}`,
        marginBottom: 8,
      }}
    >
      <ChevronDown
        size={12}
        style={{
          flexShrink: 0,
          color: T.textFaint,
          transform: collapsed ? "rotate(-90deg)" : "none",
          transition: "transform 0.2s",
        }}
      />
      {label}
    </button>
  );
}

function FilterPill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: "5px 12px",
        cursor: "pointer",
        fontFamily: FONT_MONO,
        fontSize: 11,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: active ? T.gold : T.textDim,
        borderBottom: active ? `2px solid ${T.gold}` : "2px solid transparent",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EventsView({ auth, onAuthFail, valuesHidden }) {
  const [state, setState] = useState("loading"); // "loading" | "error" | "empty" | "done"
  const [errorMsg, setErrorMsg] = useState("");
  const [transactions, setTransactions] = useState([]);
  const [events, setEvents] = useState([]);
  const [meta, setMeta] = useState(null);
  const [filterType, setFilterType] = useState("All");
  // Past buckets start collapsed by default; future groups are expanded.
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set(["Last 30 Days", "Last 7 Days"]));

  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);

  function toggleGroup(label) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  // Step 1: load transactions, extract tickers, fetch events
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      try {
        // Load transactions
        const txRes = await fetch("/api/transactions", { headers: authHeaders(auth) });
        if (txRes.status === 401) {
          if (onAuthFail) onAuthFail();
          return;
        }
        if (!txRes.ok) {
          let msg = `Transactions error ${txRes.status}`;
          try { const j = await txRes.json(); if (j.error) msg = j.error; } catch {}
          throw new Error(msg);
        }
        const txData = await txRes.json();
        const txList = Array.isArray(txData.transactions) ? txData.transactions : [];

        if (cancelled) return;
        setTransactions(txList);

        const tickers = extractEligibleTickers(txList);
        if (!tickers.length) {
          setState("empty");
          return;
        }

        // Fetch events from API
        const evRes = await fetch("/api/events", {
          method: "POST",
          headers: { ...authHeaders(auth), "Content-Type": "application/json" },
          body: JSON.stringify({ tickers }),
        });
        if (evRes.status === 401) {
          if (onAuthFail) onAuthFail();
          return;
        }
        if (!evRes.ok) {
          let msg = `Events error ${evRes.status}`;
          try { const j = await evRes.json(); if (j.error) msg = j.error; } catch {}
          throw new Error(msg);
        }
        const evData = await evRes.json();
        if (cancelled) return;

        const evList = Array.isArray(evData.events) ? evData.events : [];
        setEvents(evList);
        setMeta(evData.meta || null);
        setState(evList.length ? "done" : "empty");
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err.message || "Failed to load events");
          setState("error");
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [auth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Client-side filter by type
  const filteredEvents = useMemo(() => {
    const typeFilter = TYPE_BY_FILTER[filterType];
    if (!typeFilter) return events;
    return events.filter((e) => e.type === typeFilter);
  }, [events, filterType]);

  const groups = useMemo(
    () => groupEvents(filteredEvents, todayISO),
    [filteredEvents, todayISO]
  );

  // ── Loading state ────────────────────────────────────────────────────────────
  if (state === "loading") {
    return (
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 13,
          color: T.textDim,
          padding: "40px 0",
          textAlign: "center",
        }}
      >
        Loading...
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────────
  if (state === "error") {
    return (
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 13,
          color: T.red,
          padding: "40px 0",
          textAlign: "center",
        }}
      >
        {errorMsg || "Error loading events."}
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ paddingBottom: 40 }}>
      {/* Type filter pills */}
      <div
        style={{
          display: "flex",
          gap: 0,
          marginBottom: 20,
          marginTop: 8,
          overflowX: "auto",
          overflowY: "hidden",
          touchAction: "pan-x",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
          borderBottom: `1px solid ${T.borderSoft}`,
        }}
      >
        {FILTER_TYPES.map((label) => (
          <FilterPill
            key={label}
            label={label}
            active={filterType === label}
            onClick={() => setFilterType(label)}
          />
        ))}
      </div>

      {/* Empty state */}
      {(state === "empty" || !filteredEvents.length) && (
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: T.textDim,
            padding: "40px 0",
            textAlign: "center",
          }}
        >
          {state === "empty" && transactions.length === 0
            ? "No transactions found. Add transactions to see upcoming events."
            : state === "empty"
            ? "No upcoming events for your portfolio."
            : `No ${filterType.toLowerCase()} events in this window.`}
        </div>
      )}

      {/* Event groups */}
      {state === "done" && filteredEvents.length > 0 && (
        <>
          {groups.map((group) => {
            const collapsed = collapsedGroups.has(group.label);
            return (
              <div key={group.label}>
                <GroupHeader
                  label={group.label}
                  collapsed={collapsed}
                  onToggle={() => toggleGroup(group.label)}
                />
                {!collapsed &&
                  group.items.map((ev, i) => (
                    <EventCard key={`${ev.date}-${ev.ticker}-${ev.type}-${i}`} ev={ev} todayISO={todayISO} />
                  ))}
              </div>
            );
          })}

          {/* Footer note */}
          {meta && (
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                color: T.textFaint,
                marginTop: 20,
                letterSpacing: "0.04em",
              }}
            >
              {`US tickers only. ${meta.tickersFetched} ticker${meta.tickersFetched !== 1 ? 's' : ''} fetched`}
              {meta.tickersFailed > 0 ? `, ${meta.tickersFailed} failed` : ''}
              {'. Window: last 30 days to next 90 days.'}
              {meta.cacheHit ? ' (cached)' : ''}
            </div>
          )}
        </>
      )}
    </div>
  );
}
