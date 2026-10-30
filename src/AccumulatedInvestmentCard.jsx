import { useId, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { buildAccumulatedInvestment } from "./lib/accumulatedInvestment.js";

const PERIODS = ["Month", "Quarter", "Half", "Year"];
const TO_DATE_LABEL = { Month: "MTD", Quarter: "QTD", Half: "HTD", Year: "YTD" };
const PREVIOUS_LABEL = { Month: "M/M", Quarter: "Q/Q", Half: "H/H" };

function percent(value) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1, notation: Math.abs(value) >= 10000 ? "compact" : "standard",
  }).format(value)}%`;
}

export function GrowthTooltip({ active, payload, valuesHidden, groupBy, theme, font }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div style={{ background: theme.cardElev, border: `1px solid ${theme.border}`, borderRadius: 4,
      padding: "8px 12px", fontFamily: font, fontSize: 11, color: theme.text }}>
      <div style={{ color: theme.textDim, marginBottom: 4 }}>{row.label}</div>
      <div style={{ color: theme.gold }}>{valuesHidden ? "$ ****" : new Intl.NumberFormat("en-US", {
        style: "currency", currency: "USD",
      }).format(row.value)}</div>
      <div>Y/Y {percent(row.yoy)}</div>
      {groupBy !== "Year" && <div>{PREVIOUS_LABEL[groupBy]} {percent(row.previous)}</div>}
      {row.partial && <div style={{ color: theme.textDim, marginTop: 4 }}>{TO_DATE_LABEL[groupBy]}</div>}
    </div>
  );
}

export default function AccumulatedInvestmentCard({ transactions, usdBrlRate, valuesHidden,
  loading, error, today, theme: T, fontMono, cardStyle, goldAccent,
  CardToggle, dateInputStyle,
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
  const xInterval = rows.length > 12 ? Math.ceil(rows.length / 10) - 1 : 0;
  return (
    <section style={{ ...cardStyle, marginTop: 16, marginBottom: 0 }}>
      <div style={goldAccent} />
      <CardToggle label="Accumulated Investment" sub="Cumulative contributions / DELL excluded"
        open={open} onToggle={() => setOpen((value) => !value)} />
      {open && (
        <div style={{ padding: "0 20px 24px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {PERIODS.map((period) => (
              <button type="button" key={period} title={period} aria-label={period} aria-pressed={groupBy === period}
                onClick={() => setGroupBy(period)} style={{ ...buttonStyle, letterSpacing: "0.08em",
                  background: groupBy === period ? T.gold : T.cardElev,
                  borderColor: groupBy === period ? T.gold : T.border,
                  color: groupBy === period ? T.bg : T.textDim }}>
                {period[0]}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
            <label htmlFor={`${id}-from`} style={{ fontFamily: fontMono, fontSize: 11, color: T.textDim }}>From</label>
            <input id={`${id}-from`} aria-label="Accumulated investment from date" type="date"
              value={fromDate} onChange={(event) => setFromDate(event.target.value)} style={dateInputStyle} />
            <label htmlFor={`${id}-to`} style={{ fontFamily: fontMono, fontSize: 11, color: T.textDim }}>to</label>
            <input id={`${id}-to`} aria-label="Accumulated investment to date" type="date"
              value={toDate} onChange={(event) => setToDate(event.target.value)} style={dateInputStyle} />
            {(fromDate || toDate) && <button type="button" style={buttonStyle}
              onClick={() => { setFromDate(""); setToDate(""); }}>Clear</button>}
          </div>
          {loading ? <div style={{ color: T.textDim, fontFamily: fontMono, padding: "40px 0", textAlign: "center" }}>Loading...</div>
            : error ? <div role="alert" style={{ color: T.red, fontFamily: fontMono, padding: "40px 0", textAlign: "center" }}>{error}</div>
            : invalidRange ? <div role="alert" style={{ color: T.red, fontFamily: fontMono }}>From must be on or before to.</div>
            : !rows.length ? <div style={{ color: T.textDim, fontFamily: fontMono, padding: "40px 0", textAlign: "center" }}>
                No contributions in this period
              </div>
            : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 50 }} accessibilityLayer>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                  <XAxis dataKey="label" interval={xInterval} angle={-45} textAnchor="end"
                    tick={{ fontFamily: fontMono, fontSize: 11, fill: T.textDim }}
                    axisLine={{ stroke: T.border }} tickLine={false} height={55} />
                  <YAxis tickFormatter={(value) => valuesHidden ? "****" : `$${new Intl.NumberFormat("en-US", {
                    notation: "compact", maximumFractionDigits: 0,
                  }).format(value)}`} tick={{ fontFamily: fontMono, fontSize: 11, fill: T.textDim }}
                    axisLine={false} tickLine={false} width={44} />
                  <Tooltip trigger="click" content={(props) => <GrowthTooltip {...props} valuesHidden={valuesHidden}
                    groupBy={groupBy} theme={T} font={fontMono} />} />
                  <Bar dataKey="value" fill={T.gold} radius={[2, 2, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>
      )}
    </section>
  );
}
