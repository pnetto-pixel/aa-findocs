import { useState } from "react";
import { Info } from "lucide-react";
import InfoDialog from "./InfoDialog.jsx";

// Keep explanations out of the card body; usable beside labels and controls.
export default function InfoHelp({ title, children }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-label={`${title} information`} aria-haspopup="dialog" onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(true); }} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", verticalAlign: "middle", padding: 6, background: "none", border: 0, color: "#8a8f99", cursor: "pointer", flexShrink: 0 }}><Info size={14} /></button>
    {open && <InfoDialog title={title} onClose={() => setOpen(false)}>{children}</InfoDialog>}
  </>;
}
