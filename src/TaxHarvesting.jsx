import InfoHelp from "./InfoHelp.jsx";
import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Scissors, Info } from "lucide-react";
import InfoDialog from "./InfoDialog.jsx";
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
  return <div style={{ fontFamily: MONO, fontSize: 10, minWidth: 0, overflowX: "auto" }}>
    {!compact && <div style={{ display: "grid", gridTemplateColumns: "minmax(76px,1fr) 40px minmax(132px,1fr)", gap: 12, color: T.textFaint, fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase", padding: "8px 0", minWidth: 272 }}>
      <span>Lot date</span><span style={{ textAlign: "center" }}>Qty</span><span style={{ textAlign: "right" }}>Gain / Loss</span>
    </div>}
    {sorted.map(lot => {
      const pnl = lot.gainLoss ?? (lot.loss == null ? null : -lot.loss);
      const color = pnl == null || pnl === 0 ? T.textDim : pnl < 0 ? T.red : T.green;
      const open = expanded === lot.buyId;
      return <div key={lot.buyId} style={{ borderTop: `1px solid ${T.borderSoft}`, minWidth: compact ? 0 : 272 }}>
        <button type="button" aria-expanded={open} aria-label={`Lot ${lot.ticker} ${lot.date}, cost details`} onClick={() => setExpanded(open ? null : lot.buyId)}
          style={{ ...emptyButton, width: "100%", display: "grid", gridTemplateColumns: compact ? "minmax(0,1fr)" : "minmax(76px,1fr) 40px minmax(132px,1fr)", gap: compact ? 3 : 12, alignItems: "center", padding: "7px 0", textAlign: "left", minHeight: 36 }}>
          <span style={{ color: T.textDim, fontSize: 10, whiteSpace: "nowrap" }}>{lot.date}</span>
          <span style={{ color: T.text, textAlign: compact ? "left" : "center", overflowWrap: "anywhere" }}>{compact ? "Qty " : ""}{quantity(lot.qty)}</span>
          <span style={{ color, display: "inline-flex", alignItems: "baseline", justifyContent: compact ? "flex-start" : "flex-end", gap: 6, whiteSpace: "nowrap" }}>
            <span>{money(pnl, lot.currency, valuesHidden, true)}</span>
            <span style={{ fontSize: 10 }}>{percent(lot.gainLossPct, valuesHidden)}</span>
          </span>
        </button>
        {open && <div style={{ padding: "0 0 10px", color: T.textDim, fontSize: 10, lineHeight: 1.7 }}>
          Cost {money(lot.costPerShare, lot.currency, valuesHidden)} · Price {money(lot.currentPrice, lot.currency, valuesHidden)} <span style={{ color: T.textFaint }}>({lot.currency})</span>
          {lot.priorBuys?.length > 0 && <InfoHelp title="Purchase window">This ticker has a known purchase in the last 30 calendar days. The latest purchase leaves that window on {lot.clearDate}, if no new purchases occur. This is a risk flag, not a determination of deductible loss.</InfoHelp>}
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
      style={{ ...emptyButton, display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 0", textAlign: "left", fontFamily: MONO }}>
      {open ? <ChevronDown size={12} style={{ flexShrink: 0, color: T.textDim }} /> : <ChevronRight size={12} style={{ flexShrink: 0, color: T.textDim }} />}
      <span style={{ minWidth: 0, flex: 1, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 8px" }}>
        <strong style={{ fontSize: 12, color: T.text, overflowWrap: "anywhere" }}>{group.ticker}</strong>
        <span style={{ color: T.textDim, fontSize: 10, whiteSpace: "nowrap" }}>{group.lots.length} {group.lots.length === 1 ? "lot" : "lots"}</span>
      </span>
      <span style={{ fontSize: 12, color: T.red, textAlign: "right", overflowWrap: "anywhere" }}>{money(-group.totalLoss, group.currency, valuesHidden)} <span style={{ fontSize: 9, color: T.textDim }}>{group.currency}</span></span>
    </button>
    {open && <div id={id} style={{ padding: "0 0 8px" }}>
      <TaxLotList lots={group.lots} valuesHidden={valuesHidden} />
    </div>}
  </div>;
}

export function TaxHarvestingCard({ harvest, valuesHidden = false, onReviewTransactions }) {
  const [open, setOpen] = useState(false);
  const [recentHelp, setRecentHelp] = useState(false);
  const id = useId();
  const summary = useMemo(() => groupHarvestCandidates(harvest?.candidates || []), [harvest?.candidates]);
  const available = summary.groups.filter(group => !group.restricted);
  const review = summary.groups.filter(group => group.restricted);
  const uncertain = harvest?.uncertainTickers || [];
  const incomplete = (harvest?.incompleteTickers || []).filter(ticker => !uncertain.includes(ticker));
  const unpriced = [...new Set((harvest?.openLots || []).filter(lot => lot.currentPrice == null).map(lot => lot.ticker))].filter(ticker => !uncertain.includes(ticker) && !incomplete.includes(ticker));
  const unavailableCount = uncertain.length + incomplete.length + unpriced.length;
  const issues = {};
  const addIssue = (reason, ticker) => (issues[reason] ||= new Set()).add(ticker);
  for (const ticker of uncertain) for (const reason of harvest.uncertaintyReasons?.[ticker] || ["lot-links"]) addIssue(reason, ticker);
  for (const ticker of incomplete) addIssue("cost", ticker);
  for (const ticker of unpriced) addIssue("price", ticker);
  const issueLabels = {
    "unlinked-sale": ["Sold lots not linked", "In Transactions, open Tax on a sale and select the purchase lots it used."],
    "lot-links": ["Lot quantities need review", "Check the purchase lots and quantities linked to sales in Transactions."],
    "currency": ["Currency mismatch", "Check the currency and asset class of these transactions."],
    "invalid-date": ["Transaction dates missing or invalid", "Correct the dates in Transactions."],
    "invalid-transaction": ["Transaction details incomplete", "Check purchase quantities and duplicate entries in Transactions."],
    "cost": ["Purchase cost unavailable", "Check purchase prices and fees in Transactions."],
    "price": ["Current price unavailable", "Refresh prices in Holdings."],
  };
  const lotsCount = available.reduce((sum, group) => sum + group.lots.length, 0);
  return <section style={{ marginTop: 18, background: T.card, border: `1px solid ${T.borderSoft}`, borderRadius: 4, color: T.text }}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}
      style={{ ...emptyButton, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%", padding: "14px 16px", textAlign: "left" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: T.gold }}>
        <Scissors size={14} strokeWidth={2} /> Tax Harvesting
      </span>
      <ChevronDown size={16} style={{ color: T.textDim, transform: open ? "rotate(180deg)" : "none", transition: "transform .2s", flexShrink: 0 }} />
    </button>
    {open && <div id={id} style={{ padding: "0 16px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 0" }}>
        <span style={{ fontFamily: BODY, fontSize: 11, color: T.textDim }}>{available.length} {available.length === 1 ? "asset" : "assets"} · {lotsCount} {lotsCount === 1 ? "lot" : "lots"}</span>
        <span style={{ textAlign: "right" }}>
          <span style={{ display: "block", fontFamily: BODY, fontSize: 9, color: T.textDim, marginBottom: 4 }}>Potential loss</span>
          <CurrencyTotals totals={summary.totalsByCurrency} valuesHidden={valuesHidden} />
        </span>
      </div>
      {!available.length && <div style={{ padding: "12px 0", fontFamily: BODY, fontSize: 11, color: T.textDim }}>No loss lots without recent-purchase flags.</div>}
      {available.map(group => <HarvestGroup key={group.key} group={group} valuesHidden={valuesHidden} />)}
      {review.length > 0 && <details style={{ borderTop: `1px solid ${T.borderSoft}`, padding: "10px 0", fontFamily: BODY, fontSize: 11 }}>
        <summary style={{ cursor: "pointer", color: T.gold, padding: "4px 0" }}>Recent purchases · {review.length}<button type="button" aria-label="About recent purchases" aria-haspopup="dialog" onClick={event => { event.preventDefault(); event.stopPropagation(); setRecentHelp(true); }} style={{ ...emptyButton, display: "inline-flex", alignItems: "center", verticalAlign: "middle", padding: 6, marginLeft: 4, color: T.textDim }}><Info size={13} /></button></summary>
        {review.map(group => <HarvestGroup key={group.key} group={group} valuesHidden={valuesHidden} />)}
      </details>}
      {recentHelp && <InfoDialog title="Recent purchases" onClose={() => setRecentHelp(false)}>
        <p style={{ margin: "0 0 12px", color: T.textDim }}>These tickers have known purchases in the last 30 calendar days, including the purchase date and day +30. They stay here even if all lots are negative or you plan to sell everything. Their losses are excluded from the main total until this purchase-window flag expires. This is a review alert; it does not determine whether a trade is a wash sale or how much loss is deductible. Further purchases can extend the window.</p>
        {review.map(group => <div key={group.key} style={{ marginTop: 8 }}><strong>{group.ticker}</strong><span style={{ color: T.textDim }}> · Latest purchase leaves window {group.clearDate}</span></div>)}
      </InfoDialog>}
      {unavailableCount > 0 && <details style={{ borderTop: `1px solid ${T.borderSoft}`, padding: "10px 0", fontFamily: BODY, fontSize: 11 }}>
        <summary style={{ cursor: "pointer", color: T.textDim, padding: "4px 0" }}>Not calculated · {unavailableCount}</summary>
        <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 8 }} tabIndex={0} aria-label="Reasons some assets were not calculated">
          {Object.entries(issues).map(([reason, tickers]) => <div key={reason} style={{ padding: "8px 0" }}>
            <div style={{ color: T.text }}>{issueLabels[reason]?.[0] || "Lot history incomplete"}<InfoHelp title={issueLabels[reason]?.[0] || "Lot history incomplete"}>{issueLabels[reason]?.[1]}</InfoHelp></div>
            <div style={{ color: T.textDim, fontFamily: MONO, fontSize: 10, lineHeight: 1.8, overflowWrap: "anywhere", margin: "4px 0" }}>{[...tickers].sort().join(" · ")}</div>
          </div>)}
        </div>
        {onReviewTransactions && <button type="button" onClick={onReviewTransactions} style={{ ...emptyButton, fontSize: 11, color: T.gold, minHeight: 40, padding: "8px 0" }}>Open Transactions →</button>}
      </details>}

    </div>}
  </section>;
}

export function TaxStatusTag({ warning, lots = [], valuesHidden = false }) {
  const [open, setOpen] = useState(false);
  if (!warning && !lots.length) return null;
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}
      style={{ ...emptyButton, ...badgeStyle, color: T.gold, background: "rgba(201,169,97,.08)", border: "1px solid rgba(201,169,97,.22)", minHeight: 26, flexShrink: 0 }}>
      {warning ? "WASH" : "TAX LOSS"}
    </button>
    {open && <InfoDialog title={warning ? "Wash sale window" : "Loss lots"} onClose={() => setOpen(false)}>
      {warning ? <>Buy on or after <span style={{ color: T.gold }}>{warning.safeDate}</span>.</> : <>
        <div style={{ color: T.textDim, marginBottom: 8 }}>Review loss lots before buying.</div>
        <TaxLotList lots={lots} valuesHidden={valuesHidden} />
      </>}
    </InfoDialog>}
  </>;
}
