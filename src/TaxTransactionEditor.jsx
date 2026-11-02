import { saleLotOptions, saleLotGainLoss } from "./lib/taxSaleLots.js";
import InfoHelp from "./InfoHelp.jsx";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { currencyForAssetClass } from "./lib/parsing.js";

const T = { bg: "#0b0d10", card: "#13161b", border: "#222831", text: "#ece8e0", dim: "#8a8f99", gold: "#c9a961", red: "#e88c8c" };
const amountFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONO = "'JetBrains Mono', monospace";
const currencyOf = tx => tx.currency || currencyForAssetClass(tx.assetClass);
const tickerOf = tx => String(tx.ticker || "").trim().toUpperCase();

// A focused editor for fiscal metadata. Ordinary transaction fields stay in
// the existing inline editor, and the parent validates the complete ledger.
export default function TaxTransactionEditor({ transaction, transactions, onSave, onClose, busy, valuesHidden }) {
  const [harvestSale, setHarvestSale] = useState(!!transaction.harvestSale);
  const [saleId, setSaleId] = useState(transaction.harvestRebuySaleId || "");
  const [lotQty, setLotQty] = useState(() => Object.fromEntries((transaction.harvestLots || []).map(lot => [lot.buyId, String(lot.qty)])));
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const isSale = transaction.side === "sell";
  const currency = currencyOf(transaction);
  const match = tx => tickerOf(tx) === tickerOf(transaction) && currencyOf(tx) === currency && tx.date <= transaction.date;
  const lots = saleLotOptions(transactions, transaction);
  const sales = transactions.filter(tx => tx.side === "sell" && tx.harvestSale && match(tx)).sort((a, b) => b.date.localeCompare(a.date));
  const selectable = lots.filter(lot => lot.available > 1e-8);
  const allFull = selectable.length > 0 && selectable.every(lot => Math.abs(Number(lotQty[lot.id] || 0) - lot.available) < 1e-8);
  const anySelected = lots.some(lot => Number(lotQty[lot.id]) > 0);
  function updateQty(id, value) {
    setError("");
    setLotQty(previous => ({ ...previous, [id]: value }));
  }
  function selectAll(checked) {
    setError("");
    setLotQty(Object.fromEntries(lots.map(lot => [lot.id, checked && lot.available > 1e-8 ? String(lot.available) : ""])));
  }
  const allocated = Object.values(lotQty).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const money = (value, signed = false) => valuesHidden ? "••••" : value == null || !Number.isFinite(Number(value)) ? "—" : `${value < 0 ? "−" : signed && value > 0 ? "+" : ""}${currency === "BRL" ? "R$" : "$"}${amountFormatter.format(Math.abs(Number(value)))}`;

  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  function onKeyDown(event) {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    if (event.key !== "Tab") return;
    const nodes = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
    if (!nodes.length) { event.preventDefault(); return; }
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
  }

  async function save(event) {
    event.preventDefault();
    setError("");
    const allocations = [];
    for (const [buyId, value] of Object.entries(lotQty)) {
      if (value === "" || Number(value) === 0) continue;
      const qty = Number(value);
      if (!Number.isFinite(qty) || qty < 0) { setError("Check the lot quantities."); return; }
      if (isSale) {
        const lot = lots.find(lot => lot.id === buyId);
        if (!lot || qty > lot.available + 1e-8) { setError("A lot quantity exceeds its available balance. Check the selected quantities."); return; }
      }
      allocations.push({ buyId, qty });
    }
    if (isSale && allocations.reduce((sum, lot) => sum + lot.qty, 0) > Number(transaction.qty) + 1e-8) { setError("Selected lots exceed the recorded sale quantity."); return; }
    const patch = isSale ? { harvestSale, harvestLots: allocations } : { harvestRebuySaleId: saleId };
    const result = await onSave(transaction.id, patch);
    if (result) setError(result);
    else onClose();
  }

  const controlStyle = { background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 4, fontFamily: MONO, fontSize: 12, padding: "9px 10px", boxSizing: "border-box" };
  return createPortal(
    <div onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", padding: "max(16px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px))" }}>
      <form noValidate ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="tax-editor-title" onKeyDown={onKeyDown} onSubmit={save} style={{ width: "100%", maxWidth: 440, maxHeight: "calc(100dvh - 64px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))", overflowY: "auto", background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16, color: T.text, fontFamily: MONO, boxSizing: "border-box", outline: "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div><div id="tax-editor-title" style={{ fontSize: 14, fontWeight: 600 }}>{transaction.ticker} · Tax</div><div style={{ color: T.dim, fontSize: 10, marginTop: 4 }}>{transaction.date} · {isSale ? "Sell" : "Buy"} {transaction.qty}</div></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close tax editor" style={{ background: "none", color: T.dim, border: 0, padding: 10, display: "flex" }}><X size={16} /></button>
        </div>
        {isSale ? <>
          <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 12, padding: "16px 0" }}><input type="checkbox" checked={harvestSale} disabled={busy} onChange={event => setHarvestSale(event.target.checked)} style={{ accentColor: T.gold }} />Harvesting sale</label>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: T.dim, fontSize: 10, marginBottom: 8 }}><span>Sold lots<InfoHelp title="Sold lots">Check a lot to fill its entire available balance, or type the quantity sold for a partial lot. Select all fills every available lot; clear it to reset all quantities. Gain/loss previews the entered positive quantity, or the available balance for an unchecked lot, using this recorded sale price and proportional purchase/sale fees. Existing links remain unchanged until you edit them. Selected shares cannot exceed the recorded sale quantity.</InfoHelp></span><span>{Number(allocated.toFixed(6))} / {transaction.qty}</span></div>
          {selectable.length > 0 && <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 11, color: T.dim, padding: "4px 0 10px" }}>
            <input type="checkbox" aria-label="Select all lots" checked={allFull} ref={node => { if (node) node.indeterminate = anySelected && !allFull; }} aria-checked={anySelected && !allFull ? "mixed" : allFull} disabled={busy} onChange={event => selectAll(event.target.checked)} style={{ accentColor: T.gold }} />Select all
          </label>}
          {lots.length === 0 && <p style={{ color: T.dim, fontSize: 11 }}>No matching purchase lots.</p>}
          {lots.map(lot => {
            const selected = Number(lotQty[lot.id]) > 0;
            const selectedQty = selected ? Number(lotQty[lot.id]) : lot.available;
            const partial = selected && Math.abs(selectedQty - lot.available) > 1e-8;
            const pnl = saleLotGainLoss(lot, transaction, selectedQty);
            return <div key={lot.id} style={{ display: "flex", gap: 10, alignItems: "center", borderTop: `1px solid ${T.border}`, padding: "10px 0" }}>
              <input id={`tax-lot-${lot.id}`} aria-label={`Sell lot ${lot.date} ${lot.id}`} type="checkbox" checked={selected} ref={node => { if (node) node.indeterminate = partial; }} aria-checked={partial ? "mixed" : selected} disabled={busy || (!selected && lot.available <= 1e-8)} onChange={event => updateQty(lot.id, event.target.checked ? String(lot.available) : "")} style={{ accentColor: T.gold, flexShrink: 0 }} />
              <label htmlFor={`tax-lot-${lot.id}`} style={{ flex: 1, minWidth: 0, fontSize: 11, cursor: "pointer" }}>{lot.date}<span style={{ display: "block", color: T.dim, fontSize: 10, marginTop: 3 }}>{Number(lot.available.toFixed(6))} available · {money(lot.price)}</span></label>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                <input type="number" inputMode="decimal" min="0" max={lot.available} step="any" aria-label={`Quantity sold from ${lot.date} lot ${lot.id}`} value={lotQty[lot.id] ?? ""} placeholder="0" disabled={busy} onChange={event => updateQty(lot.id, event.target.value)} style={{ ...controlStyle, width: 82, textAlign: "right", padding: "6px 8px" }} />
                <span style={{ color: pnl == null || pnl === 0 ? T.dim : pnl < 0 ? T.red : "#7dd3a4", fontSize: 11, whiteSpace: "nowrap" }}>{money(pnl, true)}</span>
              </div>
            </div>;
          })}
          {allocated < Number(transaction.qty) && <div style={{ color: T.dim, fontSize: 10, marginTop: 8 }}>Unlinked shares <InfoHelp title="Unlinked shares">Link the sold quantity to its purchase lots to identify which shares remain. Unlinked shares leave remaining lots uncertain.</InfoHelp></div>}
        </> : <div style={{ marginTop: 18 }}>
          <label htmlFor="tax-rebuy-sale" style={{ display: "block", color: T.dim, fontSize: 11, marginBottom: 8 }}>Funded by harvesting sale</label>
          <select id="tax-rebuy-sale" value={saleId} disabled={busy} onChange={event => setSaleId(event.target.value)} style={{ ...controlStyle, width: "100%" }}>
            <option value="">None</option>
            {sales.map(sale => <option key={sale.id} value={sale.id}>{sale.date} · {sale.qty} · {money(Math.max(0, sale.qty * sale.price - (sale.fee || 0)))}</option>)}
          </select>
          {sales.length === 0 && <div style={{ color: T.dim, fontSize: 10, marginTop: 8 }}>No earlier harvesting sale for this ticker.</div>}
        </div>}
        {error && <div role="alert" style={{ color: T.red, fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button type="button" onClick={onClose} disabled={busy} style={controlStyle}>Cancel</button>
          <button type="submit" disabled={busy} style={{ ...controlStyle, color: T.bg, background: T.gold, borderColor: T.gold }}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </div>, document.body);
}
