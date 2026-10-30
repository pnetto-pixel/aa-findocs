import { useId, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList,
} from "recharts";
import { buildAccumulatedInvestment } from "./lib/accumulatedInvestment.js";

const PERIODS = ["Month", "Quarter", "Half", "Year"];
const PREVIOUS_LABEL = { Month: "M/M", Quarter: "Q/Q", Half: "H/H" };

function percent(value) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1, notation: Math.abs(value) >= 10000 ? "compact" : "standard",
  }).format(value)}%`;
}

function GrowthTooltip({ active, payload, valuesHidden, groupBy, theme, font }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div style={{ background: theme.cardElev, border: `1px solid ${theme.border}`, borderRadius: 4,
      padding: "8px 12px", fontFamily: font, fontSize: 11, color: theme.text }}>
      <div style={{ color: theme.textDim, marginBottom: 4 }}>{row.label}{row.partial ? " (in progress)" : ""}</div>
      <div style={{ color: theme.gold }}>{valuesHidden ? "$ ****" : new Intl.NumberFormat("en-US", {
        style: "currency", currency: "USD",
      }).format(row.value)}</div>
      <div>Y/Y {percent(row.yoy)}</div>
      {groupBy !== "Year" && <div>{PREVIOUS_LABEL[groupBy]} {percent(row.previous)}</div>}
      <div style={{ color: theme.textDim, marginTop: 4 }}>As of {row.asOf}</div>
    </div>
  );
}

export default function AccumulatedInvestmentCard({ transactions, usdBrlRate, valuesHidden,
  loading, error, today, theme: T, fontMono, fontBody, cardStyle, goldAccent,
  CardToggle, ScrollHintTable, dateInputStyle,
}) {
  const [open, setOpen] = useState(true);
  const [groupBy, setGroupBy] = useState("Month");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const id = useId();
  const rows = useMemo(() => buildAccumulatedInvestment(transactions, usdBrlRate, {
    groupBy, fromDate, toDate, today,
  }), [transactions, usdBrlRate, groupBy, fromDate, toDate, today]);
  const invalidRange = fromDate && toDate && fromDate > toDate;
  const buttonStyle = { background: T.cardElev, border: `1px solid ${T.border}`, borderRadius: 4,
    color: T.textDim, fontFamily: fontMono, fontSize: 11, padding: "5px 12px", cursor: "pointer" };
  const growthColor = (value) => value == null ? T.textDim : value < 0 ? T.red : T.green;
  function renderGrowth({ x, y, width, index }) {
    const row = rows[index];
    if (!row || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return (
      <text x={x + width / 2} y={y - (groupBy === "Year" ? 10 : 24)}
        textAnchor="middle" fontFamily={fontMono} fontSize={10}>
        <tspan x={x + width / 2} fill={growthColor(row.yoy)}>Y/Y {percent(row.yoy)}</tspan>
        {groupBy !== "Year" && (
          <tspan x={x + width / 2} dy={14} fill={growthColor(row.previous)}>
            {PREVIOUS_LABEL[groupBy]} {percent(row.previous)}
          </tspan>
        )}
      </text>
    );
  }
  return (
    <section style={{ ...cardStyle, marginTop: 16, marginBottom: 0 }}>
      <div style={goldAccent} />
      <CardToggle label="Accumulated Investment" sub="Cumulative contributions / DELL excluded"
        open={open} onToggle={() => setOpen((value) => !value)} />
      {open && (
        <div style={{ padding: "0 20px 24px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {PERIODS.map((period) => (
              <button type="button" key={period} aria-pressed={groupBy === period}
                onClick={() => setGroupBy(period)} style={{ ...buttonStyle, letterSpacing: "0.08em",
                  background: groupBy === period ? T.gold : T.cardElev,
                  borderColor: groupBy === period ? T.gold : T.border,
                  color: groupBy === period ? T.bg : T.textDim }}>
                {period}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <label htmlFor={`${id}-from`} style={{ fontFamily: fontMono, fontSize: 11, color: T.textDim }}>From</label>
            <input id={`${id}-from`} aria-label="Accumulated investment from date" type="date"
              value={fromDate} onChange={(event) => setFromDate(event.target.value)} style={dateInputStyle} />
            <label htmlFor={`${id}-to`} style={{ fontFamily: fontMono, fontSize: 11, color: T.textDim }}>to</label>
            <input id={`${id}-to`} aria-label="Accumulated investment to date" type="date"
              value={toDate} onChange={(event) => setToDate(event.target.value)} style={dateInputStyle} />
            {(fromDate || toDate) && <button type="button" style={buttonStyle}
              onClick={() => { setFromDate(""); setToDate(""); }}>Clear</button>}
          </div>
          <div style={{ fontFamily: fontBody, fontSize: 11, color: T.textDim, marginBottom: 16 }}>
            Period-ending contributions. Date filters select whole periods. * In progress.
          </div>
          {loading ? <div style={{ color: T.textDim, fontFamily: fontMono, padding: "40px 0", textAlign: "center" }}>Loading...</div>
            : error ? <div role="alert" style={{ color: T.red, fontFamily: fontMono, padding: "40px 0", textAlign: "center" }}>{error}</div>
            : invalidRange ? <div role="alert" style={{ color: T.red, fontFamily: fontMono }}>From must be on or before to.</div>
            : !rows.length ? <div style={{ color: T.textDim, fontFamily: fontMono, padding: "40px 0", textAlign: "center" }}>
                No contributions in this period
              </div>
            : (
              <ScrollHintTable>
                <div style={{ minWidth: Math.max(280, rows.length * 124 + 64), height: 300 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={rows} margin={{ top: 40, right: 12, left: 0, bottom: 12 }} accessibilityLayer>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                      <XAxis dataKey="label" interval={0} tickFormatter={(label, index) => `${label}${rows[index]?.partial ? " *" : ""}`}
                        tick={{ fontFamily: fontMono, fontSize: 11, fill: T.textDim }}
                        axisLine={{ stroke: T.border }} tickLine={false} height={35} />
                      <YAxis tickFormatter={(value) => valuesHidden ? "****" : `$${new Intl.NumberFormat("en-US", {
                        notation: "compact", maximumFractionDigits: 0,
                      }).format(value)}`} tick={{ fontFamily: fontMono, fontSize: 11, fill: T.textDim }}
                        axisLine={false} tickLine={false} width={52} />
                      <Tooltip trigger="click" content={(props) => <GrowthTooltip {...props} valuesHidden={valuesHidden}
                        groupBy={groupBy} theme={T} font={fontMono} />} />
                      <Bar dataKey="value" fill={T.gold} radius={[2, 2, 0, 0]} isAnimationActive={false}>
                        <LabelList dataKey="value" content={renderGrowth} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ScrollHintTable>
            )}
        </div>
      )}
    </section>
  );
}
