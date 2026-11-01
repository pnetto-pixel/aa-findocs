import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { groupHarvestCandidates } from "./lib/taxHarvest.js";

const T = {
  bg: "#0b0d10", card: "#13161b", cardElev: "#191d24", border: "#222831",
  borderSoft: "#1a1e25", text: "#ece8e0", textDim: "#8a8f99", textFaint: "#5a5f69",
  gold: "#c9a961", green: "#7dd3a4", red: "#e88c8c",
};
const MONO = "'JetBrains Mono', monospace";
const BODY = "'Manrope', sans-serif";
const emptyButton = { background: "none", border: 0, color: "inherit", cursor: "pointer", font: "inherit", WebkitTapHighlightColor: "transparent" };
const badgeStyle = { fontFamily: MONO, fontSize: 9, fontWeight: 600, letterSpacing: ".06em", padding: "3px 5px", borderRadius: 3, whiteSpace: "nowrap" };

function money(value, currency, hidden, signed = false) {
  if (hidden) return "••••";
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = signed && value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${currency === "BRL" ? "R$" : "$"}${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value))}`;
}

function percent(value, hidden) {
  if (hidden) return "••••";
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}%`;
}

function quantity(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
}

// Used by both the expanded holding and the portfolio-wide harvesting card.
export function TaxLotList({ lots = [], valuesHidden = false, compact = false }) {
  const [expanded, setExpanded] = useState(null);
  if (!lots.length) return <div style={{ color: T.textDim, fontSize: 11, padding: "10px 0" }}>No open lots.</div>;
  const sorted = [...lots].sort((a, b) => (a.gainLoss == null ? Infinity : a.gainLoss) - (b.gainLoss == null ? Infinity : b.gainLoss) || a.date.localeCompare(b.date));
  return <div style={{ fontFamily: MONO, fontSize: 11, minWidth: 0 }}>
    {!compact && <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 32px minmax(0,1.15fr)", gap: 6, color: T.textFaint, fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase", padding: "8px 0" }}>
      <span>Lot date</span><span style={{ textAlign: "right" }}>Qty</span><span style={{ textAlign: "right" }}>Gain / Loss</span>
    </div>}
    {sorted.map(lot => {
      const pnl = lot.gainLoss ?? (lot.loss == null ? null : -lot.loss);
      const color = pnl == null || pnl === 0 ? T.textDim : pnl < 0 ? T.red : T.green;
      const open = expanded === lot.buyId;
      return <div key={lot.buyId} style={{ borderTop: `1px solid ${T.borderSoft}` }}>
        <button type="button" aria-expanded={open} aria-label={`Lot ${lot.ticker} ${lot.date}, cost details`} onClick={() => setExpanded(open ? null : lot.buyId)}
          style={{ ...emptyButton, width: "100%", display: "grid", gridTemplateColumns: compact ? "minmax(0,1fr)" : "minmax(0,1fr) 32px minmax(0,1.15fr)", gap: compact ? 3 : 6, alignItems: "center", padding: "10px 0", textAlign: "left", minHeight: 44 }}>
          <span style={{ color: T.textDim, fontSize: 10, whiteSpace: "nowrap" }}>{lot.date}</span>
          <span style={{ color: T.text, textAlign: compact ? "left" : "right", overflowWrap: "anywhere" }}>{compact ? "Qty " : ""}{quantity(lot.qty)}</span>
          <span style={{ color, textAlign: compact ? "left" : "right", minWidth: 0, overflowWrap: "anywhere" }}>
            <span style={{ display: "block" }}>{money(pnl, lot.currency, valuesHidden, true)}</span>
            <span style={{ display: "block", fontSize: 10, marginTop: 2 }}>{percent(lot.gainLossPct, valuesHidden)}</span>
          </span>
        </button>
        {open && <div style={{ padding: "0 0 10px", color: T.textDim, fontSize: 10, lineHeight: 1.7 }}>
          Cost {money(lot.costPerShare, lot.currency, valuesHidden)} · Price {money(lot.currentPrice, lot.currency, valuesHidden)} <span style={{ color: T.textFaint }}>({lot.currency})</span>
          {lot.priorBuys?.length > 0 && <div style={{ color: T.gold }}>Recent shares would remain. Review a sale before {lot.clearDate}.</div>}
        </div>}
      </div>;
    })}
  </div>;
}

