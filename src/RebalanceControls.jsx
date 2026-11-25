import { useState } from "react";
import InfoHelp from "./InfoHelp.jsx";

const dim = "#8a8f99";
const control = {
  background: "#191d24", border: "1px solid #222831", borderRadius: 4,
  color: "#ece8e0", padding: "7px 8px", minWidth: 0, maxWidth: "100%", fontSize: 13,
  colorScheme: "dark", boxSizing: "border-box",
};

export function PreferenceStatus({ settings }) {
  if (!settings.error && settings.phase !== "loading" && settings.phase !== "saving") return null;
  return <div role="status" style={{ fontSize: 12, color: dim, marginBottom: 8 }}>
    {settings.error || (settings.phase === "loading" ? "Loading settings…" : "Saving settings…")}
    {settings.phase === "unavailable" && <button type="button" onClick={settings.reload} style={{ ...control, marginLeft: 6 }}>Reload settings</button>}
  </div>;
}

export function PurchaseExclusions({ settings, options }) {
  const { preferences, save, phase } = settings;
  const [filter, setFilter] = useState("");
  const search = filter.trim().toLowerCase();
  const groups = [
    { name: "Tickers", key: "excludeTickers", options: options.tickers },
    { name: "Asset classes", key: "excludeClasses", options: options.classes },
  ];
  const excluded = groups.flatMap(group =>
    group.options.filter(([id]) => preferences[group.key].includes(id)).map(([, label]) => label));
  const visible = groups.map(group => ({ ...group, options: group.options.filter(([id, label]) =>
    `${id} ${label}`.toLowerCase().includes(search)) }));

  return <details style={{ color: dim, fontSize: 13, marginBottom: 12 }}>
    <summary style={{ cursor: "pointer", overflowWrap: "anywhere" }}>
      Exclusions{excluded.length > 0 && <span style={{ color: "#ece8e0" }}>: {excluded.join(", ")}</span>}
    </summary>
    <div style={{ marginTop: 8, padding: 10, border: "1px solid #222831", borderRadius: 4 }}>
      <input type="search" aria-label="Search exclusions" placeholder="Search tickers or classes" style={{ ...control, width: "100%" }}
        value={filter} onChange={event => setFilter(event.target.value)} />
      <div style={{ maxHeight: 190, overflowY: "auto", margin: "6px 0" }}>
        {visible.every(group => !group.options.length) && <div>{search ? "No matching targets." : "No allocation targets to exclude."}</div>}
        {visible.filter(group => group.options.length).map(group => <fieldset key={group.key}
          style={{ border: 0, margin: "0 0 6px", padding: 0 }}>
          <legend>{group.name}</legend>
          {group.options.map(([id, label]) => <label key={id} style={{ display: "block", padding: "3px 0", color: "#ece8e0" }}>
            <input type="checkbox" disabled={phase !== "ready"} checked={preferences[group.key].includes(id)}
              onChange={event => save({ [group.key]: event.target.checked
                ? [...preferences[group.key], id] : preferences[group.key].filter(key => key !== id) })} /> {label}
          </label>)}
        </fieldset>)}
      </div>
      <label><input type="checkbox" disabled={phase !== "ready"} checked={preferences.washProtection}
        onChange={event => save({ washProtection: event.target.checked })} /> Exclude active wash sale warnings</label>
      <InfoHelp title="Wash sale warnings">The warning uses recorded harvesting sales and covers the sale day through day 30. It cannot establish complete tax compliance.</InfoHelp>
    </div>
  </details>;
}
