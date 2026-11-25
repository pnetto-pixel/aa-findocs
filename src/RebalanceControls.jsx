import { useEffect, useState } from "react";
import InfoHelp from "./InfoHelp.jsx";
import { parseBudgetCents } from "./lib/rebalanceBudget.js";

const mono = "'JetBrains Mono', monospace";
const dim = "#8a8f99";
const control = {
  background: "#191d24", border: "1px solid #222831", borderRadius: 4,
  color: "#ece8e0", padding: "7px 8px", minWidth: 0, maxWidth: "100%", fontSize: 13,
  colorScheme: "dark",
};
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 10, marginBottom: 12 };
const labelStyle = { display: "grid", gap: 4, fontFamily: mono, color: dim, fontSize: 11 };

function Choice({ label, value, onChange, options, disabled }) {
  return <label style={labelStyle}>{label}
    <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} style={control}>
      {options.map(([id, name, off]) => <option key={id} value={id} disabled={off}>{name}</option>)}
    </select>
  </label>;
}

export function PreferenceStatus({ settings }) {
  if (!settings.error && settings.phase !== "loading" && settings.phase !== "saving") return null;
  return <div role="status" style={{ fontSize: 12, color: dim, marginBottom: 8 }}>
    {settings.error || (settings.phase === "loading" ? "Loading settings…" : "Saving settings…")}
    {settings.phase === "unavailable" && <button type="button" onClick={settings.reload} style={{ ...control, marginLeft: 6 }}>Reload settings</button>}
  </div>;
}

function ExclusionList({ label, choices, selected, onChange, disabled }) {
  const [filter, setFilter] = useState("");
  const all = new Map(choices);
  for (const item of selected) if (!all.has(item)) all.set(item, item);
  const search = filter.trim().toLowerCase();
  return <details style={{ margin: "6px 0" }}>
    <summary>{label} ({selected.length})</summary>
    <input aria-label={`Search ${label.toLowerCase()}`} placeholder="Search" style={{ ...control, margin: "5px 0" }}
      value={filter} onChange={event => setFilter(event.target.value)} />
    <div style={{ maxHeight: 150, overflowY: "auto", display: "grid", gap: 3 }}>
      {[...all].filter(([id, name]) => `${id} ${name}`.toLowerCase().includes(search))
        .map(([id, name]) => <label key={id}>
          <input type="checkbox" disabled={disabled} checked={selected.includes(id)} onChange={event =>
            onChange(event.target.checked ? [...selected, id] : selected.filter(x => x !== id))} /> {name}
        </label>)}
    </div>
  </details>;
}

