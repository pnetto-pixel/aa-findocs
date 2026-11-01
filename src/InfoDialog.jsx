import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function InfoDialog({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);
  function onKeyDown(event) {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key !== "Tab") return;
    const nodes = [...ref.current.querySelectorAll('button, input, select, [tabindex="0"]')].filter(node => !node.disabled);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
  }
  return createPortal(<div onClick={event => { if (event.target === event.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.65)", boxSizing: "border-box", padding: "max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))" }}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown} style={{ boxSizing: "border-box", width: "100%", maxWidth: 440, maxHeight: "calc(100dvh - 64px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))", overflowY: "auto", padding: 16, borderRadius: 6, background: "#13161b", border: "1px solid #222831", color: "#ece8e0", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12 }}><strong>{title}</strong><button type="button" onClick={onClose} aria-label="Close information" style={{ background: "none", border: 0, color: "#8a8f99", padding: 8, display: "flex" }}><X size={16} /></button></div>
      {children}
    </div>
  </div>, document.body);
}