function CurrencyTotals({ totals, valuesHidden, color = T.red }) {
  const entries = Object.entries(totals || {}).filter(([, value]) => Number.isFinite(value) && value > 0);
  return <span style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "2px 10px", color, fontFamily: MONO, fontSize: 12 }}>
    {entries.length ? entries.map(([currency, total]) => <span key={currency}>{money(-total, currency, valuesHidden)} <span style={{ fontSize: 9, color: T.textDim }}>{currency}</span></span>) : <span style={{ color: T.textDim }}>{valuesHidden ? "••••" : "—"}</span>}
  </span>;
}

function HarvestGroup({ group, valuesHidden }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div style={{ borderTop: `1px solid ${T.borderSoft}` }}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}
      style={{ ...emptyButton, display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "13px 0", textAlign: "left", fontFamily: MONO }}>
      {open ? <ChevronDown size={12} style={{ flexShrink: 0, color: T.textDim }} /> : <ChevronRight size={12} style={{ flexShrink: 0, color: T.textDim }} />}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <strong style={{ fontSize: 12, color: T.text, overflowWrap: "anywhere" }}>{group.ticker}</strong>
          {group.restricted && <span style={{ ...badgeStyle, color: T.gold, background: "rgba(201,169,97,.08)" }}>REVIEW</span>}
        </span>
        <span style={{ color: T.textDim, fontSize: 10 }}>{group.lots.length} {group.lots.length === 1 ? "lot" : "lots"}</span>
      </span>
      <span style={{ fontSize: 12, color: T.red, textAlign: "right", overflowWrap: "anywhere" }}>{money(-group.totalLoss, group.currency, valuesHidden)} <span style={{ fontSize: 9, color: T.textDim }}>{group.currency}</span></span>
    </button>
    {open && <div id={id} style={{ padding: "0 0 8px" }}>
      {group.restricted && <div style={{ color: T.gold, fontFamily: BODY, fontSize: 11, lineHeight: 1.5, padding: "0 0 4px" }}>Recent purchases may affect this loss. Review before {group.clearDate}.</div>}
      <TaxLotList lots={group.lots} valuesHidden={valuesHidden} />
    </div>}
  </div>;
}

