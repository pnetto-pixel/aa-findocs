// src/TreemapCard.jsx — "Portfolio Map" treemap of holdings.
// Lazy-loaded from App.jsx so recharts stays OUT of the main bundle (the
// Holdings tab itself doesn't use recharts anywhere else).
// Tile size = current USD value; tile color = day change (green/red) for
// ticker-backed holdings with a previous close; neutral for manual holdings.

import { useState, useMemo, useRef, useEffect } from "react";
import { Treemap, ResponsiveContainer, Tooltip } from "recharts";

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

// Same value logic as App.jsx's holdingValue (duplicated per the project's
// no-shared-UI-module convention; kept in sync manually).
function holdingValueUSD(h, usdBrlRate) {
  if (h.type === "manual") {
    if (h.manualMode === "value") {
      const v = h.manualValue != null ? h.manualValue : 0;
      if (h.manualCurrency === "BRL") return usdBrlRate ? v / usdBrlRate : 0;
      return v;
    }
    return h.manualPrice != null && h.qty != null ? h.manualPrice * h.qty : 0;
  }
  return h.price ? h.price * h.qty : 0;
}

function dayChangePct(h) {
  if (h.type === "manual") return null;
  if (h.price == null || h.previousClose == null || h.previousClose === 0) return null;
  return ((h.price - h.previousClose) / h.previousClose) * 100;
}

// Day-change color: green/red whose intensity saturates at ±2% (a big day
// for a diversified holding); neutral gray-blue for no-data tiles.
function tileColor(dayPct) {
  if (dayPct == null || isNaN(dayPct)) return "#232a35";
  const a = Math.min(1, Math.abs(dayPct) / 2);
  const alpha = 0.18 + a * 0.55;
  return dayPct >= 0
    ? `rgba(125, 211, 164, ${alpha.toFixed(2)})`
    : `rgba(232, 140, 140, ${alpha.toFixed(2)})`;
}

function fmtUSD(n) {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

// Multi-select class filter as a single dropdown trigger (same pattern as
// FilterMultiSelect in Dividends.jsx — duplicated locally per the project's
// no-shared-UI-module convention).
function ClassFilterDropdown({ options, selected, onChange }) {
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
  const triggerText = active ? [...selected].sort().join(", ") : "All Classes";

  return (
    <div ref={ref} style={{ position: "relative", marginBottom: 12 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: T.cardElev,
          border: `1px solid ${active ? T.gold : T.border}`,
          borderRadius: 4,
          color: T.text,
          fontFamily: FONT_MONO,
          fontSize: 12,
          padding: "6px 10px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          maxWidth: 260,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {triggerText}
        </span>
        <span style={{ color: T.textDim, fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            width: 220,
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

// Custom tile renderer — recharts spreads each datum's fields into props.
function Tile(props) {
  const { x, y, width, height, name, dayPct } = props;
  if (width < 4 || height < 4 || !name) return null;
  const showTicker = width > 44 && height > 24;
  const showPct = width > 44 && height > 42 && dayPct != null;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={tileColor(dayPct)}
        stroke={T.bg}
        strokeWidth={2}
      />
      {showTicker && (
        <text x={x + 7} y={y + 17} fill={T.text} fontSize={11} fontFamily={FONT_MONO} fontWeight={600}>
          {name}
        </text>
      )}
      {showPct && (
        <text x={x + 7} y={y + 31} fill={T.text} fontSize={9} fontFamily={FONT_MONO} opacity={0.75}>
          {dayPct > 0 ? "+" : ""}
          {dayPct.toFixed(2)}%
        </text>
      )}
    </g>
  );
}

export default function TreemapCard({ holdings, usdBrlRate, valuesHidden }) {
  // Multi-select asset-class filter (empty = all). No ticker filter here:
  // each tile IS a ticker — tap it for details, filter by class to zoom.
  const [classFilter, setClassFilter] = useState(() => new Set());

  const allRows = useMemo(
    () =>
      (holdings || [])
        .map((h) => {
          const value = holdingValueUSD(h, usdBrlRate);
          return {
            name: (h.ticker || h.name || "?").toUpperCase(),
            size: value,
            dayPct: dayChangePct(h),
            assetClass: h.assetClassOverride || h.assetClass || "Uncategorized",
          };
        })
        .filter((d) => d.size > 0)
        .sort((a, b) => b.size - a.size),
    [holdings, usdBrlRate]
  );

  const classes = useMemo(
    () => [...new Set(allRows.map((d) => d.assetClass))].sort(),
    [allRows]
  );

  const data = classFilter.size === 0
    ? allRows
    : allRows.filter((d) => classFilter.has(d.assetClass));

  if (allRows.length === 0) {
    return (
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
        Nothing to map yet — add transactions or manual assets first.
      </div>
    );
  }

  return (
    <>
      {classes.length > 1 && (
        <ClassFilterDropdown options={classes} selected={classFilter} onChange={setClassFilter} />
      )}
      {data.length === 0 ? (
        <div style={{ background: T.cardElev, borderRadius: 4, padding: "20px 24px", fontFamily: FONT_MONO, fontSize: 13, color: T.textDim }}>
          No holdings in the selected classes.
        </div>
      ) : (
      <div style={{ background: T.cardElev, border: `1px solid ${T.borderSoft}`, borderRadius: 4, padding: 8 }}>
        <ResponsiveContainer width="100%" height={300}>
          <Treemap
            data={data}
            dataKey="size"
            nameKey="name"
            isAnimationActive={false}
            content={<Tile />}
          >
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div
                    style={{
                      background: T.card,
                      border: `1px solid ${T.border}`,
                      borderRadius: 4,
                      padding: "8px 12px",
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.text,
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.name}</div>
                    <div style={{ color: T.textDim }}>
                      {valuesHidden ? "$ ••••" : fmtUSD(d.size)}
                    </div>
                    {d.dayPct != null && (
                      <div style={{ color: d.dayPct >= 0 ? T.green : T.red }}>
                        {d.dayPct > 0 ? "+" : ""}
                        {d.dayPct.toFixed(2)}% today
                      </div>
                    )}
                  </div>
                );
              }}
            />
          </Treemap>
        </ResponsiveContainer>
      </div>
      )}
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: T.textFaint,
          marginTop: 10,
          letterSpacing: "0.04em",
        }}
      >
        Tile size = current value · color = today's change (gray = no live price:
        manual assets, cash, bonds).
      </div>
    </>
  );
}