export function RebalanceControls({ settings, cashAccounts, cashAccountId, fundingSource, tickerOptions, classOptions, valuesHidden }) {
  const { preferences: p, save, phase } = settings;
  const dynamic = p.strategy === "dynamic";
  const disabled = phase !== "ready";
  const [draft, setDraft] = useState("");
  useEffect(() => { setDraft(p.customBudget == null ? "" : (p.customBudget / 100).toFixed(2)); }, [p.customBudget]);
  const amount = parseBudgetCents(draft);
  const canSaveAmount = amount !== p.customBudget && (amount != null || draft.trim() === "");
  return <>
    <PreferenceStatus settings={settings} />
    <div style={grid}>
      <Choice label="Strategy" value={p.strategy} disabled={disabled} onChange={strategy => save({ strategy })}
        options={[["standard", "Standard ($1K)"], ["dynamic", "Dynamic Ex-DELL"]]} />
      {dynamic && <Choice label="Budget mode" value={p.budgetMode} disabled={disabled} onChange={budgetMode => save({ budgetMode })}
        options={[["current", "Current Contribution Leftover"], ["monthly", "Monthly Leftover"], ["custom", "Custom Amount"],
          ["cash", "Available Cash", fundingSource !== "cash"]]} />}
      <Choice label="Funding source" value={fundingSource} disabled={disabled} onChange={source => save({
        [dynamic ? "fundingSource" : "standardFundingSource"]: source,
      })}
      options={[["cash", "Existing Cash"], ["new", "New Contribution", dynamic && p.budgetMode === "cash"]]} />
      {fundingSource === "cash" && <Choice label="Cash account" value={cashAccountId || ""} disabled={disabled} onChange={cashAccountId => save({ cashAccountId })}
        options={[["", "Select Cash account", true], ...cashAccounts.map(row => [row.id, row.name])]} />}
    </div>
    {dynamic && p.budgetMode === "custom" && <form onSubmit={event => {
      event.preventDefault();
      if (canSaveAmount && !disabled) save({ customBudget: amount });
    }} style={{ display: "flex", alignItems: "end", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
      <label style={labelStyle}>Custom budget (USD)
        <input type={valuesHidden ? "password" : "text"} value={draft} style={control} inputMode="decimal"
          autoComplete="off" disabled={disabled} onChange={event => setDraft(event.target.value)} />
      </label>
      <button type="submit" disabled={disabled || !canSaveAmount} style={control}>Save amount</button>
      {draft && amount == null && <span role="status" style={{ color: dim, fontSize: 12 }}>Enter a valid USD amount.</span>}
    </form>}
    {dynamic && <details style={{ color: dim, fontSize: 13, marginBottom: 12 }}>
      <summary>Purchase exclusions ({p.excludeTickers.length + p.excludeClasses.length})</summary>
      <ExclusionList label="Tickers" choices={tickerOptions} selected={p.excludeTickers}
        onChange={excludeTickers => save({ excludeTickers })} disabled={disabled} />
      <ExclusionList label="Asset classes" choices={classOptions} selected={p.excludeClasses}
        onChange={excludeClasses => save({ excludeClasses })} disabled={disabled} />
      <label><input type="checkbox" disabled={disabled} checked={p.washProtection}
        onChange={event => save({ washProtection: event.target.checked })} /> Exclude active wash sale warnings</label>
      <InfoHelp title="Wash sale warnings">The warning uses recorded harvesting sales and covers the sale day through day 30. It cannot establish complete tax compliance.</InfoHelp>
    </details>}
  </>;
}

function Details({ items }) {
  return <dl style={{ ...grid, marginTop: 10, fontFamily: mono, fontSize: 12 }}>
    {items.map(([name, value]) => <div key={name}>
      <dt style={{ color: dim }}>{name}</dt><dd style={{ margin: "3px 0 0", overflowWrap: "anywhere" }}>{value}</dd>
    </div>)}
  </dl>;
}

export function BudgetDetails({ date, plan, available, requested, money }) {
  const half = Number(date.slice(-2)) <= 15 ? 1 : 2;
  return <Details items={[
    ["Contribution period", `${date.slice(0, 7)} · ${half === 1 ? "Days 1–15" : "Day 16–month end"}`],
    ["Monthly target", plan ? money(plan.monthlyTarget) : "—"],
    ["Current-period target", plan ? money(plan.currentTarget) : "—"],
    ["Current-period invested", plan ? money(plan.currentInvested) : "—"],
    ["Monthly invested", plan ? money(plan.totalInvested) : "—"],
    ["Current-period leftover", plan ? money(plan.currentRemaining) : "—"],
    ["Monthly leftover", plan ? money(plan.monthRemaining) : "—"],
    ["Available Cash", available == null ? "—" : money(available / 100)],
    ["Purchase budget", requested == null ? "—" : money(requested / 100)],
  ]} />;
}

export function DynamicPreview({ result, money }) {
  const [mode, setMode] = useState("class");
  const gap = x => `${x > 0 ? "+" : ""}${x.toFixed(2)} pp`;
  return <>
    <Details items={[
      ["Estimated purchases", money(result.spent / 100)], ["Unused budget", money(result.leftover)],
      ["Projected Cash", money(result.projectedCash)],
    ]} />
    {result.limited && <div role="status" style={{ color: dim, fontSize: 12 }}>Search limit reached. Showing the best plan found.</div>}
    <details style={{ marginTop: 8, fontSize: 13 }}>
      <summary>Before and after allocation gaps</summary>
      <div style={{ margin: "6px 0" }}>
        <Choice label="Show gaps" value={mode} onChange={setMode} options={[["class", "By Class"], ["holding", "Per Holding"]]} />
      </div>
      <table style={{ width: "100%", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
        <thead><tr><th align="left">Asset</th><th align="right">Before buys</th><th align="right">After buys</th></tr></thead>
        <tbody>{result.gaps[mode].map(row => <tr key={row.id}>
          <th align="left" scope="row">{row.name}</th><td align="right">{gap(row.before)}</td><td align="right">{gap(row.after)}</td>
        </tr>)}</tbody>
      </table>
    </details>
  </>;
}