export function TaxHarvestingCard({ harvest, valuesHidden = false }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const summary = useMemo(() => groupHarvestCandidates(harvest?.candidates || []), [harvest?.candidates]);
  const available = summary.groups.filter(group => !group.restricted);
  const review = summary.groups.filter(group => group.restricted);
  const uncertain = harvest?.uncertainTickers || [];
  const incomplete = (harvest?.incompleteTickers || []).filter(ticker => !uncertain.includes(ticker));
  const unpriced = [...new Set((harvest?.openLots || []).filter(lot => lot.currentPrice == null).map(lot => lot.ticker))].filter(ticker => !uncertain.includes(ticker) && !incomplete.includes(ticker));
  const reviewCount = review.length + uncertain.length + incomplete.length + unpriced.length;
  const lotsCount = available.reduce((sum, group) => sum + group.lots.length, 0);
  return <section style={{ marginTop: 18, background: T.card, border: `1px solid ${T.borderSoft}`, borderRadius: 4, color: T.text }}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}
      style={{ ...emptyButton, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%", padding: "14px 16px", textAlign: "left" }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: MONO, fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: T.gold }}>
          {open ? <ChevronDown size={12} style={{ flexShrink: 0 }} /> : <ChevronRight size={12} style={{ flexShrink: 0 }} />} Tax Harvesting
        </span>
        <span style={{ display: "block", marginTop: 5, fontFamily: BODY, fontSize: 10, color: T.textDim }}>{available.length} {available.length === 1 ? "asset" : "assets"} · {lotsCount} {lotsCount === 1 ? "lot" : "lots"}{reviewCount > 0 ? ` · ${reviewCount} to review` : ""}</span>
      </span>
      <span style={{ textAlign: "right", minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: BODY, fontSize: 9, color: T.textDim, marginBottom: 4 }}>Potential loss</span>
        <CurrencyTotals totals={summary.totalsByCurrency} valuesHidden={valuesHidden} />
      </span>
    </button>
    {open && <div id={id} style={{ padding: "0 16px 12px" }}>
      {!available.length && <div style={{ padding: "12px 0", fontFamily: BODY, fontSize: 11, color: T.textDim }}>No unrestricted loss lots found.</div>}
      {available.map(group => <HarvestGroup key={group.key} group={group} valuesHidden={valuesHidden} />)}
      {reviewCount > 0 && <details style={{ borderTop: `1px solid ${T.borderSoft}`, padding: "10px 0", fontFamily: BODY, fontSize: 11 }}>
        <summary style={{ cursor: "pointer", color: T.gold, padding: "4px 0" }}>Needs review · {reviewCount}</summary>
        <div style={{ color: T.textDim, fontSize: 10, padding: "6px 0" }}>Excluded from the total above.</div>
        {review.map(group => <HarvestGroup key={group.key} group={group} valuesHidden={valuesHidden} />)}
        {uncertain.map(ticker => <div key={ticker} style={{ padding: "9px 0", borderTop: `1px solid ${T.borderSoft}`, lineHeight: 1.5 }}><strong style={{ fontFamily: MONO, color: T.text }}>{ticker}</strong><span style={{ color: T.textDim }}> · Check lot links or currency in Transactions.</span></div>)}
        {incomplete.map(ticker => <div key={ticker} style={{ padding: "9px 0", borderTop: `1px solid ${T.borderSoft}`, lineHeight: 1.5 }}><strong style={{ fontFamily: MONO, color: T.text }}>{ticker}</strong><span style={{ color: T.textDim }}> · Check purchase costs in Transactions.</span></div>)}
        {unpriced.map(ticker => <div key={ticker} style={{ padding: "9px 0", borderTop: `1px solid ${T.borderSoft}`, lineHeight: 1.5 }}><strong style={{ fontFamily: MONO, color: T.text }}>{ticker}</strong><span style={{ color: T.textDim }}> · Current price unavailable.</span></div>)}
      </details>}
      <details style={{ borderTop: `1px solid ${T.borderSoft}`, paddingTop: 10, color: T.textDim, fontFamily: BODY, fontSize: 10, lineHeight: 1.6 }}>
        <summary style={{ cursor: "pointer", width: "fit-content" }}><Info size={10} style={{ verticalAlign: "middle", marginRight: 4 }} />About this estimate</summary>
        <p style={{ margin: "8px 0 0" }}>Estimated loss at current prices, assuming all loss lots of each ticker are sold together. This is not estimated tax savings. Verify broker lots; other accounts and identical securities may not be included. Avoid replacement purchases during the 30 days after a loss sale. Selling only some lots can change the risk.</p>
      </details>
    </div>}
  </section>;
}

export function TaxStatusTag({ warning, lots = [], valuesHidden = false }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!warning && !lots.length) return null;
  return <div style={{ marginTop: 4, fontFamily: MONO, minWidth: 0 }}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}
      style={{ ...emptyButton, ...badgeStyle, color: T.gold, background: "rgba(201,169,97,.08)", border: "1px solid rgba(201,169,97,.22)", minHeight: 28 }}>
      {warning ? "WASH" : "TAX LOSS"}
    </button>
    {open && <div id={id} style={{ padding: "8px 0 2px", fontSize: 11, color: T.textDim, lineHeight: 1.5 }}>
      {warning ? <>Buy on or after <span style={{ color: T.gold }}>{warning.safeDate}</span>.</> : <>
        <div>Review loss lots before buying.</div>
        <TaxLotList lots={lots} valuesHidden={valuesHidden} compact />
      </>}
    </div>}
  </div>;
}
