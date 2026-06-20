// src/DateMonthPicker.jsx
// Shared multi-select year/month filter used by the Transactions and Dividends
// table date columns. Replaces the old type=date From/To inputs (painful on
// iPhone — two manual mm/dd/yyyy entries). Excel-style: a list of years, each
// with a [+] to reveal the months that actually have data; tap years and months
// to toggle them. Multi-select — non-contiguous months are fine.
//
// Filter model is a Set of "YYYY-MM" strings (empty Set = no filter).
// The caller filters rows with: selectedMonths.has(row.date.slice(0, 7)).

import React, { useMemo, useState } from "react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthKey(year, mo) {
  return year + "-" + String(mo).padStart(2, "0");
}

// dateOptions   : Map<year:number, Set<month:number 1-based>>
// selectedMonths: Set<"YYYY-MM">
// onChange      : (nextSet: Set<"YYYY-MM">) => void
// T, FONT_MONO  : theme tokens passed by the host file (kept duplicated by design)
export default function DateMonthPicker({ dateOptions, selectedMonths, onChange, T, FONT_MONO }) {
  const years = useMemo(() => {
    if (!dateOptions || dateOptions.size === 0) return [];
    return Array.from(dateOptions.keys()).sort((a, b) => b - a);
  }, [dateOptions]);

  // Expand the most recent year by default so months are reachable in one tap.
  const [expanded, setExpanded] = useState(() => (years.length ? new Set([years[0]]) : new Set()));

  function monthsOf(year) {
    const s = dateOptions.get(year);
    return s ? Array.from(s).sort((a, b) => a - b) : [];
  }

  // "all" | "some" | "none" — drives the year checkbox + indeterminate state.
  function yearState(year) {
    const ms = monthsOf(year);
    if (!ms.length) return "none";
    let sel = 0;
    for (const mo of ms) if (selectedMonths.has(monthKey(year, mo))) sel++;
    if (sel === 0) return "none";
    return sel === ms.length ? "all" : "some";
  }

  function toggleYear(year) {
    const ms = monthsOf(year);
    const next = new Set(selectedMonths);
    if (yearState(year) === "all") {
      for (const mo of ms) next.delete(monthKey(year, mo));
    } else {
      for (const mo of ms) next.add(monthKey(year, mo));
    }
    onChange(next);
  }

  function toggleMonth(year, mo) {
    const k = monthKey(year, mo);
    const next = new Set(selectedMonths);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChange(next);
  }

  function toggleExpand(year) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(year)) n.delete(year);
      else n.add(year);
      return n;
    });
  }

  const hasSelection = selectedMonths.size > 0;

  if (!years.length) {
    return (
      <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textFaint, padding: "4px 0" }}>
        No data
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => {
            const next = new Set();
            for (const y of years) for (const mo of monthsOf(y)) next.add(monthKey(y, mo));
            onChange(next);
          }}
          style={linkBtn(T.gold, FONT_MONO)}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => onChange(new Set())}
          disabled={!hasSelection}
          style={{ ...linkBtn(T.textDim, FONT_MONO), opacity: hasSelection ? 1 : 0.4 }}
        >
          Clear
        </button>
      </div>

      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {years.map((year) => {
          const st = yearState(year);
          const isExp = expanded.has(year);
          const ms = monthsOf(year);
          return (
            <div key={year} style={{ marginBottom: 2 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    padding: "7px 2px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={st === "all"}
                    ref={(el) => {
                      if (el) el.indeterminate = st === "some";
                    }}
                    onChange={() => toggleYear(year)}
                    style={{ accentColor: T.gold, cursor: "pointer", width: 15, height: 15 }}
                  />
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 13,
                      fontWeight: 600,
                      color: st !== "none" ? T.gold : T.text,
                    }}
                  >
                    {year}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => toggleExpand(year)}
                  aria-label={isExp ? "Collapse months" : "Expand months"}
                  style={{
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    color: T.textDim,
                    fontFamily: FONT_MONO,
                    fontSize: 14,
                    width: 28,
                    height: 28,
                    lineHeight: "26px",
                    textAlign: "center",
                    cursor: "pointer",
                    padding: 0,
                    flexShrink: 0,
                    borderRadius: 2,
                  }}
                >
                  {isExp ? "−" : "+"}
                </button>
              </div>

              {isExp && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 5,
                    padding: "2px 0 9px 26px",
                  }}
                >
                  {ms.map((mo) => {
                    const sel = selectedMonths.has(monthKey(year, mo));
                    return (
                      <button
                        key={mo}
                        type="button"
                        onClick={() => toggleMonth(year, mo)}
                        style={{
                          background: sel ? "rgba(201,169,97,0.18)" : "transparent",
                          border: `1px solid ${sel ? T.gold : T.border}`,
                          color: sel ? T.gold : T.textDim,
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          padding: "6px 10px",
                          minWidth: 44,
                          cursor: "pointer",
                          letterSpacing: "0.05em",
                          borderRadius: 2,
                        }}
                      >
                        {MONTHS[mo - 1]}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function linkBtn(color, FONT_MONO) {
  return {
    background: "transparent",
    border: "none",
    color,
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    cursor: "pointer",
    padding: 0,
  };
}
