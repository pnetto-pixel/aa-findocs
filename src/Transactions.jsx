// src/Transactions.jsx
// Chunk 1B: add form, chronological list, inline edit, direct delete, filters.
// Bulk paste + CSV upload land in 1C.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Pencil, X, Check, Upload, Download, AlertCircle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import DateMonthPicker from "./DateMonthPicker.jsx";
import {
  newId,
  ASSET_CLASS_IDS,
  currencyForAssetClass,
  CUSIP_RX,
  inferAssetClass,
  detectDateFormat,
  dupKey,
  parseRow,
  reparseWithCommaDecimal,
  parseCSVOrPaste,
  parseFidelityCSV,
} from "./lib/parsing.js";
import { buildKnownBondsByDescKey, backfillBondMetadata, generateSyntheticBondTicker } from "../lib/bond-meta.js";

const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_MONO = "'JetBrains Mono', 'Geist Mono', monospace";

// Theme tokens — mirrors App.jsx palette so the new view feels native.
const T = {
  bg: "#0b0d10",
  card: "#13161b",
  cardElev: "#191d24",
  border: "#222831",
  borderSoft: "#1a1e25",
  text: "#ece8e0",
  textDim: "#8a8f99",
  textFaint: "#5a5f69",
  gold: "#c9a961",
  green: "#7dd3a4",
  red: "#e88c8c",
};

function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

// Admin gate for the SimpleFin sync controls (docs/plans/simplefin-fidelity-feed.md).
// Duplicated from App.jsx's isUserAdmin/getAdminEmails (project convention: small
// helpers are duplicated per file rather than shared).
function getAdminEmails() {
  if (typeof window === "undefined") return [];
  const meta = document.querySelector('meta[name="admin-emails"]');
  const raw = meta?.content || "";
  if (!raw || raw.includes("%")) return [];
  return raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function isUserAdmin(auth) {
  if (!auth || auth.kind !== "google" || !auth.email) return false;
  return getAdminEmails().includes(auth.email.toLowerCase());
}

// Verify a ticker resolves against a price source (api/price).
// Returns "ok" (price found), "error" (source resolved but no such ticker),
// or "unknown" (transient/network failure — don't flag, retry later).
async function verifyTickerResolvable(ticker, auth) {
  try {
    const params = new URLSearchParams({ ticker, quoteOnly: "1" });
    const res = await fetch(`/api/price?${params.toString()}`, {
      headers: authHeaders(auth),
    });
    if (res.status === 401) {
      const err = new Error("Unauthorized");
      err.code = 401;
      throw err;
    }
    // 400/404/502 → the price source could not identify this ticker.
    if (res.status === 400 || res.status === 404 || res.status === 502) {
      return "error";
    }
    if (!res.ok) return "unknown"; // 5xx/transient — retry later
    const d = await res.json();
    if (d && d.error) return "error";
    if (d && d.price != null) return "ok";
    return "error";
  } catch (e) {
    if (e.code === 401) throw e;
    return "unknown"; // network failure — don't flag
  }
}

// Tickers we don't expect a price API to resolve (manual instruments).
// CUSIP-style bank bonds and cash-like classes are user-entered, not market-priced.
function shouldVerifyTicker(tx) {
  const t = (tx?.ticker || "").trim();
  if (!t) return false;
  if (CUSIP_RX.test(t.toUpperCase())) return false;
  if (/^tesouro-/i.test(t)) return false; // no public price source — entered manually
  const cls = (tx?.assetClass || "").toLowerCase();
  if (cls === "cash" || cls.startsWith("unallocated") || cls === "bank bonds" || cls === "bra fixed income") {
    return false;
  }
  return true;
}

// Last savedAt read from / written to the server for the transactions blob.
// Sent as expectedSavedAt on PUT so the server rejects the write (409) when
// another device saved in between, instead of silently overwriting it.
// Exported setter so App.jsx (which does its own GET for qty sync) can keep
// the marker fresh too.
let transactionsServerSavedAt = null;
export function noteTransactionsSavedAt(savedAt) {
  transactionsServerSavedAt = savedAt || null;
}

async function fetchTransactionsFromServer(auth) {
  const res = await fetch("/api/transactions", {
    headers: authHeaders(auth),
  });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (res.status === 503) {
    const err = new Error("Storage not configured");
    err.code = 503;
    throw err;
  }
  if (!res.ok) {
    let msg = `Storage ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  noteTransactionsSavedAt(data.savedAt);
  return data;
}

export async function saveTransactionsToServer(auth, transactions, bondIncome, splitEvents) {
  // bondIncome / splitEvents are optional; when omitted the server preserves
  // the existing value (read-modify-write), so non-import saves never wipe them.
  const body = { transactions, expectedSavedAt: transactionsServerSavedAt };
  if (Array.isArray(bondIncome)) body.bondIncome = bondIncome;
  if (Array.isArray(splitEvents)) body.splitEvents = splitEvents;
  const res = await fetch("/api/transactions", {
    method: "PUT",
    headers: {
      ...authHeaders(auth),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    // Another device saved after we last read — keep the stale marker so
    // further saves also fail; reloading the app is the way to resync.
    const err = new Error(
      "Transactions changed on another device. Reload the app to sync."
    );
    err.code = 409;
    throw err;
  }
  if (!res.ok) {
    let msg = `Save ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  noteTransactionsSavedAt(data.savedAt);
  return data;
}

// Fidelity automation staging (item 38, extended for the SimpleFin feed —
// docs/plans/simplefin-fidelity-feed.md Fase 1): read/clear/patch the
// `:fidelity-pending` blob. Uses normal user auth. Fail-silent: a user who
// never enabled the automation just gets an empty result.
async function fetchPendingFidelity(auth) {
  const empty = {
    transactions: [],
    bondIncome: [],
    balanceCandidates: [],
    unmapped: [],
    bondHoldings: [],
    bondBindings: {},
  };
  try {
    const res = await fetch("/api/fidelity-pending", { headers: authHeaders(auth) });
    if (!res.ok) return empty;
    const d = await res.json();
    return {
      transactions: Array.isArray(d.transactions) ? d.transactions : [],
      bondIncome: Array.isArray(d.bondIncome) ? d.bondIncome : [],
      balanceCandidates: Array.isArray(d.balanceCandidates) ? d.balanceCandidates : [],
      unmapped: Array.isArray(d.unmapped) ? d.unmapped : [],
      bondHoldings: Array.isArray(d.bondHoldings) ? d.bondHoldings : [],
      bondBindings: d.bondBindings && typeof d.bondBindings === "object" ? d.bondBindings : {},
      updatedAt: d.updatedAt || null,
      lastSync: d.lastSync || null,
      lastError: d.lastError || null,
    };
  } catch {
    return empty;
  }
}

// Same fallback key convention as api/fidelity-pending.js's bondHoldingKey —
// duplicated intentionally (that helper lives server-side, this needs to run
// in the browser) rather than imported, same "small pure helper duplicated
// across the API/client boundary" precedent as dupKey/bondKey elsewhere in
// this file.
function bondHoldingKey(h) {
  if (h.descKey) return h.descKey;
  return `raw:${String(h.description || "").trim().toUpperCase().replace(/\s+/g, " ")}`;
}

// Drops balance candidates that already match the current holding value.
// The sync merge (api/fidelity-pending.js) upserts by id on every run with no
// memory of prior approve/dismiss decisions — it can't compare against
// `holdings` (server has no access to it), so a value already applied (or
// coincidentally unchanged) keeps reappearing as "pending" every sync unless
// filtered here, where `holdings` is actually available.
function pruneUnchangedBalanceCandidates(candidates, holdings) {
  return (candidates || []).filter((c) => {
    const holdingId = c.kind === "cash" ? "cash-permanent" : "bank-bonds-aggregate";
    const h = holdings.find((h) => h.id === holdingId);
    // Bank Bonds carry a per-bond breakdown (bondMarketValues) that Position
    // Performance matches individually. Keep re-applying the candidate until
    // that map has been recorded at least once, even when the summed value is
    // unchanged — otherwise a first sync whose total happens to equal the last
    // one would leave the per-bond map empty and Performance stuck on cost.
    if (c.kind === "bank-bonds") {
      const bmv = h?.bondMarketValues;
      if (!bmv || typeof bmv !== "object" || Object.keys(bmv).length === 0) return true;
    }
    // Cash writes straight to manualValue; Bank Bonds' summed value lands in
    // marketValueOverride (see applyFidelityBalanceUpdate in App.jsx).
    const current = c.kind === "cash" ? h?.manualValue : h?.marketValueOverride;
    if (current == null || c.proposed == null) return true;
    return Math.round(current * 100) !== Math.round(c.proposed * 100);
  });
}

async function clearPendingFidelity(auth) {
  try {
    await fetch("/api/fidelity-pending", { method: "DELETE", headers: authHeaders(auth) });
  } catch {}
}

// Partial update of the staging blob — only the arrays passed are replaced;
// sync metadata (lastSync/lastError) is preserved server-side. Used after an
// approve/dismiss action to remove just the affected rows from staging
// without wiping everything else still pending.
// Returns true only when the server confirmed the write (HTTP 2xx). Callers
// that don't care (fire-and-forget removals) can ignore the return; callers
// that must not lie to the user (bond-match confirm) check it. Never throws —
// a network error resolves to false, keeping the un-awaited callers safe.
async function patchPendingFidelity(auth, patch) {
  try {
    const res = await fetch("/api/fidelity-pending", {
      method: "PUT",
      headers: { ...authHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchFidelitySyncStatus(auth) {
  try {
    const res = await fetch("/api/fidelity-pending?resource=status", { headers: authHeaders(auth) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtNum(n, digits = 4) {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
}

function fmtMoney(n, currency = "USD") {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// Compact price display: "$175.50" / "R$ 38.20".
function fmtPrice(n, currency = "USD") {
  if (n == null || isNaN(n)) return "—";
  const num = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return currency === "BRL" ? `R$ ${num}` : `$${num}`;
}

// --- Styled primitives (kept minimal; reuse App.jsx tokens) ----------------

function Input({ style, onEnter, ...props }) {
  return (
    <input
      {...props}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) onEnter();
      }}
      style={{
        background: T.cardElev,
        border: `1px solid ${T.border}`,
        color: T.text,
        padding: "10px 12px",
        fontSize: 14,
        fontFamily: FONT_MONO,
        borderRadius: 2,
        width: "100%",
        boxSizing: "border-box",
        outline: "none",
        ...style,
      }}
    />
  );
}

function Label({ children }) {
  return (
    <div
      style={{
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: "0.18em",
        color: T.textDim,
        textTransform: "uppercase",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

// --- Add/Edit Form ---------------------------------------------------------

function shouldSkipValidation(ticker, assetClass) {
  if (!ticker) return true;
  if (/^tesouro-/i.test(ticker)) return true;
  if (assetClass === "BRA Fixed Income") return true;
  if (assetClass === "Bank Bonds") return true;
  if (/^[0-9A-Z]{9}[0-9]$/.test(ticker)) return true;
  return false;
}

async function validateTickerViaAPI(ticker, auth) {
  try {
    const res = await fetch(`/api/price?ticker=${encodeURIComponent(ticker)}`, {
      headers: authHeaders(auth),
    });
    if (!res.ok) return { valid: false };
    return { valid: true };
  } catch {
    return { valid: true };
  }
}

function TransactionForm({ initial, knownTickers, onSubmit, onCancel, busy, auth }) {
  const isEdit = !!initial;
  const [date, setDate] = useState(initial?.date || todayISO());
  const [side, setSide] = useState(initial?.side || "buy");
  const [ticker, setTicker] = useState(initial?.ticker || "");
  const [qty, setQty] = useState(initial ? String(initial.qty) : "");
  const [price, setPrice] = useState(initial ? String(initial.price) : "");
  const [assetClass, setAssetClass] = useState(initial?.assetClass || "");
  const [fee, setFee] = useState(initial?.fee ? String(initial.fee) : "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [error, setError] = useState("");
  const [showTickerList, setShowTickerList] = useState(false);
  const [tickerValidating, setTickerValidating] = useState(false);
  const [tickerError, setTickerError] = useState("");
  // Bank Bonds synthetic-id generator (jul/2026, opt-in — see lib/bond-meta.js
  // generateSyntheticBondTicker). All useState hooks declared up-front here,
  // before any useMemo/useEffect below, to avoid the hook-ordering/TDZ issues
  // this area has hit before. No new useEffect: generation only runs on click.
  const [showBondGen, setShowBondGen] = useState(false);
  const [genCoupon, setGenCoupon] = useState("");
  const [genMaturity, setGenMaturity] = useState("");
  const [genIssuer, setGenIssuer] = useState("");
  const [bondGenMeta, setBondGenMeta] = useState(null); // { couponRate, maturityDate, shortName } once generated

  const currency = currencyForAssetClass(assetClass) || "USD";

  const tickerSuggestions = useMemo(() => {
    const q = ticker.trim().toUpperCase();
    if (!q) return [];
    return knownTickers
      .filter((t) => t.toUpperCase().includes(q) && t.toUpperCase() !== q)
      .slice(0, 6);
  }, [ticker, knownTickers]);

  // Auto-fill asset class from ticker when the field is still empty.
  useEffect(() => {
    if (assetClass) return;
    const inferred = inferAssetClass(ticker.trim());
    if (inferred) setAssetClass(inferred);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  // Bank Bonds: derive a synthetic ticker from coupon + maturity when no
  // CUSIP is available (no public source reports them any more, jul/2026).
  // Opt-in only (link/button, never automatic) — the resulting ticker stays
  // fully editable in the field above. See lib/bond-meta.js for the encoding
  // and why couponRate/maturityDate/shortName on the transaction (not the
  // ticker's shape) are what let future INTEREST/REDEMPTION rows auto-resolve.
  function handleGenerateBondId() {
    setError("");
    const coupon = parseFloat(genCoupon);
    if (!isFinite(coupon) || coupon <= 0) { setError("Coupon % required to generate an id"); return; }
    if (!genMaturity) { setError("Maturity date required to generate an id"); return; }
    const synthetic = generateSyntheticBondTicker(coupon, genMaturity);
    if (!synthetic) { setError("Could not generate an id from that coupon/maturity"); return; }
    // Same "COUPON% | MM/DD/YYYY" format extractBondMeta produces for
    // CSV-imported bonds and that computeBankBondsValueAt's accrual regex
    // (src/lib/bankBonds.js) expects.
    const [yyyy, mm, dd] = genMaturity.split("-");
    const notesStr = `${coupon.toFixed(2)}% | ${mm}/${dd}/${yyyy}`;
    setTicker(synthetic);
    setTickerError("");
    setNotes(notesStr);
    setBondGenMeta({
      couponRate: coupon,
      maturityDate: genMaturity,
      shortName: genIssuer.trim() || null,
    });
  }

  function handleSubmit() {
    setError("");
    if (tickerValidating) { setError("Validating ticker, please wait..."); return; }
    if (tickerError) { setError(tickerError); return; }
    const tkr = ticker.trim().toUpperCase();
    if (!tkr) return setError("Ticker required");
    if (!assetClass) return setError("Asset class required");
    const qn = parseFloat(qty);
    const pn = parseFloat(price);
    if (!isFinite(qn) || qn <= 0) return setError("Qty must be > 0");
    if (!isFinite(pn) || pn < 0) return setError("Price must be >= 0");
    const feeN = fee ? parseFloat(fee) : 0;
    if (fee && (!isFinite(feeN) || feeN < 0)) return setError("Fee invalid");
    if (!date) return setError("Date required");

    const tx = {
      id: initial?.id || newId(),
      date,
      side,
      ticker: tkr,
      assetClass,
      qty: qn,
      price: pn,
      currency,
      fee: feeN,
      notes: notes.trim(),
      // Only populated when the ticker above came from the synthetic-id
      // generator (bondGenMeta) — a manually-typed CUSIP or any other asset
      // class never gets these fields, same as before this feature.
      ...(assetClass === "Bank Bonds" && bondGenMeta && {
        couponRate: bondGenMeta.couponRate,
        maturityDate: bondGenMeta.maturityDate,
        shortName: bondGenMeta.shortName,
      }),
      createdAt: initial?.createdAt || new Date().toISOString(),
    };
    onSubmit(tx);
  }

  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.borderSoft}`,
        padding: 20,
        marginBottom: 18,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.2em",
          color: T.gold,
          textTransform: "uppercase",
          marginBottom: 14,
        }}
      >
        {isEdit ? "Edit Transaction" : "New Transaction"}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <div>
          <Label>Date</Label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div>
          <Label>Side</Label>
          <div style={{ display: "flex", gap: 6 }}>
            {["buy", "sell"].map((s) => {
              const active = side === s;
              return (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  style={{
                    flex: 1,
                    background: active
                      ? s === "buy"
                        ? "rgba(125, 211, 164, 0.12)"
                        : "rgba(232, 140, 140, 0.12)"
                      : "transparent",
                    border: `1px solid ${
                      active ? (s === "buy" ? T.green : T.red) : T.border
                    }`,
                    color: active ? (s === "buy" ? T.green : T.red) : T.textDim,
                    padding: "10px 12px",
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ gridColumn: "1 / -1", position: "relative" }}>
          <Label>Ticker</Label>
          <Input
            placeholder="AAPL, BBSE3, TESOURO-IPCA-2035..."
            value={ticker}
            onChange={(e) => { setTicker(e.target.value.toUpperCase()); setTickerError(""); }}
            onFocus={() => setShowTickerList(true)}
            onBlur={() => {
              setTimeout(() => setShowTickerList(false), 150);
              const tkr = ticker.trim().toUpperCase();
              if (tkr && !shouldSkipValidation(tkr, assetClass)) {
                setTickerValidating(true);
                setTickerError("");
                validateTickerViaAPI(tkr, auth)
                  .then(({ valid }) => {
                    if (!valid) setTickerError(`Ticker "${tkr}" not found. Check for typos.`);
                  })
                  .finally(() => setTickerValidating(false));
              }
            }}
            style={{ textTransform: "uppercase" }}
          />
          {tickerValidating && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>Checking ticker...</span>
          )}
          {tickerError && !tickerValidating && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.red || "#f87171" }}>{tickerError}</span>
          )}
          {showTickerList && tickerSuggestions.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                background: T.cardElev,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                zIndex: 10,
                maxHeight: 180,
                overflowY: "auto",
              }}
            >
              {tickerSuggestions.map((t) => (
                <button
                  key={t}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setTicker(t);
                    setShowTickerList(false);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: T.text,
                    padding: "8px 12px",
                    fontFamily: FONT_MONO,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {assetClass === "Bank Bonds" && !ticker.trim() && !showBondGen && (
          <div style={{ gridColumn: "1 / -1", marginTop: -6 }}>
            <button
              type="button"
              onClick={() => setShowBondGen(true)}
              style={{
                background: "transparent",
                border: "none",
                color: T.gold,
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.02em",
                cursor: "pointer",
                padding: 0,
                textDecoration: "underline",
              }}
            >
              Don't have a CUSIP? Generate ID from coupon + maturity
            </button>
          </div>
        )}

        {assetClass === "Bank Bonds" && showBondGen && (
          <div
            style={{
              gridColumn: "1 / -1",
              border: `1px solid ${T.border}`,
              background: T.cardElev,
              padding: 12,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.18em", color: T.textDim, textTransform: "uppercase" }}>
                Generate Synthetic Bond ID
              </div>
              <button
                type="button"
                onClick={() => setShowBondGen(false)}
                style={{ background: "transparent", border: "none", color: T.textDim, cursor: "pointer", padding: 0 }}
              >
                <X size={14} />
              </button>
            </div>
            <div>
              <Label>Coupon %</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="any"
                placeholder="3.95"
                value={genCoupon}
                onChange={(e) => setGenCoupon(e.target.value)}
              />
            </div>
            <div>
              <Label>Maturity date</Label>
              <Input
                type="date"
                value={genMaturity}
                onChange={(e) => setGenMaturity(e.target.value)}
              />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <Label>Issuer / Short Name (optional)</Label>
              <Input
                placeholder="WELLS FARGO BANK NATL ASSN CD"
                value={genIssuer}
                onChange={(e) => setGenIssuer(e.target.value.toUpperCase())}
              />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <button
                type="button"
                onClick={handleGenerateBondId}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.gold}`,
                  color: T.gold,
                  padding: "8px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Generate
              </button>
            </div>
          </div>
        )}

        <div>
          <Label>Quantity</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="any"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </div>
        <div>
          <Label>Price</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="any"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>

        <div>
          <Label>
            Asset Class
            {assetClass && (
              <span style={{ color: T.gold, marginLeft: 6, letterSpacing: 0 }}>
                ({currency})
              </span>
            )}
          </Label>
          <select
            value={assetClass}
            onChange={(e) => setAssetClass(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: T.cardElev,
              border: `1px solid ${T.border}`,
              color: assetClass ? T.text : T.textFaint,
              padding: "10px 12px",
              fontSize: 14,
              fontFamily: FONT_MONO,
              borderRadius: 2,
              outline: "none",
              cursor: "pointer",
            }}
          >
            <option value="">— Select —</option>
            {ASSET_CLASS_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Fee (optional)</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="any"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
          />
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <Label>Notes (optional)</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            color: T.red,
            fontFamily: FONT_MONO,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          onClick={handleSubmit}
          disabled={busy}
          style={{
            background: T.gold,
            border: "none",
            color: "#0b0d10",
            padding: "10px 16px",
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Check size={12} />
          {isEdit ? "Save" : "Add"}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            background: "transparent",
            border: `1px solid ${T.border}`,
            color: T.textDim,
            padding: "10px 16px",
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <X size={12} />
          Cancel
        </button>
      </div>
    </div>
  );
}

// --- Helpers: currency inference + table sort/filter -----------------------

// --- Filter dropdown popover ----------------------------------------------

// HeaderPopover: unified sort + filter popover anchored to a header cell.
// - Always shows sort buttons (asc/desc).
// - Filter section appears only when `filterable` is true.
// - Date column gets a year/month picker derived from actual transaction data.
function HeaderPopover({
  anchor,
  onClose,
  // sort
  sortDir, // "asc" | "desc"
  onSort,
  // filter
  filterable,
  options,
  selected,
  onChange,
  optionLabel,
  // date filter (multi-select months). dateMonths is a Set<"YYYY-MM">; a non-null
  // value (even empty) marks this as the date column and renders the picker.
  dateMonths,
  setDateMonths,
  // date options: Map<year(number), Set<month(number 1-based)>>
  dateOptions,
}) {
  const ref = useRef(null);
  const isDateFilter = !!dateMonths;

  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", handle);
    document.addEventListener("touchstart", handle);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("touchstart", handle);
    };
  }, [onClose]);

  const rect = anchor?.getBoundingClientRect();
  const POPOVER_W = 240;
  const style = rect
    ? {
        position: "fixed",
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_W - 8)),
        zIndex: 50,
        width: POPOVER_W,
      }
    : { display: "none" };

  const sectionLabel = {
    fontFamily: FONT_MONO,
    fontSize: 9,
    letterSpacing: "0.2em",
    color: T.textFaint,
    textTransform: "uppercase",
    marginBottom: 8,
  };

  function SortBtn({ dir, label }) {
    const active = sortDir === dir;
    return (
      <button
        onClick={() => onSort(dir)}
        style={{
          flex: 1,
          background: active ? "rgba(201, 169, 97, 0.12)" : "transparent",
          border: `1px solid ${active ? T.gold : T.border}`,
          color: active ? T.gold : T.textDim,
          padding: "8px 6px",
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      ref={ref}
      style={{
        ...style,
        background: T.cardElev,
        border: `1px solid ${T.border}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        padding: 12,
        maxHeight: 380,
        overflowY: "auto",
      }}
    >
      {/* Sort section */}
      <div style={sectionLabel}>Sort</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <SortBtn dir="asc" label="↑ Asc" />
        <SortBtn dir="desc" label="↓ Desc" />
      </div>

      {/* Filter section — multi-select year/month picker */}
      {filterable && isDateFilter && (
        <>
          <div
            style={{
              height: 1,
              background: T.border,
              marginBottom: 12,
            }}
          />
          <div style={sectionLabel}>Filter by month</div>
          <DateMonthPicker
            dateOptions={dateOptions}
            selectedMonths={dateMonths}
            onChange={setDateMonths}
            T={T}
            FONT_MONO={FONT_MONO}
          />
        </>
      )}

      {filterable && !isDateFilter && (
        <>
          <div
            style={{
              height: 1,
              background: T.border,
              marginBottom: 12,
            }}
          />
          <div style={sectionLabel}>Filter</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <button
              onClick={() => onChange(new Set(options))}
              style={{
                background: "transparent",
                border: "none",
                color: T.gold,
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                cursor: "pointer",
                padding: 0,
              }}
            >
              All
            </button>
            <button
              onClick={() => onChange(new Set())}
              style={{
                background: "transparent",
                border: "none",
                color: T.textDim,
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                cursor: "pointer",
                padding: 0,
              }}
            >
              None
            </button>
          </div>
          {options.length === 0 && (
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: T.textFaint,
                padding: 8,
              }}
            >
              No values
            </div>
          )}
          {options.map((opt) => {
            const checked = selected.has(opt);
            return (
              <label
                key={opt}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 4px",
                  cursor: "pointer",
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: T.text,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = new Set(selected);
                    if (checked) next.delete(opt);
                    else next.add(opt);
                    onChange(next);
                  }}
                  style={{ accentColor: T.gold }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {optionLabel ? optionLabel(opt) : opt}
                </span>
              </label>
            );
          })}
        </>
      )}
    </div>
  );
}

// --- ScrollHintTable ---------------------------------------------------
// Wraps a horizontally-scrollable table with edge fades (always shown while
// the content overflows) and a one-shot animated "Swipe" hint pill that
// teaches the horizontal-scroll gesture. Fades are persistent; the pill
// keeps bouncing to draw attention until the user actually scrolls
// horizontally, then it's dismissed globally (localStorage flag, no
// per-user scoping - low-risk UI preference).
const SCROLL_HINT_SEEN_KEY = "scrollHintSeen";

function ScrollHintTable({ children, style, leftFadeOffset = 0, fadeBg = T.card }) {
  const scrollRef = useRef(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);
  const [pillPhase, setPillPhase] = useState("hidden"); // "hidden" | "visible" | "fading"
  const [bounce, setBounce] = useState(false);

  function hasSeenHint() {
    try {
      return localStorage.getItem(SCROLL_HINT_SEEN_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function dismissPill() {
    try {
      localStorage.setItem(SCROLL_HINT_SEEN_KEY, "1");
    } catch (e) {}
    setPillPhase((p) => (p === "hidden" ? p : "fading"));
    setTimeout(() => setPillPhase((p) => (p === "fading" ? "hidden" : p)), 320);
  }

  function measure() {
    const el = scrollRef.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 1;
    setShowRightFade(overflow && el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
    setShowLeftFade(el.scrollLeft > 4);
    if (overflow && !hasSeenHint()) {
      setPillPhase((p) => (p === "hidden" ? "visible" : p));
    }
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    } else {
      window.addEventListener("resize", measure);
    }
    return () => {
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pillPhase !== "visible") return;
    let reduceMotion = false;
    try {
      reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {}
    if (reduceMotion) return;
    const id = setInterval(() => {
      setBounce((b) => !b);
    }, 700);
    return () => clearInterval(id);
  }, [pillPhase]);

  function handleScroll() {
    measure();
    const el = scrollRef.current;
    if (el && el.scrollLeft > 4) dismissPill();
  }

  return (
    <div style={{ position: "relative" }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", ...style }}
      >
        {children}
      </div>
      {showRightFade && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: 28,
            pointerEvents: "none",
            background: `linear-gradient(to right, transparent, ${fadeBg} 75%)`,
          }}
        />
      )}
      {showLeftFade && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: leftFadeOffset,
            width: 28,
            pointerEvents: "none",
            background: `linear-gradient(to left, transparent, ${fadeBg} 75%)`,
          }}
        />
      )}
      {pillPhase !== "hidden" && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            right: 10,
            background: "rgba(19,22,27,0.9)",
            border: `1px solid ${T.borderSoft}`,
            borderRadius: 12,
            padding: "4px 10px",
            display: "flex",
            alignItems: "center",
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: T.textDim,
            opacity: pillPhase === "visible" ? 1 : 0,
            transition: "opacity 0.3s ease",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          <span>Swipe</span>
          <ChevronRight
            size={12}
            color={T.gold}
            style={{ marginLeft: 3, transform: bounce ? "translateX(6px)" : "translateX(0)", transition: "transform 0.7s ease-in-out" }}
          />
          <ChevronRight
            size={12}
            color={T.gold}
            style={{ marginLeft: -8, transform: bounce ? "translateX(6px)" : "translateX(0)", transition: "transform 0.7s ease-in-out" }}
          />
        </div>
      )}
    </div>
  );
}

// --- TransactionTable ------------------------------------------------------

function TransactionTable({
  transactions,
  onEdit,
  onDelete,
  onUpdate,
  onBulkDelete,
  onBulkAssetClass,
  busy,
  valuesHidden,
  tickerStatus = {},
  checkingTickers,
}) {
  const [openCol, setOpenCol] = useState(null); // column key for popover
  const [anchor, setAnchor] = useState(null);
  const [selected, setSelected] = useState(() => new Set()); // tx ids
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null); // edit buffer
  const [bulkClassMenu, setBulkClassMenu] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  // Each filter: Set of allowed values; if empty, treat as "all" (no filter).
  // Defaults are computed lazily from the data.
  const allValues = useMemo(() => {
    const s = new Set();
    const t = new Set();
    const a = new Set();
    for (const tx of transactions) {
      s.add(tx.side);
      t.add(tx.ticker);
      if (tx.assetClass) a.add(tx.assetClass);
    }
    return {
      side: Array.from(s).sort(),
      ticker: Array.from(t).sort(),
      assetClass: Array.from(a).sort(),
    };
  }, [transactions]);

  // Date options: Map<year(number), Set<month(number 1-based)>> for the date picker.
  const dateOptions = useMemo(() => {
    const map = new Map();
    for (const tx of transactions) {
      if (!tx.date) continue;
      const m = tx.date.match(/^(\d{4})-(\d{2})/);
      if (!m) continue;
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      if (!map.has(year)) map.set(year, new Set());
      map.get(year).add(month);
    }
    return map;
  }, [transactions]);

  const [filters, setFilters] = useState({
    side: new Set(),
    ticker: new Set(),
    assetClass: new Set(),
    dateMonths: new Set(), // Set<"YYYY-MM">; empty = no date filter
  });

  const [sort, setSort] = useState({ col: "date", dir: "desc" });

  function isFiltered(col) {
    if (col === "date") return filters.dateMonths.size > 0;
    const f = filters[col];
    if (!f) return false;
    return f.size > 0 && f.size < allValues[col].length;
  }

  const visible = useMemo(() => {
    let list = transactions.filter((t) => {
      if (filters.side.size > 0 && !filters.side.has(t.side)) return false;
      if (filters.ticker.size > 0 && !filters.ticker.has(t.ticker)) return false;
      if (filters.assetClass.size > 0 && !filters.assetClass.has(t.assetClass)) return false;
      if (filters.dateMonths.size > 0 && !filters.dateMonths.has(String(t.date || "").slice(0, 7))) return false;
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const ka = a[sort.col];
      const kb = b[sort.col];
      if (sort.col === "qty" || sort.col === "price" || sort.col === "fee") {
        return ((Number(ka) || 0) - (Number(kb) || 0)) * dir;
      }
      const sa = String(ka ?? "");
      const sb = String(kb ?? "");
      if (sa === sb) return 0;
      return (sa < sb ? -1 : 1) * dir;
    });
    return list;
  }, [transactions, filters, sort]);

  function setSortFor(col, dir) {
    setSort({ col, dir });
  }

  // Returns "asc" | "desc" for the popover to show the currently active dir
  // when this column is the active sort, otherwise a sensible default.
  function sortDirFor(col) {
    if (sort.col === col) return sort.dir;
    return col === "date" ? "desc" : "asc";
  }

  function toggleSelect(id) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function toggleSelectAllVisible() {
    setSelected((cur) => {
      const visibleIds = visible.map((t) => t.id);
      const allSelected = visibleIds.every((id) => cur.has(id));
      const next = new Set(cur);
      if (allSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  function startEdit(tx) {
    setEditingId(tx.id);
    setDraft({
      date: tx.date,
      side: tx.side,
      assetClass: tx.assetClass || "",
      ticker: tx.ticker,
      qty: String(tx.qty),
      price: String(tx.price),
      fee: tx.fee ? String(tx.fee) : "",
      notes: tx.notes || "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  function commitEdit() {
    if (!draft || !editingId) return;
    const original = transactions.find((t) => t.id === editingId);
    if (!original) {
      cancelEdit();
      return;
    }
    const qn = parseFloat(draft.qty);
    const pn = parseFloat(draft.price);
    const feeN = draft.fee ? parseFloat(draft.fee) : 0;
    if (!draft.date) return;
    if (!isFinite(qn) || qn <= 0) return;
    if (!isFinite(pn) || pn < 0) return;
    if (draft.fee && (!isFinite(feeN) || feeN < 0)) return;
    if (!draft.assetClass) return;
    const tkr = draft.ticker.trim().toUpperCase();
    if (!tkr) return;
    const cur = currencyForAssetClass(draft.assetClass) || "USD";
    const updated = {
      ...original,
      date: draft.date,
      side: draft.side,
      assetClass: draft.assetClass,
      ticker: tkr,
      qty: qn,
      price: pn,
      currency: cur,
      fee: feeN,
      notes: draft.notes.trim(),
    };
    if (typeof onUpdate === "function") onUpdate(updated);
    cancelEdit();
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    if (typeof onBulkDelete === "function") {
      await onBulkDelete(Array.from(selected));
    }
    clearSelection();
    setConfirmBulkDelete(false);
  }

  async function handleBulkAssetClass(cls) {
    if (selected.size === 0) return;
    if (typeof onBulkAssetClass === "function") {
      await onBulkAssetClass(Array.from(selected), cls);
    }
    setBulkClassMenu(false);
    clearSelection();
  }

  function HeaderCell({ col, label, align = "left", width }) {
    const filtered = isFiltered(col);
    const sorted = sort.col === col;
    const active = sorted || filtered;
    return (
      <th
        style={{
          padding: 0,
          textAlign: align,
          borderBottom: `1px solid ${T.border}`,
          background: T.card,
          width,
          position: "sticky",
          top: 0,
          zIndex: 2,
        }}
      >
        <button
          onClick={(e) => {
            if (openCol === col) {
              setOpenCol(null);
              setAnchor(null);
            } else {
              setOpenCol(col);
              setAnchor(e.currentTarget);
            }
          }}
          title={`${label} — sort & filter`}
          style={{
            width: "100%",
            background: "transparent",
            border: "none",
            color: active ? T.gold : T.textDim,
            padding: "10px 6px",
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            textAlign: align,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
            justifyContent: align === "right" ? "flex-end" : "flex-start",
          }}
        >
          {label}
          {sorted && (
            <span style={{ fontSize: 9 }}>{sort.dir === "asc" ? "↑" : "↓"}</span>
          )}
          {filtered && !sorted && (
            <span style={{ fontSize: 9, color: T.gold }}>•</span>
          )}
        </button>
      </th>
    );
  }

  function setColFilter(col, next) {
    setFilters((cur) => ({ ...cur, [col]: next }));
  }

  return (
    <div>
      {/* Bulk toolbar */}
      {selected.size > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: T.cardElev,
            border: `1px solid ${T.gold}`,
            padding: "10px 12px",
            marginBottom: 8,
            fontFamily: FONT_MONO,
            fontSize: 11,
            position: "relative",
          }}
        >
          <span style={{ color: T.gold, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            {selected.size} selected
          </span>
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setBulkClassMenu((v) => !v)}
              disabled={busy}
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                color: T.text,
                padding: "6px 10px",
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              Change class ▾
            </button>
            {bulkClassMenu && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 4,
                  background: T.cardElev,
                  border: `1px solid ${T.border}`,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                  zIndex: 30,
                  minWidth: 180,
                }}
              >
                {ASSET_CLASS_IDS.map((id) => (
                  <button
                    key={id}
                    onClick={() => handleBulkAssetClass(id)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: T.text,
                      padding: "8px 12px",
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setConfirmBulkDelete(true)}
            disabled={busy}
            style={{
              background: "transparent",
              border: `1px solid ${T.red}`,
              color: T.red,
              padding: "6px 10px",
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Delete
          </button>
          <button
            onClick={clearSelection}
            style={{
              background: "transparent",
              border: "none",
              color: T.textDim,
              padding: "4px 6px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
            title="Clear selection"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Confirm bulk delete modal */}
      {confirmBulkDelete && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
          onClick={() => setConfirmBulkDelete(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.cardElev,
              border: `1px solid ${T.red}`,
              padding: 20,
              maxWidth: 360,
              width: "100%",
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.2em",
                color: T.red,
                textTransform: "uppercase",
                marginBottom: 10,
              }}
            >
              Confirm delete
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.text, marginBottom: 16, lineHeight: 1.5 }}>
              Delete {selected.size} transaction{selected.size === 1 ? "" : "s"}? This cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleBulkDelete}
                disabled={busy}
                style={{
                  background: T.red,
                  border: "none",
                  color: "#0b0d10",
                  padding: "10px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmBulkDelete(false)}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.border}`,
                  color: T.textDim,
                  padding: "10px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

    <ScrollHintTable fadeBg={T.bg}>
    <div style={{ position: "relative", border: `1px solid ${T.borderSoft}` }}>
      <table
        style={{
          width: "100%",
          minWidth: 760,
          borderCollapse: "collapse",
          fontFamily: FONT_MONO,
          fontSize: 11,
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          <col style={{ width: "28px" }} />
          <col style={{ width: "90px" }} />
          <col style={{ width: "36px" }} />
          <col style={{ width: "110px" }} />
          <col style={{ width: "74px" }} />
          <col style={{ width: "56px" }} />
          <col style={{ width: "80px" }} />
          <col style={{ width: "70px" }} />
          <col style={{ width: "auto" }} />
          <col style={{ width: "56px" }} />
        </colgroup>
        <thead>
          <tr>
            <th
              style={{
                padding: "10px 4px",
                borderBottom: `1px solid ${T.border}`,
                background: T.card,
                position: "sticky",
                top: 0,
                zIndex: 2,
                textAlign: "center",
              }}
            >
              <input
                type="checkbox"
                checked={
                  visible.length > 0 &&
                  visible.every((t) => selected.has(t.id))
                }
                onChange={toggleSelectAllVisible}
                style={{ accentColor: T.gold, cursor: "pointer" }}
                title="Select all visible"
              />
            </th>
            <HeaderCell col="date" label="Date" />
            <HeaderCell col="side" label="B/S" />
            <HeaderCell col="assetClass" label="Class" />
            <HeaderCell col="ticker" label="Ticker" />
            <HeaderCell col="qty" label="Qty" align="right" />
            <HeaderCell col="price" label="Price" align="right" />
            <HeaderCell col="fee" label="Fee" align="right" />
            <HeaderCell col="notes" label="Notes" />
            <th
              style={{
                padding: "10px 4px",
                borderBottom: `1px solid ${T.border}`,
                background: T.card,
                position: "sticky",
                top: 0,
                zIndex: 2,
              }}
            />
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td
                colSpan={10}
                style={{
                  padding: 32,
                  textAlign: "center",
                  color: T.textDim,
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                }}
              >
                {transactions.length === 0
                  ? "No transactions yet - tap New to add your first."
                  : "No matches for current filters."}
              </td>
            </tr>
          ) : (
            visible.map((tx) => {
              const isBuy = tx.side === "buy";
              const cur = tx.currency || currencyForAssetClass(tx.assetClass) || "USD";
              const feeStr = tx.fee ? fmtPrice(tx.fee, cur) : "—";
              const isEditing = editingId === tx.id;
              const isSelected = selected.has(tx.id);

              if (isEditing && draft) {
                // Inline edit row
                const cellStyle = {
                  padding: "4px 2px",
                  verticalAlign: "middle",
                };
                const inputStyle = {
                  width: "100%",
                  boxSizing: "border-box",
                  background: T.cardElev,
                  border: `1px solid ${T.gold}`,
                  color: T.text,
                  padding: "4px 4px",
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  outline: "none",
                };
                const onKey = (e) => {
                  if (e.key === "Enter") commitEdit();
                  else if (e.key === "Escape") cancelEdit();
                };
                return (
                  <tr
                    key={tx.id}
                    style={{
                      borderBottom: `1px solid ${T.gold}`,
                      background: "rgba(201, 169, 97, 0.04)",
                    }}
                  >
                    <td style={{ ...cellStyle, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(tx.id)}
                        style={{ accentColor: T.gold, cursor: "pointer" }}
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="date"
                        value={draft.date}
                        onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                        onKeyDown={onKey}
                        style={inputStyle}
                      />
                    </td>
                    <td style={cellStyle}>
                      <select
                        value={draft.side}
                        onChange={(e) => setDraft({ ...draft, side: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, cursor: "pointer" }}
                      >
                        <option value="buy">B</option>
                        <option value="sell">S</option>
                      </select>
                    </td>
                    <td style={cellStyle}>
                      <select
                        value={draft.assetClass}
                        onChange={(e) => setDraft({ ...draft, assetClass: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, cursor: "pointer" }}
                      >
                        {ASSET_CLASS_IDS.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="text"
                        value={draft.ticker}
                        onChange={(e) => setDraft({ ...draft, ticker: e.target.value.toUpperCase() })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, textTransform: "uppercase" }}
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={draft.qty}
                        onChange={(e) => setDraft({ ...draft, qty: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, textAlign: "right" }}
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={draft.price}
                        onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, textAlign: "right" }}
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={draft.fee}
                        onChange={(e) => setDraft({ ...draft, fee: e.target.value })}
                        onKeyDown={onKey}
                        style={{ ...inputStyle, textAlign: "right" }}
                        placeholder="0"
                      />
                    </td>
                    <td style={cellStyle}>
                      <input
                        type="text"
                        value={draft.notes}
                        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                        onKeyDown={onKey}
                        style={inputStyle}
                        placeholder="notes"
                      />
                    </td>
                    <td style={{ padding: "4px 2px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        onClick={commitEdit}
                        disabled={busy}
                        title="Save (Enter)"
                        style={{
                          background: "transparent",
                          border: `1px solid ${T.green}`,
                          color: T.green,
                          padding: "3px 4px",
                          marginRight: 2,
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <Check size={10} />
                      </button>
                      <button
                        onClick={cancelEdit}
                        title="Cancel (Esc)"
                        style={{
                          background: "transparent",
                          border: `1px solid ${T.border}`,
                          color: T.textDim,
                          padding: "3px 4px",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <X size={10} />
                      </button>
                    </td>
                  </tr>
                );
              }

              return (
                <tr
                  key={tx.id}
                  style={{
                    borderBottom: `1px solid ${T.borderSoft}`,
                    background: isSelected ? "rgba(201, 169, 97, 0.06)" : "transparent",
                  }}
                  onDoubleClick={() => startEdit(tx)}
                  title={
                    tx.notes
                      ? `${tx.assetClass || "—"} · fee ${feeStr}\n${tx.notes}`
                      : `${tx.assetClass || "—"} · fee ${feeStr}`
                  }
                >
                  <td style={{ padding: "8px 4px", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(tx.id)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ accentColor: T.gold, cursor: "pointer" }}
                    />
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: T.text,
                      whiteSpace: "nowrap",
                      fontSize: 10,
                    }}
                  >
                    {tx.date}
                  </td>
                  <td style={{ padding: "8px 4px" }}>
                    <span
                      style={{
                        fontSize: 9,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        padding: "2px 5px",
                        background: isBuy
                          ? "rgba(125, 211, 164, 0.1)"
                          : "rgba(232, 140, 140, 0.1)",
                        color: isBuy ? T.green : T.red,
                        border: `1px solid ${isBuy ? T.green : T.red}`,
                      }}
                    >
                      {tx.side === "buy" ? "B" : "S"}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: T.textDim,
                      fontSize: 10,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tx.assetClass || "—"}
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: T.text,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {tickerStatus[(tx.ticker || "").toUpperCase()] === "error" && (
                        <span
                          title="Price source could not identify this ticker — check for typos or fix the symbol"
                          style={{ display: "inline-flex", flexShrink: 0 }}
                        >
                          <AlertCircle size={12} style={{ color: T.red }} />
                        </span>
                      )}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                        {tx.ticker}
                      </span>
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: T.text,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmtNum(tx.qty, 0)}
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: valuesHidden ? T.textFaint : T.text,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      fontSize: 10,
                    }}
                  >
                    {valuesHidden ? "••••" : fmtPrice(tx.price, cur)}
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: valuesHidden ? T.textFaint : tx.fee ? T.text : T.textFaint,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      fontSize: 10,
                    }}
                  >
                    {valuesHidden ? "••••" : tx.fee ? fmtPrice(tx.fee, cur) : "—"}
                  </td>
                  <td
                    style={{
                      padding: "8px 10px",
                      color: tx.notes ? T.textDim : T.textFaint,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 10,
                    }}
                  >
                    {tx.notes || "—"}
                  </td>
                  <td style={{ padding: "6px 2px", textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      onClick={() => startEdit(tx)}
                      disabled={busy}
                      title="Edit inline"
                      style={{
                        background: "transparent",
                        border: `1px solid ${T.border}`,
                        color: T.textDim,
                        padding: "3px 4px",
                        marginRight: 2,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <Pencil size={9} />
                    </button>
                    <button
                      onClick={() => onDelete(tx)}
                      disabled={busy}
                      title="Delete"
                      style={{
                        background: "transparent",
                        border: `1px solid ${T.border}`,
                        color: T.red,
                        padding: "3px 4px",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <Trash2 size={9} />
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
        {(() => {
          if (visible.length === 0) return null;
          let netQty = 0;
          for (const tx of visible) {
            const q = Number(tx.qty) || 0;
            netQty += tx.side === "sell" ? -q : q;
          }
          const netColor = netQty < 0 ? T.red : T.green;
          const netStr = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(netQty);
          return (
            <tfoot>
              <tr style={{ borderTop: `1px solid ${T.border}` }}>
                <td />
                <td />
                <td />
                <td />
                <td
                  style={{
                    padding: "6px 4px",
                    fontFamily: FONT_MONO,
                    fontSize: 9,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: T.textFaint,
                  }}
                >
                  NET QTY
                </td>
                <td
                  style={{
                    padding: "6px 4px",
                    textAlign: "right",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: netColor,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  {netStr}
                </td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          );
        })()}
      </table>

      {openCol && (() => {
        const filterableCols = ["date", "side", "ticker", "assetClass"];
        const isFilterable = filterableCols.includes(openCol);
        const isDateCol = openCol === "date";
        const close = () => {
          setOpenCol(null);
          setAnchor(null);
        };
        return (
          <HeaderPopover
            anchor={anchor}
            onClose={close}
            sortDir={sortDirFor(openCol)}
            onSort={(dir) => setSortFor(openCol, dir)}
            filterable={isFilterable}
            options={isFilterable && !isDateCol ? allValues[openCol] || [] : []}
            selected={isFilterable && !isDateCol ? filters[openCol] : new Set()}
            onChange={(next) => setColFilter(openCol, next)}
            optionLabel={
              openCol === "side"
                ? (v) => (v === "buy" ? "B (Buy)" : v === "sell" ? "S (Sell)" : v)
                : undefined
            }
            dateMonths={isDateCol ? filters.dateMonths : undefined}
            setDateMonths={
              isDateCol
                ? (next) => setFilters((cur) => ({ ...cur, dateMonths: next }))
                : undefined
            }
            dateOptions={isDateCol ? dateOptions : undefined}
          />
        );
      })()}
    </div>
    </ScrollHintTable>
    </div>
  );
}


// CSV export
function transactionsToCSV(transactions) {
  const headers = ["date", "side", "ticker", "qty", "price", "assetClass", "fee", "notes"];
  const lines = [headers.join(",")];
  for (const t of transactions) {
    const row = headers.map((h) => {
      const v = t[h];
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    });
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

function downloadCSV(filename, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Split Modal -----------------------------------------------------------
// CUSIP pattern used to block non-stock tickers from splits.
const CUSIP_RX_SPLIT = /^[0-9]{3}[A-Z0-9]{6}[0-9]$/;

// Apply a split/grouping to a transaction list. Adjusts every transaction for
// the ticker dated strictly BEFORE the split date: qty x (num/den), price x
// (den/num), and records an audit trail (originalQty/originalPrice/splitDate).
// Transactions on or after the split date, or for other tickers, pass through.
export function applySplitToTransactions(transactions, { ticker, date, numerator, denominator }) {
  const num = Number(numerator), den = Number(denominator);
  const tkr = String(ticker).toUpperCase();
  return transactions.map((tx) => {
    if ((tx.ticker || "").toUpperCase() !== tkr || tx.date >= date) return tx;
    const origQty = tx.qty, origPrice = tx.price;
    return {
      ...tx,
      qty: parseFloat((origQty * (num / den)).toFixed(6)),
      price: parseFloat((origPrice * (den / num)).toFixed(6)),
      splitAdjusted: true,
      originalQty: origQty,
      originalPrice: origPrice,
      splitDate: date,
    };
  });
}

function SplitModal({ open, onClose, onApply, transactions, knownTickers, busy }) {
  const [form, setForm] = useState({ ticker: "", date: "", type: "split", numerator: "", denominator: "" });
  const [showTickerList, setShowTickerList] = useState(false);

  const todayStr = todayISO();

  function resetForm() {
    setForm({ ticker: "", date: "", type: "split", numerator: "", denominator: "" });
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  const tickerSuggestions = useMemo(() => {
    const q = (form.ticker || "").trim().toUpperCase();
    if (!q) return [];
    return (knownTickers || [])
      .filter((t) => t.toUpperCase().includes(q) && t.toUpperCase() !== q)
      .slice(0, 6);
  }, [form.ticker, knownTickers]);

  // Validation
  const num = parseFloat(form.numerator);
  const den = parseFloat(form.denominator);
  const ticker = (form.ticker || "").trim().toUpperCase();
  const date = (form.date || "").trim();

  const tickerErr = (() => {
    if (!ticker) return null;
    if (CUSIP_RX_SPLIT.test(ticker)) return "CUSIPs cannot be split-adjusted";
    if (/^tesouro-/i.test(ticker)) return "Tesouro tickers cannot be split-adjusted";
    return null;
  })();

  const dateErr = (() => {
    if (!date) return null;
    if (date > todayStr) return "Date cannot be in the future";
    return null;
  })();

  const factorErr = (() => {
    if (!form.numerator || !form.denominator) return null;
    if (!isFinite(num) || num <= 0) return "Numerator must be > 0";
    if (!isFinite(den) || den <= 0) return "Denominator must be > 0";
    if (num === den) return "Factor 1:1 has no effect";
    return null;
  })();

  const hasAllInputs = ticker && date && form.numerator && form.denominator;
  const isValid = hasAllInputs && !tickerErr && !dateErr && !factorErr;

  // Preview: affected transactions
  const affected = useMemo(() => {
    if (!isValid) return [];
    return transactions.filter(
      (tx) => (tx.ticker || "").toUpperCase() === ticker && tx.date < date
    );
  }, [transactions, ticker, date, isValid]);

  const hasNonIntegerQty = affected.some((tx) => {
    const newQty = tx.qty * (num / den);
    return Math.abs(newQty - Math.round(newQty)) > 0.0001;
  });

  function handleApply() {
    if (!isValid || affected.length === 0) return;
    const next = applySplitToTransactions(transactions, {
      ticker,
      date,
      numerator: num,
      denominator: den,
    });
    onApply(next);
    handleClose();
  }

  if (!open) return null;

  const inputStyle = {
    background: T.cardElev,
    border: `1px solid ${T.border}`,
    color: T.text,
    padding: "9px 11px",
    fontSize: 13,
    fontFamily: FONT_MONO,
    borderRadius: 2,
    width: "100%",
    boxSizing: "border-box",
    outline: "none",
  };
  const labelStyle = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.18em",
    color: T.textDim,
    textTransform: "uppercase",
    marginBottom: 6,
  };
  const errStyle = {
    fontFamily: FONT_MONO,
    fontSize: 11,
    color: T.red,
    marginTop: 4,
  };

  const tdH = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.10em",
    textTransform: "uppercase",
    fontWeight: 500,
    padding: "7px 10px",
    borderBottom: `1px solid ${T.border}`,
    color: T.textFaint,
    whiteSpace: "nowrap",
  };
  const tdB = {
    fontFamily: FONT_MONO,
    fontSize: 12,
    padding: "7px 10px",
    borderBottom: `1px solid ${T.borderSoft}`,
    color: T.text,
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        zIndex: 300,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "24px 16px",
        overflowY: "auto",
      }}
      onClick={handleClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.cardElev,
          border: `1px solid ${T.border}`,
          padding: 20,
          maxWidth: 500,
          width: "100%",
          borderRadius: 4,
        }}
      >
        {/* Modal header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.2em",
            color: T.gold,
            textTransform: "uppercase",
          }}>
            Split / Reverse Split
          </div>
          <button
            onClick={handleClose}
            style={{ background: "transparent", border: "none", color: T.textDim, cursor: "pointer", padding: 4 }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Inputs */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          {/* Ticker */}
          <div style={{ gridColumn: "1 / -1", position: "relative" }}>
            <div style={labelStyle}>Ticker</div>
            <input
              type="text"
              value={form.ticker}
              onChange={(e) => setForm((f) => ({ ...f, ticker: e.target.value.toUpperCase() }))}
              onFocus={() => setShowTickerList(true)}
              onBlur={() => setTimeout(() => setShowTickerList(false), 150)}
              placeholder="AAPL"
              style={{ ...inputStyle, textTransform: "uppercase" }}
            />
            {tickerErr && <div style={errStyle}>{tickerErr}</div>}
            {showTickerList && tickerSuggestions.length > 0 && (
              <div style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                background: T.cardElev,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                zIndex: 10,
                maxHeight: 160,
                overflowY: "auto",
              }}>
                {tickerSuggestions.map((t) => (
                  <button
                    key={t}
                    onMouseDown={() => setForm((f) => ({ ...f, ticker: t }))}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: T.gold,
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      padding: "9px 12px",
                      cursor: "pointer",
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Date */}
          <div>
            <div style={labelStyle}>Split Date</div>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              style={inputStyle}
            />
            {dateErr && <div style={errStyle}>{dateErr}</div>}
          </div>

          {/* Type */}
          <div>
            <div style={labelStyle}>Type</div>
            <div style={{ display: "flex", gap: 6 }}>
              {["split", "reverse"].map((t) => {
                const active = form.type === t;
                return (
                  <button
                    key={t}
                    onClick={() => setForm((f) => ({ ...f, type: t }))}
                    style={{
                      flex: 1,
                      background: active ? "rgba(201,169,97,0.12)" : "transparent",
                      border: `1px solid ${active ? T.gold : T.border}`,
                      color: active ? T.gold : T.textDim,
                      padding: "9px 6px",
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      letterSpacing: "0.10em",
                      textTransform: "uppercase",
                      cursor: "pointer",
                    }}
                  >
                    {t === "split" ? "Split" : "Reverse"}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Factor */}
          <div style={{ gridColumn: "1 / -1" }}>
            <div style={labelStyle}>Factor — New : Old</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                value={form.numerator}
                onChange={(e) => setForm((f) => ({ ...f, numerator: e.target.value }))}
                placeholder="10"
                min="0.000001"
                step="any"
                style={{ ...inputStyle, width: "100%" }}
              />
              <span style={{ fontFamily: FONT_MONO, fontSize: 16, color: T.textDim, flexShrink: 0 }}>:</span>
              <input
                type="number"
                value={form.denominator}
                onChange={(e) => setForm((f) => ({ ...f, denominator: e.target.value }))}
                placeholder="1"
                min="0.000001"
                step="any"
                style={{ ...inputStyle, width: "100%" }}
              />
            </div>
            {factorErr && <div style={errStyle}>{factorErr}</div>}
            {isFinite(num) && isFinite(den) && den > 0 && !factorErr && (
              <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, marginTop: 4 }}>
                Each share becomes {(num / den).toFixed(4).replace(/\.?0+$/, "")} shares. Price divided by same factor.
              </div>
            )}
          </div>
        </div>

        {/* Preview */}
        {isValid && (
          <div style={{
            background: T.card,
            border: `1px solid ${T.borderSoft}`,
            borderRadius: 4,
            marginBottom: 16,
            overflow: "hidden",
          }}>
            <div style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: T.textDim,
              padding: "10px 12px",
              borderBottom: `1px solid ${T.borderSoft}`,
            }}>
              Preview
            </div>

            {affected.length === 0 ? (
              <div style={{ padding: "12px", fontFamily: FONT_MONO, fontSize: 12, color: T.textDim }}>
                No transactions found for {ticker} before {date}.
              </div>
            ) : (
              <>
                {hasNonIntegerQty && (
                  <div style={{
                    padding: "8px 12px",
                    background: "rgba(232,140,140,0.08)",
                    borderBottom: `1px solid ${T.borderSoft}`,
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.red,
                  }}>
                    Warning: some resulting quantities are fractional (e.g. 0.5 shares in reverse split).
                  </div>
                )}
                <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                  <table style={{ width: "100%", minWidth: 460, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ ...tdH, textAlign: "left" }}>Date</th>
                        <th style={{ ...tdH, textAlign: "left" }}>Side</th>
                        <th style={{ ...tdH, textAlign: "right" }}>Qty</th>
                        <th style={{ ...tdH, textAlign: "center", color: T.textFaint, fontSize: 12, padding: "7px 4px" }}>{"->"}</th>
                        <th style={{ ...tdH, textAlign: "right" }}>New Qty</th>
                        <th style={{ ...tdH, textAlign: "right" }}>Price</th>
                        <th style={{ ...tdH, textAlign: "center", color: T.textFaint, fontSize: 12, padding: "7px 4px" }}>{"->"}</th>
                        <th style={{ ...tdH, textAlign: "right" }}>New Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {affected.map((tx) => {
                        const newQty = parseFloat((tx.qty * (num / den)).toFixed(6));
                        const newPrice = parseFloat((tx.price * (den / num)).toFixed(6));
                        const isNonInt = Math.abs(newQty - Math.round(newQty)) > 0.0001;
                        return (
                          <tr key={tx.id}>
                            <td style={{ ...tdB, textAlign: "left" }}>{tx.date}</td>
                            <td style={{ ...tdB, textAlign: "left", color: tx.side === "buy" ? T.green : T.red }}>{tx.side[0].toUpperCase()}</td>
                            <td style={{ ...tdB, textAlign: "right" }}>{tx.qty}</td>
                            <td style={{ ...tdB, textAlign: "center", color: T.textFaint }}>{">"}</td>
                            <td style={{ ...tdB, textAlign: "right", color: isNonInt ? T.red : T.gold }}>{newQty}</td>
                            <td style={{ ...tdB, textAlign: "right" }}>{"$"}{tx.price}</td>
                            <td style={{ ...tdB, textAlign: "center", color: T.textFaint }}>{">"}</td>
                            <td style={{ ...tdB, textAlign: "right", color: T.gold }}>{"$"}{newPrice}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: "8px 12px", fontFamily: FONT_MONO, fontSize: 11, color: T.textDim, borderTop: `1px solid ${T.borderSoft}` }}>
                  {affected.length} transaction{affected.length === 1 ? "" : "s"} will be adjusted
                </div>
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={handleApply}
            disabled={!isValid || affected.length === 0 || busy}
            style={{
              background: isValid && affected.length > 0 && !busy ? T.red : T.borderSoft,
              border: "none",
              color: isValid && affected.length > 0 && !busy ? "#0b0d10" : T.textFaint,
              padding: "10px 16px",
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              cursor: isValid && affected.length > 0 && !busy ? "pointer" : "not-allowed",
              opacity: isValid && affected.length > 0 && !busy ? 1 : 0.5,
            }}
          >
            Apply Split
          </button>
          <button
            onClick={handleClose}
            style={{
              background: "transparent",
              border: `1px solid ${T.border}`,
              color: T.textDim,
              padding: "10px 16px",
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Import Modal ----------------------------------------------------------

const SAMPLE_CSV = `date,side,ticker,qty,price,assetClass,fee,notes
2024-03-15,buy,AAPL,10,175.50,Stocks,0,
2024-03-20,buy,BBSE3,100,38.20,BRA Stocks,,monthly buy`;

function ImportModal({ open, onClose, onConfirm, existingCount, existingTransactions = [] }) {
  const [tab, setTab] = useState("fidelity"); // upload | fidelity
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null); // { results, hadHeader, dateFormat }
  const [decimalPrompt, setDecimalPrompt] = useState(false); // ambiguous comma found
  const [structuralPrompt, setStructuralPrompt] = useState(false); // BR-decimal-in-CSV suspected
  const [mode, setMode] = useState("append"); // append | replace
  const [fileError, setFileError] = useState("");
  const [checkedRows, setCheckedRows] = useState(new Set());
  const [dupFilter, setDupFilter] = useState("all"); // "all" | "non-dup" | "dup"
  const [editingIdx, setEditingIdx] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const fileInputRef = useRef(null);

  // Ticker → asset class from saved transactions (last occurrence wins). Used to
  // reuse a known class instead of inferring one for the same ticker.
  const knownClassByTicker = useMemo(() => {
    const m = new Map();
    for (const t of existingTransactions || []) {
      const tk = String(t.ticker || "").trim().toUpperCase();
      if (tk && t.assetClass) m.set(tk, t.assetClass);
    }
    return m;
  }, [existingTransactions]);

  // Bond description (issuer|coupon|maturity) → known CUSIP, from saved Bank
  // Bonds transactions. Recovers the real CUSIP for Fidelity rows that omit
  // Symbol for CD/bond rows (jul/2026 export change) — see extractBondMeta.
  // Consolidated (jul/2026) into ../lib/bond-meta.js so this and the
  // SimpleFin interest auto-resolution path share one implementation.
  const knownBondsByDescKey = useMemo(
    () => buildKnownBondsByDescKey(existingTransactions),
    [existingTransactions]
  );

  // Set of dup keys for saved transactions, to flag re-imports of the same row.
  const dupKeySet = useMemo(() => {
    const s = new Set();
    for (const t of existingTransactions || []) s.add(dupKey(t));
    return s;
  }, [existingTransactions]);

  // Flag rows that match an already-saved transaction (same ticker/side/qty/date).
  function annotateDuplicates(results) {
    if (dupKeySet.size === 0) return results;
    return results.map((r) =>
      r.tx && dupKeySet.has(dupKey(r.tx)) ? { ...r, duplicate: true } : r
    );
  }

  // Default check state: all rows except detected duplicates.
  function initAllChecked(results) {
    const s = new Set();
    results.forEach((r, i) => {
      if (!r.duplicate) s.add(i);
    });
    setCheckedRows(s);
  }

  useEffect(() => {
    if (!open) {
      setText("");
      setParsed(null);
      setDecimalPrompt(false);
      setStructuralPrompt(false);
      setMode("append");
      setFileError("");
      setTab("fidelity");
      setCheckedRows(new Set());
      setDupFilter("all");
      setEditingIdx(null);
      setEditDraft(null);
    }
  }, [open]);

  function doParse(rawText) {
    const out = parseCSVOrPaste(rawText);
    if (out.rows.length === 0) {
      setFileError("No rows detected");
      setParsed(null);
      return;
    }
    const fmt = detectDateFormat(out.rows.map((r) => r.date));
    const opts = { dateFormat: fmt };
    // If columns mismatch AND delimiter is comma, suspected BR decimal in CSV.
    if (out.structuralBreak && out.delimiter === ",") {
      const results = annotateDuplicates(out.rows.map((r) => parseRow(r, "USD", knownClassByTicker, opts)));
      setParsed({ results, hadHeader: out.hadHeader, rawRows: out.rows, sourceText: rawText, dateFormat: fmt });
      initAllChecked(results);
      setDupFilter("all");
      setEditingIdx(null);
      setEditDraft(null);
      setStructuralPrompt(true);
      setDecimalPrompt(false);
      setFileError("");
      return;
    }
    const results = annotateDuplicates(out.rows.map((r) => parseRow(r, "USD", knownClassByTicker, opts)));
    const ambiguousCount = results.filter((r) => r.ambiguous).length;
    setParsed({ results, hadHeader: out.hadHeader, rawRows: out.rows, sourceText: rawText, dateFormat: fmt });
    initAllChecked(results);
    setDupFilter("all");
    setEditingIdx(null);
    setEditDraft(null);
    setDecimalPrompt(ambiguousCount > 0);
    setStructuralPrompt(false);
    setFileError("");
  }

  function applyBRReparse(yes) {
    if (!parsed) return;
    setStructuralPrompt(false);
    if (!yes) return;
    const out = parseCSVOrPaste(parsed.sourceText, { autoFixBR: true });
    if (out.rows.length === 0) {
      setFileError("Reparse produced no rows");
      setParsed(null);
      return;
    }
    const fmt = parsed.dateFormat || "dmy";
    const opts = { dateFormat: fmt };
    const results = annotateDuplicates(out.rows.map((r) => parseRow(r, "USD", knownClassByTicker, opts)));
    const ambiguousCount = results.filter((r) => r.ambiguous).length;
    setParsed({
      results,
      hadHeader: out.hadHeader,
      rawRows: out.rows,
      sourceText: parsed.sourceText,
      dateFormat: fmt,
      reparseNote:
        out.unfixableRows > 0
          ? `${out.fixedRows} row(s) fixed, ${out.unfixableRows} could not be auto-fixed.`
          : null,
    });
    initAllChecked(results);
    setDupFilter("all");
    setEditingIdx(null);
    setEditDraft(null);
    setDecimalPrompt(ambiguousCount > 0);
  }

  function applyCommaDecimal(useComma) {
    if (!parsed) return;
    if (useComma) {
      const opts = { dateFormat: parsed.dateFormat || "dmy" };
      const next = annotateDuplicates(
        reparseWithCommaDecimal(parsed.rawRows, "USD", knownClassByTicker, opts)
      );
      setParsed({ ...parsed, results: next });
    }
    setDecimalPrompt(false);
  }

  function pickAssetClass(idx, cls) {
    if (!parsed) return;
    const cur = currencyForAssetClass(cls);
    const next = parsed.results.map((r, i) => {
      if (i !== idx) return r;
      if (!r.tx) return r;
      return {
        ...r,
        ok: true,
        needsAssetClass: false,
        errors: [],
        tx: { ...r.tx, assetClass: cls, currency: cur },
      };
    });
    setParsed({ ...parsed, results: next });
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = String(ev.target?.result || "");
      setText(content);
      doParse(content);
    };
    reader.onerror = () => setFileError("Failed to read file");
    reader.readAsText(file);
  }

  function handleFidelityFile(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const fileContents = [];
    let loaded = 0;
    let readError = false;

    function onAllLoaded() {
      let mergedResults = [];
      let mergedIncome = [];
      let mergedDistributions = [];
      let mergedRawRows = [];
      const crossFileKeys = new Set();

      for (const content of fileContents) {
        const out = parseFidelityCSV(content, knownClassByTicker, knownBondsByDescKey);
        if (out.error && mergedResults.length === 0 && mergedIncome.length === 0) {
          setFileError(out.error);
          setParsed(null);
          return;
        }
        const fileResults = out.results || [];
        const deduped = fileResults.map((r) => {
          if (!r.tx) return r;
          const k = dupKey(r.tx);
          if (crossFileKeys.has(k)) return { ...r, duplicate: true };
          crossFileKeys.add(k);
          return r;
        });
        mergedResults = mergedResults.concat(deduped);
        mergedIncome = mergedIncome.concat(out.incomeEvents || []);
        mergedDistributions = mergedDistributions.concat(out.distributionEvents || []);
        mergedRawRows = mergedRawRows.concat(out.rawRows || []);
      }

      if (mergedResults.length === 0 && mergedIncome.length === 0) {
        setFileError("No BUY/SELL or interest rows found in this Fidelity file");
        setParsed(null);
        return;
      }

      mergedResults.sort((a, b) => {
        const da = a.tx?.date || "";
        const db = b.tx?.date || "";
        return da < db ? -1 : da > db ? 1 : 0;
      });

      const annotated = annotateDuplicates(mergedResults);
      setParsed({
        results: annotated,
        incomeEvents: mergedIncome,
        distributionEvents: mergedDistributions,
        hadHeader: true,
        rawRows: mergedRawRows,
        sourceText: "",
        sourceLabel: "Fidelity",
      });
      initAllChecked(annotated);
      setDupFilter("all");
      setEditingIdx(null);
      setEditDraft(null);
      setDecimalPrompt(false);
      setStructuralPrompt(false);
      setFileError("");
    }

    files.forEach((file, idx) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (readError) return;
        let content = String(ev.target?.result || "");
        if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
        fileContents[idx] = content;
        loaded += 1;
        if (loaded === files.length) onAllLoaded();
      };
      reader.onerror = () => {
        if (!readError) {
          readError = true;
          setFileError("Failed to read file");
        }
      };
      reader.readAsText(file);
    });
  }

  function handleConfirm() {
    if (!parsed) return;
    const validTx = parsed.results
      .filter((r, i) => r.ok && checkedRows.has(i))
      .map((r) => r.tx);
    const income = parsed.incomeEvents || [];
    const distributions = parsed.distributionEvents || [];
    if (validTx.length === 0 && income.length === 0 && distributions.length === 0) return;
    onConfirm(validTx, mode, income, distributions);
  }

  function startPreviewEdit(idx) {
    const r = parsed?.results[idx];
    setEditingIdx(idx);
    setEditDraft({
      date: r?.tx?.date || todayISO(),
      side: r?.tx?.side || "buy",
      ticker: r?.tx?.ticker || "",
      assetClass: r?.tx?.assetClass || "",
      qty: r?.tx ? String(r.tx.qty) : "",
      price: r?.tx ? String(r.tx.price) : "",
      fee: r?.tx?.fee ? String(r.tx.fee) : "",
      notes: r?.tx?.notes || "",
    });
  }

  function cancelPreviewEdit() {
    setEditingIdx(null);
    setEditDraft(null);
  }

  function commitPreviewEdit() {
    if (editDraft === null || editingIdx === null || !parsed) return;
    const qn = parseFloat(editDraft.qty);
    const pn = parseFloat(editDraft.price);
    const feeN = editDraft.fee ? parseFloat(editDraft.fee) : 0;
    if (!editDraft.date) return;
    if (!isFinite(qn) || qn <= 0) return;
    if (!isFinite(pn) || pn < 0) return;
    if (editDraft.fee && (!isFinite(feeN) || feeN < 0)) return;
    if (!editDraft.assetClass) return;
    const tkr = editDraft.ticker.trim().toUpperCase();
    if (!tkr) return;
    const existing = parsed.results[editingIdx];
    const cur = currencyForAssetClass(editDraft.assetClass) || "USD";
    const editedTx = {
      id: existing?.tx?.id || newId(),
      date: editDraft.date,
      side: editDraft.side,
      ticker: tkr,
      assetClass: editDraft.assetClass,
      qty: qn,
      price: pn,
      currency: cur,
      fee: feeN,
      notes: editDraft.notes.trim(),
      // Preserve bond metadata (coupon/maturity/issuer/redemption) already
      // extracted by the Fidelity parser — editing only the ticker (e.g. to
      // fill in a CUSIP Fidelity omitted) must not lose it.
      ...(editDraft.assetClass === "Bank Bonds" && existing?.tx && {
        couponRate: existing.tx.couponRate ?? null,
        maturityDate: existing.tx.maturityDate ?? null,
        bondType: existing.tx.bondType ?? null,
        shortName: existing.tx.shortName ?? null,
        couponFreq: existing.tx.couponFreq ?? null,
      }),
      ...(existing?.tx?.redemption && { redemption: true }),
      createdAt: existing?.tx?.createdAt || new Date().toISOString(),
    };
    const updatedResult = {
      ok: true,
      needsAssetClass: false,
      needsTicker: false,
      errors: [],
      ambiguous: false,
      duplicate: dupKeySet.has(dupKey(editedTx)),
      rawNumbers: existing?.rawNumbers,
      tx: editedTx,
    };
    const newResults = parsed.results.map((r, i) => (i === editingIdx ? updatedResult : r));
    setParsed({ ...parsed, results: newResults });
    setEditingIdx(null);
    setEditDraft(null);
  }

  if (!open) return null;

  const validCount = parsed ? parsed.results.filter((r) => r.ok).length : 0;
  const checkedValidCount = parsed
    ? parsed.results.filter((r, i) => r.ok && checkedRows.has(i)).length
    : 0;
  const incomeCount = parsed?.incomeEvents?.length || 0;
  const totalCount = parsed ? parsed.results.length : 0;
  const errorCount = parsed
    ? parsed.results.filter((r) => !r.ok && !r.needsAssetClass && !r.needsTicker).length
    : 0;
  const needsAssetClassCount = parsed
    ? parsed.results.filter((r) => r.needsAssetClass).length
    : 0;
  const needsTickerCount = parsed
    ? parsed.results.filter((r) => r.needsTicker).length
    : 0;
  const duplicateCount = parsed
    ? parsed.results.filter((r) => r.duplicate).length
    : 0;
  const reusedClassCount = parsed
    ? parsed.results.filter((r) => r.classFromHistory).length
    : 0;
  const allChecked = parsed ? parsed.results.every((_, i) => checkedRows.has(i)) : false;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        zIndex: 100,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 20,
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.cardElev,
          border: `1px solid ${T.border}`,
          maxWidth: 720,
          width: "100%",
          marginTop: 20,
          marginBottom: 40,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.2em",
              color: T.gold,
              textTransform: "uppercase",
            }}
          >
            Import Transactions
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: T.textDim,
              cursor: "pointer",
              padding: 4,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Structural break prompt (BR decimal in comma-CSV) */}
        {structuralPrompt && (
          <div
            style={{
              padding: 16,
              background: "rgba(232, 140, 140, 0.08)",
              borderBottom: `1px solid ${T.border}`,
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                color: T.red,
                marginBottom: 8,
                lineHeight: 1.5,
              }}
            >
              Column mismatch detected. Likely cause: commas used as decimal
              separator in a comma-delimited file (e.g. "175,50"). Replace
              inline commas with dots and reparse?
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => applyBRReparse(true)}
                style={{
                  background: T.gold,
                  border: "none",
                  color: "#0b0d10",
                  padding: "8px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Yes, reparse
              </button>
              <button
                onClick={() => applyBRReparse(false)}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.border}`,
                  color: T.textDim,
                  padding: "8px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                No, keep
              </button>
            </div>
          </div>
        )}

        {/* Decimal handling prompt */}
        {decimalPrompt && (
          <div
            style={{
              padding: 16,
              background: "rgba(201, 169, 97, 0.08)",
              borderBottom: `1px solid ${T.border}`,
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                color: T.gold,
                marginBottom: 8,
                lineHeight: 1.5,
              }}
            >
              Detected commas in numeric fields. Convert ',' to '.' as decimal
              separator?
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => applyCommaDecimal(true)}
                style={{
                  background: T.gold,
                  border: "none",
                  color: "#0b0d10",
                  padding: "8px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Yes, convert
              </button>
              <button
                onClick={() => applyCommaDecimal(false)}
                style={{
                  background: "transparent",
                  border: `1px solid ${T.border}`,
                  color: T.textDim,
                  padding: "8px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                No, keep
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        <div style={{ padding: 20 }}>
          {!parsed && (
            <>
              {/* Tabs */}
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  borderBottom: `1px solid ${T.border}`,
                  marginBottom: 16,
                }}
              >
                {[
                  { id: "upload", label: "Upload CSV" },
                  { id: "fidelity", label: "Fidelity" },
                ].map((t) => {
                  const active = tab === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: "8px 0",
                        cursor: "pointer",
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        letterSpacing: "0.18em",
                        textTransform: "uppercase",
                        color: active ? T.gold : T.textDim,
                        borderBottom: active
                          ? `1px solid ${T.gold}`
                          : "1px solid transparent",
                        marginBottom: -1,
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>

              {tab === "upload" && (
                <div>
                  <Label>Select a CSV file</Label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    onChange={handleFile}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: 12,
                      background: T.card,
                      border: `1px dashed ${T.border}`,
                      color: T.text,
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                    }}
                  />
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      color: T.textFaint,
                      marginTop: 10,
                      lineHeight: 1.7,
                    }}
                  >
                    <div style={{ color: T.textDim, marginBottom: 4 }}>
                      Required columns:
                    </div>
                    <div style={{ color: T.text }}>
                      date, side, ticker, qty, price
                    </div>
                    <div style={{ color: T.textDim, marginTop: 8, marginBottom: 4 }}>
                      Optional columns:
                    </div>
                    <div style={{ color: T.text }}>
                      assetClass, fee, notes
                    </div>
                    <div style={{ color: T.textFaint, marginTop: 10 }}>
                      Header row recommended. PT aliases accepted (data, tipo,
                      ativo, qtd, preco, classe, taxa, obs). Sides accepted:
                      buy/sell or compra/venda.
                    </div>
                  </div>
                  {fileError && (
                    <div
                      style={{
                        marginTop: 12,
                        color: T.red,
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                      }}
                    >
                      {fileError}
                    </div>
                  )}
                </div>
              )}

              {tab === "fidelity" && (
                <div>
                  <Label>Select one or more Fidelity "Accounts History" CSVs</Label>
                  <input
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    multiple
                    onChange={handleFidelityFile}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: 12,
                      background: T.card,
                      border: `1px dashed ${T.border}`,
                      color: T.text,
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                    }}
                  />
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      color: T.textFaint,
                      marginTop: 8,
                      lineHeight: 1.6,
                    }}
                  >
                    Imports YOU BOUGHT / YOU SOLD rows as transactions, bond
                    INTEREST payments as income, and bond REDEMPTIONS
                    (maturity) as sells. Dividends and contributions are
                    skipped. CUSIP symbols are classified as Bank Bonds with
                    coupon and maturity extracted from the description. All
                    other transactions default to "Stocks".
                  </div>
                  {fileError && (
                    <div
                      style={{
                        marginTop: 12,
                        color: T.red,
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                      }}
                    >
                      {fileError}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {parsed && (
            <>
              {/* Summary */}
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  marginBottom: 14,
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.green,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                >
                  {validCount} valid
                </div>
                {errorCount > 0 && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.red,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    {errorCount} with errors
                  </div>
                )}
                {needsAssetClassCount > 0 && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.gold,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    {needsAssetClassCount} need class
                  </div>
                )}
                {needsTickerCount > 0 && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.gold,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                    title="Fidelity didn't report a CUSIP for these bond purchases — double-click a row to enter it manually."
                  >
                    {needsTickerCount} need CUSIP
                  </div>
                )}
                {duplicateCount > 0 && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.red,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    {duplicateCount} duplicate
                  </div>
                )}
                {reusedClassCount > 0 && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.textDim,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    {reusedClassCount} class reused
                  </div>
                )}
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.textDim,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                >
                  {parsed.hadHeader ? "header detected" : "no header"}
                </div>
                {parsed.dateFormat === "dmy" && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.gold,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    dates: DD/MM/YYYY detected
                  </div>
                )}
              </div>

              {parsed.reparseNote && (
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.gold,
                    marginBottom: 14,
                    padding: 10,
                    border: `1px solid ${T.gold}`,
                    background: "rgba(201, 169, 97, 0.05)",
                  }}
                >
                  {parsed.reparseNote}
                </div>
              )}

              {parsed.incomeEvents && parsed.incomeEvents.length > 0 && (() => {
                const bondCount = parsed.incomeEvents.filter(e => e.kind === "interest").length;
                const divCount  = parsed.incomeEvents.filter(e => e.kind === "dividend").length;
                const taxCount  = parsed.incomeEvents.filter(e => e.kind === "tax").length;
                const parts = [];
                if (bondCount > 0) parts.push(`${bondCount} bond interest payment${bondCount === 1 ? "" : "s"}`);
                if (divCount  > 0) parts.push(`${divCount} stock dividend payment${divCount  === 1 ? "" : "s"}`);
                if (taxCount  > 0) parts.push(`${taxCount} foreign tax payment${taxCount === 1 ? "" : "s"}`);
                return (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: T.green,
                      marginBottom: 14,
                      padding: 10,
                      border: `1px solid ${T.green}`,
                      background: "rgba(125, 211, 164, 0.05)",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {parts.join(" + ")} detected — added to income on import.
                  </div>
                );
              })()}

              {duplicateCount > 0 && (
                <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
                  {[
                    { id: "all", label: "All", count: totalCount },
                    { id: "non-dup", label: "Non-dup", count: totalCount - duplicateCount },
                    { id: "dup", label: "Dup", count: duplicateCount },
                  ].map((f) => {
                    const active = dupFilter === f.id;
                    return (
                      <button
                        key={f.id}
                        onClick={() => setDupFilter(f.id)}
                        style={{
                          background: active ? T.gold : "transparent",
                          border: `1px solid ${active ? T.gold : T.border}`,
                          color: active ? "#0b0d10" : T.textDim,
                          padding: "4px 10px",
                          cursor: "pointer",
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          letterSpacing: "0.12em",
                          textTransform: "uppercase",
                          borderRadius: 4,
                        }}
                      >
                        {f.label} ({f.count})
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Preview table */}
              <div
                style={{
                  maxHeight: 320,
                  overflowY: "auto",
                  border: `1px solid ${T.border}`,
                  marginBottom: 14,
                }}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                  }}
                >
                  <thead>
                    <tr style={{ background: T.card }}>
                      <th
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${T.border}`,
                          position: "sticky",
                          top: 0,
                          background: T.card,
                          textAlign: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={() => {
                            if (allChecked) {
                              setCheckedRows(new Set());
                            } else {
                              setCheckedRows(new Set(parsed.results.map((_, i) => i)));
                            }
                          }}
                          style={{ accentColor: T.gold, cursor: "pointer" }}
                        />
                      </th>
                      {["#", "date", "side", "ticker", "qty", "price", "class", ""].map((h) => (
                        <th
                          key={h}
                          style={{
                            textAlign: "left",
                            padding: "8px 10px",
                            color: T.textDim,
                            fontWeight: 400,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            fontSize: 10,
                            borderBottom: `1px solid ${T.border}`,
                            position: "sticky",
                            top: 0,
                            background: T.card,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.results.map((r, idx) => {
                      if (dupFilter === "non-dup" && r.duplicate) return null;
                      if (dupFilter === "dup" && !r.duplicate) return null;
                      const isChecked = checkedRows.has(idx);
                      const isEditingThis = editingIdx === idx;

                      if (isEditingThis && editDraft) {
                        const cellS = { padding: "4px 3px", verticalAlign: "middle" };
                        const inS = {
                          width: "100%",
                          boxSizing: "border-box",
                          background: T.cardElev,
                          border: `1px solid ${T.gold}`,
                          color: T.text,
                          padding: "3px 4px",
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          outline: "none",
                        };
                        const onKey = (e) => {
                          if (e.key === "Enter") commitPreviewEdit();
                          else if (e.key === "Escape") cancelPreviewEdit();
                        };
                        return (
                          <tr
                            key={idx}
                            style={{
                              borderBottom: `1px solid ${T.gold}`,
                              background: "rgba(201, 169, 97, 0.04)",
                            }}
                          >
                            <td style={{ ...cellS, textAlign: "center" }}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() =>
                                  setCheckedRows((cur) => {
                                    const next = new Set(cur);
                                    if (next.has(idx)) next.delete(idx);
                                    else next.add(idx);
                                    return next;
                                  })
                                }
                                onClick={(e) => e.stopPropagation()}
                                style={{ accentColor: T.gold, cursor: "pointer" }}
                              />
                            </td>
                            <td style={{ ...cellS, color: T.textFaint, fontSize: 10 }}>{idx + 1}</td>
                            <td style={cellS}>
                              <input
                                type="date"
                                value={editDraft.date}
                                onChange={(e) => setEditDraft({ ...editDraft, date: e.target.value })}
                                onKeyDown={onKey}
                                style={inS}
                              />
                            </td>
                            <td style={cellS}>
                              <select
                                value={editDraft.side}
                                onChange={(e) => setEditDraft({ ...editDraft, side: e.target.value })}
                                onKeyDown={onKey}
                                style={{ ...inS, cursor: "pointer" }}
                              >
                                <option value="buy">buy</option>
                                <option value="sell">sell</option>
                              </select>
                            </td>
                            <td style={cellS}>
                              <input
                                type="text"
                                value={editDraft.ticker}
                                onChange={(e) => setEditDraft({ ...editDraft, ticker: e.target.value.toUpperCase() })}
                                onKeyDown={onKey}
                                style={{ ...inS, textTransform: "uppercase" }}
                              />
                            </td>
                            <td style={cellS}>
                              <input
                                type="number"
                                step="any"
                                inputMode="decimal"
                                value={editDraft.qty}
                                onChange={(e) => setEditDraft({ ...editDraft, qty: e.target.value })}
                                onKeyDown={onKey}
                                style={{ ...inS, textAlign: "right" }}
                              />
                            </td>
                            <td style={cellS}>
                              <input
                                type="number"
                                step="any"
                                inputMode="decimal"
                                value={editDraft.price}
                                onChange={(e) => setEditDraft({ ...editDraft, price: e.target.value })}
                                onKeyDown={onKey}
                                style={{ ...inS, textAlign: "right" }}
                              />
                            </td>
                            <td style={cellS}>
                              <select
                                value={editDraft.assetClass}
                                onChange={(e) => setEditDraft({ ...editDraft, assetClass: e.target.value })}
                                onKeyDown={onKey}
                                style={{ ...inS, cursor: "pointer" }}
                              >
                                <option value="">— pick —</option>
                                {ASSET_CLASS_IDS.map((id) => (
                                  <option key={id} value={id}>{id}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: "4px 3px", textAlign: "right", whiteSpace: "nowrap" }}>
                              <button
                                onClick={commitPreviewEdit}
                                title="Save (Enter)"
                                style={{
                                  background: "transparent",
                                  border: `1px solid ${T.green}`,
                                  color: T.green,
                                  padding: "2px 4px",
                                  marginRight: 2,
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                }}
                              >
                                <Check size={10} />
                              </button>
                              <button
                                onClick={cancelPreviewEdit}
                                title="Cancel (Esc)"
                                style={{
                                  background: "transparent",
                                  border: `1px solid ${T.border}`,
                                  color: T.textDim,
                                  padding: "2px 4px",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                }}
                              >
                                <X size={10} />
                              </button>
                            </td>
                          </tr>
                        );
                      }

                      return (
                        <tr
                          key={idx}
                          onDoubleClick={() => startPreviewEdit(idx)}
                          style={{
                            background: isEditingThis
                              ? "rgba(201, 169, 97, 0.04)"
                              : r.duplicate
                              ? "rgba(232, 140, 140, 0.09)"
                              : r.ok
                              ? "transparent"
                              : "rgba(232, 140, 140, 0.05)",
                            borderBottom: `1px solid ${T.borderSoft}`,
                            cursor: "default",
                          }}
                        >
                          <td style={{ padding: "6px 8px", textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() =>
                                setCheckedRows((cur) => {
                                  const next = new Set(cur);
                                  if (next.has(idx)) next.delete(idx);
                                  else next.add(idx);
                                  return next;
                                })
                              }
                              onClick={(e) => e.stopPropagation()}
                              style={{ accentColor: T.gold, cursor: "pointer" }}
                            />
                          </td>
                          <td style={{ padding: "6px 10px", color: T.textFaint }}>
                            {idx + 1}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.text }}>
                            {r.tx ? r.tx.date : "—"}
                          </td>
                          <td
                            style={{
                              padding: "6px 10px",
                              color: r.tx
                                ? r.tx.side === "buy"
                                  ? T.green
                                  : T.red
                                : T.textDim,
                            }}
                          >
                            {r.tx ? r.tx.side : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", color: r.needsTicker ? T.gold : T.text }}>
                            {r.needsTicker ? "? CUSIP" : r.tx ? r.tx.ticker : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.text }}>
                            {r.tx ? fmtNum(r.tx.qty) : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.text }}>
                            {r.tx ? fmtNum(r.tx.price, 2) : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.textDim }}>
                            {r.needsAssetClass ? (
                              <select
                                value=""
                                onChange={(e) =>
                                  e.target.value && pickAssetClass(idx, e.target.value)
                                }
                                style={{
                                  background: T.cardElev,
                                  border: `1px solid ${T.gold}`,
                                  color: T.gold,
                                  padding: "2px 4px",
                                  fontFamily: FONT_MONO,
                                  fontSize: 10,
                                  cursor: "pointer",
                                  maxWidth: 130,
                                }}
                              >
                                <option value="">— pick —</option>
                                {ASSET_CLASS_IDS.map((id) => (
                                  <option key={id} value={id}>
                                    {id}
                                  </option>
                                ))}
                              </select>
                            ) : r.tx ? (
                              r.tx.assetClass || "—"
                            ) : (
                              "—"
                            )}
                          </td>
                          <td style={{ padding: "6px 10px", color: T.red, fontSize: 10 }}>
                            {!r.ok && !r.needsAssetClass && !r.needsTicker && r.errors.join("; ")}
                            {r.needsAssetClass && (
                              <span style={{ color: T.gold }}>pick class</span>
                            )}
                            {r.needsTicker && (
                              <span
                                style={{ color: T.gold }}
                                title="Fidelity omitted the CUSIP for this bond purchase. Double-click the row and paste the CUSIP into the ticker field."
                              >
                                missing CUSIP — {r.tx.shortName || "unknown issuer"}
                                {r.tx.notes ? ` ${r.tx.notes}` : ""} — double-click to enter
                              </span>
                            )}
                            {r.duplicate && (
                              <span
                                style={{ color: T.red, fontWeight: 600 }}
                                title="A saved transaction already has this ticker, side, qty and date. Check the box to import anyway."
                              >
                                Duplicate
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mode toggle — only meaningful when there's existing data */}
              {existingCount > 0 && (
                <>
                  <Label>How to apply</Label>
                  <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                    {[
                      { id: "append", label: `Append (keep ${existingCount} existing)` },
                      { id: "replace", label: `Replace all ${existingCount}` },
                    ].map((m) => {
                      const active = mode === m.id;
                      return (
                        <button
                          key={m.id}
                          onClick={() => setMode(m.id)}
                          style={{
                            flex: 1,
                            background: active
                              ? m.id === "replace"
                                ? "rgba(232, 140, 140, 0.12)"
                                : "rgba(125, 211, 164, 0.12)"
                              : "transparent",
                            border: `1px solid ${
                              active ? (m.id === "replace" ? T.red : T.green) : T.border
                            }`,
                            color: active
                              ? m.id === "replace"
                                ? T.red
                                : T.green
                              : T.textDim,
                            padding: "10px 12px",
                            fontFamily: FONT_MONO,
                            fontSize: 10,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            cursor: "pointer",
                          }}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {mode === "replace" && existingCount > 0 && (
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: T.red,
                    marginBottom: 14,
                    padding: 10,
                    border: `1px solid ${T.red}`,
                    background: "rgba(232, 140, 140, 0.05)",
                  }}
                >
                  Warning: replacing will delete all {existingCount} existing
                  transactions.
                </div>
              )}

              {/* Actions */}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleConfirm}
                  disabled={checkedValidCount === 0 && incomeCount === 0}
                  style={{
                    background: T.gold,
                    border: "none",
                    color: "#0b0d10",
                    padding: "10px 16px",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    cursor: checkedValidCount > 0 || incomeCount > 0 ? "pointer" : "default",
                    opacity: checkedValidCount > 0 || incomeCount > 0 ? 1 : 0.4,
                  }}
                >
                  Import {checkedValidCount} of {totalCount} rows
                  {incomeCount > 0 ? ` + ${incomeCount} interest` : ""}
                </button>
                <button
                  onClick={() => {
                    setParsed(null);
                    setDecimalPrompt(false);
                    setEditingIdx(null);
                    setEditDraft(null);
                  }}
                  style={{
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    color: T.textDim,
                    padding: "10px 16px",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  Back
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Main view -------------------------------------------------------------

function BondIncomeAudit({ bondIncome, onDelete, saving }) {
  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState(null);

  const sorted = useMemo(
    () => [...(bondIncome || [])].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [bondIncome]
  );

  const fmt = (n) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n || 0);

  const totalByKind = useMemo(() => {
    const t = { interest: 0, dividend: 0, tax: 0, other: 0 };
    for (const e of bondIncome || []) {
      const k = e.kind === "interest" ? "interest" : e.kind === "dividend" ? "dividend" : e.kind === "tax" ? "tax" : "other";
      t[k] += Number(e.amount) || 0;
    }
    return t;
  }, [bondIncome]);

  if (!bondIncome || bondIncome.length === 0) return null;

  const thStyle = {
    fontFamily: FONT_MONO,
    fontSize: 10,
    letterSpacing: "0.10em",
    textTransform: "uppercase",
    fontWeight: 500,
    padding: "6px 10px",
    borderBottom: `1px solid ${T.border}`,
    color: T.textFaint,
    whiteSpace: "nowrap",
    textAlign: "left",
  };
  const tdStyle = {
    fontFamily: FONT_MONO,
    fontSize: 12,
    padding: "6px 10px",
    borderBottom: `1px solid ${T.borderSoft}`,
    color: T.text,
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ marginTop: 24 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: `1px solid ${T.border}`,
          borderRadius: 4,
          padding: "8px 14px",
          color: T.textDim,
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          cursor: "pointer",
          width: "100%",
          justifyContent: "space-between",
        }}
      >
        <span>
          Import History — Bond Income
          <span style={{ marginLeft: 10, color: T.textFaint }}>
            {sorted.length} entries · {fmt(totalByKind.interest + totalByKind.dividend + totalByKind.tax + totalByKind.other)}
          </span>
        </span>
        <ChevronDown
          size={14}
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
        />
      </button>

      {open && (
        <div
          style={{
            marginTop: 4,
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "8px 12px", background: T.cardElev, display: "flex", gap: 20 }}>
            {totalByKind.interest > 0 && (
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                Interest <span style={{ color: T.text }}>{fmt(totalByKind.interest)}</span>
              </span>
            )}
            {totalByKind.dividend > 0 && (
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                Dividend <span style={{ color: T.text }}>{fmt(totalByKind.dividend)}</span>
              </span>
            )}
            {totalByKind.tax > 0 && (
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                Foreign Tax <span style={{ color: T.red }}>-{fmt(totalByKind.tax)}</span>
              </span>
            )}
            {totalByKind.other > 0 && (
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                Other <span style={{ color: T.text }}>{fmt(totalByKind.other)}</span>
              </span>
            )}
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textFaint, marginLeft: "auto" }}>
              Click trash to delete individual entries
            </span>
          </div>
          <ScrollHintTable fadeBg={T.bg}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Ticker</th>
                  <th style={thStyle}>Kind</th>
                  <th style={thStyle}>Source</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => {
                  const key = e.id || `${e.date}|${e.ticker}|${e.amount}`;
                  const isConfirming = confirmId === key;
                  return (
                    <tr key={key} style={{ background: isConfirming ? "rgba(232,140,140,0.07)" : "transparent" }}>
                      <td style={tdStyle}>{e.date || "—"}</td>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{e.ticker || "—"}</td>
                      <td style={{ ...tdStyle, color: T.textDim }}>{e.kind || "—"}</td>
                      <td style={{ ...tdStyle, color: T.textFaint }}>{e.source || "—"}</td>
                      <td style={{ ...tdStyle, textAlign: "right", color: e.kind === "tax" ? T.red : T.green }}>{e.kind === "tax" ? "-" : ""}{fmt(e.amount)}</td>
                      <td style={{ ...tdStyle, padding: "4px 8px" }}>
                        {isConfirming ? (
                          <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            <button
                              disabled={saving}
                              onClick={() => {
                                setConfirmId(null);
                                onDelete(key);
                              }}
                              style={{
                                background: T.red,
                                border: "none",
                                borderRadius: 3,
                                color: "#fff",
                                fontFamily: FONT_MONO,
                                fontSize: 10,
                                padding: "3px 8px",
                                cursor: saving ? "not-allowed" : "pointer",
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                              }}
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmId(null)}
                              style={{
                                background: "transparent",
                                border: `1px solid ${T.border}`,
                                borderRadius: 3,
                                color: T.textDim,
                                fontFamily: FONT_MONO,
                                fontSize: 10,
                                padding: "3px 8px",
                                cursor: "pointer",
                              }}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmId(key)}
                            title="Delete entry"
                            style={{
                              background: "transparent",
                              border: "none",
                              color: T.textFaint,
                              cursor: "pointer",
                              padding: 2,
                              display: "flex",
                              alignItems: "center",
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollHintTable>
        </div>
      )}
    </div>
  );
}

export default function TransactionsView({ auth, onAuthFail, knownTickers = [], valuesHidden, onTransactionsChange, pendingSplits = [], splitEvents = [], splitActionInFlight = null, onApproveSplit, onDismissSplit, holdings = [], onApproveFidelityBalance }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transactions, setTransactions] = useState([]);
  // Bond interest payments (separate income store; not in the transactions
  // array, so position math never sees them). Persisted alongside in the same
  // /api/transactions blob under a `bondIncome` field.
  const [bondIncome, setBondIncome] = useState([]);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null); // tx | null
  const [importOpen, setImportOpen] = useState(false);
  // Master collapse for the whole sync/automation region (Fidelity Import +
  // Balance Updates + Unmapped + Splits/Groupings) — collapsed by default so
  // it doesn't push the actual transaction table below the fold when there's
  // nothing needing attention.
  const [syncCardOpen, setSyncCardOpen] = useState(false);
  // Transaction history table — open by default (it's the main content of
  // this tab), collapsible so it can be skipped to reach BondIncomeAudit/
  // the rest of the screen without scrolling past hundreds of rows.
  const [historyOpen, setHistoryOpen] = useState(true);
  const [splitCardOpen, setSplitCardOpen] = useState(false);
  const [splitHistoryOpen, setSplitHistoryOpen] = useState(false);
  // Fidelity automation (item 38): trades staged by the scraper, awaiting approval.
  const [pendingFid, setPendingFid] = useState([]);
  const [pendingFidBond, setPendingFidBond] = useState([]);
  const [pendingFidOpen, setPendingFidOpen] = useState(true);
  const [pendingFidChecked, setPendingFidChecked] = useState(() => new Set());
  const [approvingFid, setApprovingFid] = useState(false);
  // Known Bank Bonds CUSIPs (from saved buy transactions) — options for the
  // editable ticker dropdown on staged INTEREST rows below, for when the
  // server-side auto-resolution (lib/simplefin-map.js INTEREST_RX branch)
  // couldn't resolve a single unambiguous match.
  const knownBankBondTickers = useMemo(() => {
    const s = new Set();
    for (const t of transactions) {
      if (t.assetClass === "Bank Bonds" && t.side === "buy" && t.ticker) s.add(String(t.ticker).trim().toUpperCase());
    }
    return s;
  }, [transactions]);
  // SimpleFin's bond-shaped holdings (no CUSIP, only a description + market
  // value) staged by the sync, plus the confirmed descKey -> CUSIP bindings.
  // The old "Bond Matching" UI was removed (jul/2026) once the sync started
  // creating bond buy transactions directly (bonds auto-resolve by descKey);
  // these are kept because `pendingBondHoldings` carries the per-bond current
  // values threaded into applyFidelityBalanceUpdate (Position Performance's
  // per-bond match), and `bondBindings` still feeds the metadata backfill.
  const [pendingBondHoldings, setPendingBondHoldings] = useState([]);
  const [bondBindings, setBondBindings] = useState({});
  // id -> ticker the user picked in the Fidelity Income dropdown, overriding
  // the staged event's own `ticker` (issuer name or server-resolved CUSIP)
  // only at approval time — never mutates pendingFidBond itself.
  const [bondTickerEdits, setBondTickerEdits] = useState({});
  // Income (dividend/interest/tax) staged by the SimpleFin sync — own
  // checkboxes + approve/discard, separate from the trades table above
  // (docs/plans/simplefin-fidelity-feed.md Fase 1: "hoje aprovado junto com
  // trades sem listagem própria").
  const [pendingFidBondChecked, setPendingFidBondChecked] = useState(() => new Set());
  const [pendingFidBondOpen, setPendingFidBondOpen] = useState(true);
  const [approvingFidBond, setApprovingFidBond] = useState(false);
  // Cash / Bank Bonds balance snapshots proposed by the SimpleFin sync now
  // auto-apply (no approval queue — see applyFidelityBalanceUpdate in
  // App.jsx). This ref tracks candidate ids already applied in this
  // component's lifetime, guarding against double-apply if the load/sync
  // effects re-fire before the `holdings` prop round-trips back down to
  // reflect the write (see effects below).
  const appliedBalanceIdsRef = useRef(new Set());
  // Transactions whose description SimpleFin couldn't map to anything known —
  // shown for review, with a per-row Dismiss for ones that don't need manual
  // entry (e.g. external transfers already captured by the Cash balance).
  const [pendingUnmapped, setPendingUnmapped] = useState([]);
  const [pendingUnmappedOpen, setPendingUnmappedOpen] = useState(false);
  const [unmappedActionId, setUnmappedActionId] = useState(null); // id of row mid Dismiss
  // Sync controls (admin-only).
  const [fidSyncing, setFidSyncing] = useState(false);
  const [fidSyncStatus, setFidSyncStatus] = useState(null); // { connected, lastSync, lastError, nextSyncAt }
  const [fidSyncMessage, setFidSyncMessage] = useState(null);
  // Ticker resolution status: { [TICKER]: "ok" | "error" } — cached in localStorage
  // so we don't re-hit the price API for already-validated tickers every load.
  const [tickerStatus, setTickerStatus] = useState(() => {
    try {
      const raw = localStorage.getItem("tickerStatus");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [checkingTickers, setCheckingTickers] = useState(() => new Set());
  const isAdmin = isUserAdmin(auth);
  const onAuthFailRef = useRef(onAuthFail);
  useEffect(() => {
    onAuthFailRef.current = onAuthFail;
  }, [onAuthFail]);

  // Persist ticker status cache.
  useEffect(() => {
    try {
      localStorage.setItem("tickerStatus", JSON.stringify(tickerStatus));
    } catch {}
  }, [tickerStatus]);

  // Verify a set of transactions' tickers against the price API, in small batches
  // (respecting rate limits). `force` re-checks even already-known tickers.
  async function verifyTickers(list, { force = false } = {}) {
    const toCheck = [];
    const seen = new Set();
    for (const tx of list) {
      if (!shouldVerifyTicker(tx)) continue;
      const t = tx.ticker.trim().toUpperCase();
      if (seen.has(t)) continue;
      seen.add(t);
      // Only "ok" is cached permanently; re-check "error"/"unknown" every load
      // (the symbol may have been fixed, or a prior failure was transient).
      if (!force && tickerStatus[t] === "ok") continue;
      toCheck.push(tx.ticker.trim());
    }
    if (toCheck.length === 0) return;

    setCheckingTickers((prev) => {
      const next = new Set(prev);
      toCheck.forEach((t) => next.add(t.toUpperCase()));
      return next;
    });

    const batchSize = 3;
    for (let i = 0; i < toCheck.length; i += batchSize) {
      const batch = toCheck.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (t) => {
          try {
            const status = await verifyTickerResolvable(t, auth);
            return [t.toUpperCase(), status];
          } catch (e) {
            if (e.code === 401 && typeof onAuthFailRef.current === "function") {
              onAuthFailRef.current();
            }
            return [t.toUpperCase(), "unknown"];
          }
        })
      );
      setTickerStatus((prev) => {
        const next = { ...prev };
        for (const [t, status] of results) {
          if (status === "ok" || status === "error") next[t] = status;
        }
        return next;
      });
      setCheckingTickers((prev) => {
        const next = new Set(prev);
        batch.forEach((t) => next.delete(t.toUpperCase()));
        return next;
      });
      if (i + batchSize < toCheck.length) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTransactionsFromServer(auth)
      .then((data) => {
        if (cancelled) return;
        const raw = Array.isArray(data.transactions) ? data.transactions : [];
        // Backfill assetClass on legacy records via inferAssetClass.
        const migrated = raw.map((t) => {
          if (t.assetClass) return t;
          const cls = inferAssetClass(t.ticker) || (t.currency === "BRL" ? "Unallocated BRL" : "Unallocated USD");
          return { ...t, assetClass: cls };
        });
        setTransactions(migrated);
        setBondIncome(Array.isArray(data.bondIncome) ? data.bondIncome : []);
        setLoading(false);
        // Validate tickers against the price API in the background.
        verifyTickers(migrated);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.code === 401 && typeof onAuthFailRef.current === "function") {
          onAuthFailRef.current();
          return;
        }
        setError(err.message || "Failed to load");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  async function persist(nextList, nextIncome) {
    setSaving(true);
    try {
      await saveTransactionsToServer(auth, nextList, nextIncome);
      setTransactions(nextList);
      if (Array.isArray(nextIncome)) setBondIncome(nextIncome);
      onTransactionsChange?.(nextList);
    } catch (err) {
      setError(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // Load Fidelity automation staging on mount. Filters out anything already live
  // (defensive — the server staging endpoint already skips live dups). Fail-silent.
  useEffect(() => {
    let cancelled = false;
    fetchPendingFidelity(auth).then((p) => {
      if (cancelled) return;
      const liveTxKeys = new Set(transactions.map(dupKey));
      const freshTx = (p.transactions || []).filter((t) => !liveTxKeys.has(dupKey(t)));
      const liveBondKeys = new Set(bondIncome.map((e) => `${e.date}|${e.ticker}|${e.amount}`));
      const freshBond = (p.bondIncome || []).filter(
        (e) => !liveBondKeys.has(`${e.date}|${e.ticker}|${e.amount}`)
      );
      const freshBalance = pruneUnchangedBalanceCandidates(p.balanceCandidates, holdings);
      setPendingFid(freshTx);
      setPendingFidBond(freshBond);
      setPendingUnmapped(p.unmapped || []);
      setPendingBondHoldings(p.bondHoldings || []);
      setBondBindings(p.bondBindings || {});
      setPendingFidChecked(new Set(freshTx.map((t) => t.id || dupKey(t))));
      setPendingFidBondChecked(new Set(freshBond.map((e) => e.id)));
      // Cash / Bank Bonds balances auto-apply — no approval queue.
      // Key includes the proposed value (not just id) so a real value change
      // re-applies even though the candidate id is deterministic per account.
      const toApply = freshBalance.filter(
        (c) => !appliedBalanceIdsRef.current.has(`${c.id}:${c.proposed}`)
      );
      for (const c of toApply) {
        appliedBalanceIdsRef.current.add(`${c.id}:${c.proposed}`);
        // Pass the per-bond holdings snapshot so the Bank Bonds candidate can
        // record per-bond current values (descKey -> market value) for
        // Position Performance's per-bond match.
        onApproveFidelityBalance?.(c, p.bondHoldings || []);
      }
      if ((p.balanceCandidates || []).length > 0) {
        patchPendingFidelity(auth, { balanceCandidates: [] });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, transactions, bondIncome]);

  // Sync metadata (admin-only feature, but harmless to fetch for anyone —
  // the endpoint just reads this user's own staging blob).
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetchFidelitySyncStatus(auth).then((s) => {
      if (!cancelled && s) setFidSyncStatus(s);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, isAdmin]);

  async function runFidelitySync() {
    setFidSyncing(true);
    setFidSyncMessage(null);
    try {
      const res = await fetch("/api/fidelity-pending?resource=sync", {
        method: "POST",
        headers: authHeaders(auth),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && typeof onAuthFail === "function") {
        onAuthFail();
        return;
      }
      if (!res.ok) {
        setFidSyncMessage(data.error || `HTTP ${res.status}`);
        return;
      }
      setFidSyncStatus({
        connected: true,
        lastSync: data.lastSync,
        lastError: data.lastError,
        nextSyncAt: data.nextSyncAt,
      });
      if (data.throttled) {
        setFidSyncMessage("Synced recently — showing current staging (throttled to once per 6h).");
      } else {
        setFidSyncMessage(
          `Synced: +${data.added} trade${data.added === 1 ? "" : "s"}, +${data.addedBond} income, +${data.addedBalance} balance update${data.addedBalance === 1 ? "" : "s"}, +${data.addedUnmapped} unmapped.`
        );
      }
      const p = await fetchPendingFidelity(auth);
      const liveTxKeys = new Set(transactions.map(dupKey));
      const freshTx = (p.transactions || []).filter((t) => !liveTxKeys.has(dupKey(t)));
      const liveBondKeys = new Set(bondIncome.map((e) => `${e.date}|${e.ticker}|${e.amount}`));
      const freshBond = (p.bondIncome || []).filter(
        (e) => !liveBondKeys.has(`${e.date}|${e.ticker}|${e.amount}`)
      );
      const freshBalance = pruneUnchangedBalanceCandidates(p.balanceCandidates, holdings);
      setPendingFid(freshTx);
      setPendingFidBond(freshBond);
      setPendingUnmapped(p.unmapped || []);
      setPendingBondHoldings(p.bondHoldings || []);
      setBondBindings(p.bondBindings || {});
      setPendingFidChecked(new Set(freshTx.map((t) => t.id || dupKey(t))));
      setPendingFidBondChecked(new Set(freshBond.map((e) => e.id)));
      // Cash / Bank Bonds balances auto-apply — no approval queue.
      // Key includes the proposed value (not just id) so a real value change
      // re-applies even though the candidate id is deterministic per account.
      const toApply = freshBalance.filter(
        (c) => !appliedBalanceIdsRef.current.has(`${c.id}:${c.proposed}`)
      );
      for (const c of toApply) {
        appliedBalanceIdsRef.current.add(`${c.id}:${c.proposed}`);
        // Pass the per-bond holdings snapshot so the Bank Bonds candidate can
        // record per-bond current values (descKey -> market value) for
        // Position Performance's per-bond match.
        onApproveFidelityBalance?.(c, p.bondHoldings || []);
      }
      if ((p.balanceCandidates || []).length > 0) {
        patchPendingFidelity(auth, { balanceCandidates: [] });
      }
    } catch (e) {
      setFidSyncMessage(e.message || "Network error");
    } finally {
      setFidSyncing(false);
    }
  }

  function togglePendingFid(key) {
    setPendingFidChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function approvePendingFid() {
    const keyOf = (t) => t.id || dupKey(t);
    const selected = pendingFid.filter((t) => pendingFidChecked.has(keyOf(t)));
    if (selected.length === 0) return;
    setApprovingFid(true);
    try {
      // Merge selected staged trades into live, deduped by dupKey.
      const liveKeys = new Set(transactions.map(dupKey));
      const toAdd = selected.filter((t) => !liveKeys.has(dupKey(t)));
      const nextTx = [...transactions, ...toAdd];
      await persist(nextTx);
      // Only remove the approved rows from staging — leaves unchecked trades
      // (and the income/balance/unmapped sections) untouched.
      const remaining = pendingFid.filter((t) => !pendingFidChecked.has(keyOf(t)));
      await patchPendingFidelity(auth, { transactions: remaining });
      setPendingFid(remaining);
      setPendingFidChecked(new Set(remaining.map(keyOf)));
      verifyTickers(toAdd);
    } catch (err) {
      setError(err.message || "Approve failed");
    } finally {
      setApprovingFid(false);
    }
  }

  async function discardPendingFid() {
    setApprovingFid(true);
    try {
      await patchPendingFidelity(auth, { transactions: [] });
      setPendingFid([]);
      setPendingFidChecked(new Set());
    } finally {
      setApprovingFid(false);
    }
  }

  function togglePendingFidBond(id) {
    setPendingFidBondChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function approvePendingFidBond() {
    const selected = pendingFidBond.filter((e) => pendingFidBondChecked.has(e.id));
    if (selected.length === 0) return;
    setApprovingFidBond(true);
    try {
      const seen = new Set(bondIncome.map((e) => `${e.date}|${e.ticker}|${e.amount}`));
      const nextIncome = [...bondIncome];
      for (const e of selected) {
        // Apply any manual ticker override picked in the dropdown (interest
        // rows only — see the "Fidelity Income" table below) before the
        // dedupe key/push, so both use the final, user-confirmed ticker.
        const finalEv = { ...e, ticker: bondTickerEdits[e.id] ?? e.ticker };
        const k = `${finalEv.date}|${finalEv.ticker}|${finalEv.amount}`;
        if (seen.has(k)) continue;
        seen.add(k);
        nextIncome.push(finalEv);
      }
      await persist(transactions, nextIncome);
      const remaining = pendingFidBond.filter((e) => !pendingFidBondChecked.has(e.id));
      await patchPendingFidelity(auth, { bondIncome: remaining });
      setPendingFidBond(remaining);
      setPendingFidBondChecked(new Set(remaining.map((e) => e.id)));
      setBondTickerEdits((prev) => {
        const next = { ...prev };
        for (const e of selected) delete next[e.id];
        return next;
      });
    } catch (err) {
      setError(err.message || "Approve failed");
    } finally {
      setApprovingFidBond(false);
    }
  }

  async function discardPendingFidBond() {
    setApprovingFidBond(true);
    try {
      await patchPendingFidelity(auth, { bondIncome: [] });
      setPendingFidBond([]);
      setPendingFidBondChecked(new Set());
    } finally {
      setApprovingFidBond(false);
    }
  }

  // Unmapped rows are keyed by simplefinId when present, else their index in
  // pendingUnmapped (same fallback used for the table's React `key`).
  async function dismissUnmappedItem(item, index) {
    const rowId = item.simplefinId || index;
    setUnmappedActionId(rowId);
    try {
      const remaining = pendingUnmapped.filter((u, i) => (u.simplefinId || i) !== rowId);
      await patchPendingFidelity(auth, { unmapped: remaining });
      setPendingUnmapped(remaining);
    } finally {
      setUnmappedActionId(null);
    }
  }


  // Bond metadata backfill (jul/2026). Single reconciliation effect that runs
  // the backfill over EVERY entry currently in `bondBindings` — the bindings
  // are now populated exclusively by the server-side auto-bind on sync (the
  // manual "Bond Matching" UI was removed once the sync started creating bond
  // buy transactions directly). Runs retroactively every time this component
  // mounts (bondBindings arrives already populated from the load effect),
  // backed by lib/bond-meta.js so the pure logic isn't duplicated.
  //
  // Loop safety: backfillBondMetadata returns the SAME transactions array
  // reference when a pass makes no change. We only persist when the
  // accumulated result differs by reference from the current `transactions`
  // state. After a successful persist, `transactions` becomes that backfilled
  // array; the effect re-fires (transactions is a dep), recomputes over the
  // now-already-filled data, gets back the same reference -> no persist ->
  // settles. `backfillContentSigRef` is a belt-and-suspenders backstop
  // (same spirit as `appliedBalanceIdsRef` above): it compares a content
  // signature of the Bank Bonds metadata fields, so even a hypothetical bug
  // in backfillBondMetadata that returned a "changed" reference without an
  // actual content change couldn't drive repeated persists.
  const backfillContentSigRef = useRef(null);
  const backfillInFlightRef = useRef(false);
  useEffect(() => {
    const entries = Object.entries(bondBindings || {});
    if (entries.length === 0) return;
    if (backfillInFlightRef.current) return;

    let next = transactions;
    for (const [descKey, cusip] of entries) {
      const holding = pendingBondHoldings.find(
        (h) => bondHoldingKey(h) === descKey || h.descKey === descKey
      );
      if (!holding || !holding.description) continue;
      next = backfillBondMetadata(next, cusip, holding.description);
    }
    if (next === transactions) return; // nothing to fill in — settled

    const sig = next
      .filter((t) => t && t.assetClass === "Bank Bonds")
      .map((t) => `${t.id}:${t.couponRate ?? ""}:${t.maturityDate ?? ""}:${t.shortName ?? ""}:${t.notes ?? ""}`)
      .join("|");
    if (sig === backfillContentSigRef.current) return; // same content already attempted

    backfillInFlightRef.current = true;
    backfillContentSigRef.current = sig;
    // Low-priority, idempotent write: a save conflict (409) or network error
    // is handled inside persist() itself (sets `error` state) and never
    // throws here — fail-silent is acceptable, it'll be retried next time
    // bondBindings/transactions change for an unrelated reason.
    persist(next).finally(() => {
      backfillInFlightRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, transactions, bondIncome, bondBindings, pendingBondHoldings]);

  async function handleAdd(tx) {
    await persist([...transactions, tx]);
    setFormOpen(false);
    verifyTickers([tx], { force: true });
  }

  async function handleUpdate(tx) {
    const next = transactions.map((t) => (t.id === tx.id ? tx : t));
    await persist(next);
    setEditing(null);
    verifyTickers([tx], { force: true });
  }

  async function handleDelete(tx) {
    const next = transactions.filter((t) => t.id !== tx.id);
    await persist(next);
  }

  async function handleBulkDelete(ids) {
    const idSet = new Set(ids);
    const next = transactions.filter((t) => !idSet.has(t.id));
    await persist(next);
  }

  async function handleBulkAssetClass(ids, cls) {
    const idSet = new Set(ids);
    const cur = currencyForAssetClass(cls) || "USD";
    const next = transactions.map((t) =>
      idSet.has(t.id) ? { ...t, assetClass: cls, currency: cur } : t
    );
    await persist(next);
  }

  async function handleImport(newTxs, mode, newIncome = [], distributions = []) {
    const next = mode === "replace" ? newTxs : [...transactions, ...newTxs];
    // Merge detected interest payments into the income store, deduping by
    // date+ticker+amount. On "replace" the income store is rebuilt from scratch.
    const base = mode === "replace" ? [] : bondIncome;
    // Purge any stale income record that matches a share-distribution row in the
    // imported file. An older parser wrongly captured "DISTRIBUTION ... DIVIDEND
    // ARISTOCRATS" (NOBL) rows as cash dividends; re-importing the same file now
    // self-heals that by removing the exact (date|ticker|amount) match.
    const distKeys = new Set(
      (distributions || []).map((d) => `${d.date}|${d.ticker}|${d.amount}`)
    );
    const seen = new Set();
    const mergedIncome = [];
    for (const e of base) {
      const k = `${e.date}|${e.ticker}|${e.amount}`;
      if (distKeys.has(k)) continue; // drop the mis-captured distribution
      seen.add(k);
      mergedIncome.push(e);
    }
    for (const e of newIncome) {
      const k = `${e.date}|${e.ticker}|${e.amount}`;
      if (seen.has(k) || distKeys.has(k)) continue;
      seen.add(k);
      mergedIncome.push(e);
    }
    await persist(next, mergedIncome);
    setImportOpen(false);
    verifyTickers(newTxs);
  }

  function handleExport() {
    const csv = transactionsToCSV(transactions);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCSV(`transactions-${stamp}.csv`, csv);
  }

  if (loading) {
    return (
      <div
        style={{
          padding: "40px 0",
          textAlign: "center",
          color: T.textDim,
          fontFamily: FONT_MONO,
          fontSize: 12,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        Loading transactions...
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.red}`,
            padding: 12,
            color: T.red,
            fontFamily: FONT_MONO,
            fontSize: 12,
            marginBottom: 12,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Error: {error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: "transparent",
              border: "none",
              color: T.red,
              cursor: "pointer",
              padding: 4,
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Summary + Add button */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: T.textDim,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          {`${transactions.length} total`}
          {saving && " - saving..."}
        </div>
        {!formOpen && !editing && (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => setImportOpen(true)}
              title="Import from CSV or paste"
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                color: T.textDim,
                padding: "8px 12px",
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Upload size={12} />
              Bulk Import
            </button>
            {transactions.length > 0 && (
              <button
                onClick={handleExport}
                title="Export to CSV"
                style={{
                  background: "transparent",
                  border: `1px solid ${T.border}`,
                  color: T.textDim,
                  padding: "8px 12px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Download size={12} />
                Export
              </button>
            )}
            <button
              onClick={() => setFormOpen(true)}
              style={{
                background: T.gold,
                border: "none",
                color: "#0b0d10",
                padding: "8px 14px",
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Plus size={12} />
              New
            </button>
          </div>
        )}
      </div>

      {/* Sync & automation — Fidelity Import (trades/income/balance updates/
          unmapped) plus Splits/Groupings, folded behind one master toggle so
          this admin/utility clutter doesn't stand between the toolbar and the
          actual transaction table below. Individual sub-sections keep their
          own collapse state once this is open. */}
      {(isAdmin || pendingFid.length > 0 || pendingFidBond.length > 0 || pendingUnmapped.length > 0 || pendingSplits.length > 0 || splitEvents.length > 0) && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setSyncCardOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: syncCardOpen ? "4px 4px 0 0" : 4,
              padding: "10px 14px",
              cursor: "pointer",
              color: T.textDim,
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
            }}
          >
            <ChevronDown
              size={12}
              style={{
                transform: syncCardOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.2s",
              }}
            />
            Sync & Automation
            {(pendingFid.length + pendingFidBond.length + pendingUnmapped.length + pendingSplits.length) > 0 && (
              <span
                style={{
                  marginLeft: 8,
                  background: T.gold,
                  color: "#0b0d10",
                  fontFamily: FONT_MONO,
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "1px 6px",
                  borderRadius: 8,
                }}
              >
                {pendingFid.length + pendingFidBond.length + pendingUnmapped.length + pendingSplits.length}
              </span>
            )}
          </button>
          {syncCardOpen && (
            <div style={{ padding: "14px 0 0" }}>

      {/* Fidelity Import — staged by the automation (item 38), extended for the
          SimpleFin sync (docs/plans/simplefin-fidelity-feed.md Fase 1): trades,
          income, balance updates and unmapped rows each get their own section.
          The whole group renders for admin (so the Sync button is reachable
          even with nothing staged yet) or for anyone with staged content. */}
      {(isAdmin || pendingFid.length > 0 || pendingFidBond.length > 0 || pendingUnmapped.length > 0) && (
        <div style={{ marginBottom: 16 }}>
          {isAdmin && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 10,
                padding: "8px 12px",
                background: T.card,
                border: `1px solid ${T.border}`,
                borderRadius: 4,
              }}
            >
              <button
                onClick={runFidelitySync}
                disabled={fidSyncing}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: T.gold,
                  color: "#0b0d10",
                  border: "none",
                  borderRadius: 4,
                  padding: "6px 12px",
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  cursor: fidSyncing ? "default" : "pointer",
                  opacity: fidSyncing ? 0.6 : 1,
                }}
              >
                <RefreshCw size={11} className={fidSyncing ? "spin" : undefined} />
                {fidSyncing ? "Syncing…" : "Sync Fidelity"}
              </button>
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textDim }}>
                {fidSyncStatus?.lastSync
                  ? `Last sync: ${new Date(fidSyncStatus.lastSync).toLocaleString()}`
                  : "Never synced"}
              </span>
              {fidSyncStatus?.lastError && (
                <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.red }}>
                  {fidSyncStatus.lastError}
                </span>
              )}
              {fidSyncMessage && (
                <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textDim }}>
                  {fidSyncMessage}
                </span>
              )}
            </div>
          )}

      {pendingFid.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setPendingFidOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              background: "rgba(201,169,97,0.06)",
              border: `1px solid ${T.gold}55`,
              borderRadius: pendingFidOpen ? "4px 4px 0 0" : 4,
              padding: "10px 14px",
              cursor: "pointer",
              color: T.gold,
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
            }}
          >
            <ChevronDown
              size={12}
              style={{
                transform: pendingFidOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.2s",
              }}
            />
            Fidelity Import
            <span
              style={{
                marginLeft: 8,
                background: T.gold,
                color: "#0b0d10",
                fontFamily: FONT_MONO,
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 6px",
                borderRadius: 8,
              }}
            >
              {pendingFid.length} new
            </span>
          </button>

          {pendingFidOpen && (
            <div
              style={{
                background: T.card,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                borderRadius: "0 0 4px 4px",
                padding: 14,
              }}
            >
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: T.textDim,
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                Staged by the automated import. Review and approve to add to your
                transactions. Nothing is saved until you approve.
              </div>

              <div style={{ marginBottom: 12 }}>
              <ScrollHintTable>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}>
                        <input
                          type="checkbox"
                          checked={pendingFidChecked.size === pendingFid.length}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setPendingFidChecked(new Set(pendingFid.map((t) => t.id || dupKey(t))));
                            } else {
                              setPendingFidChecked(new Set());
                            }
                          }}
                        />
                      </th>
                      {["Date", "B/S", "Ticker", "Qty", "Price"].map((h) => (
                        <th
                          key={h}
                          style={{
                            textAlign: h === "Qty" || h === "Price" ? "right" : "left",
                            fontFamily: FONT_MONO,
                            fontSize: 9,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            color: T.textFaint,
                            padding: "4px 8px",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pendingFid.map((t) => {
                      const key = t.id || dupKey(t);
                      const cur = t.currency || "USD";
                      return (
                        <tr key={key} style={{ borderTop: `1px solid ${T.border}` }}>
                          <td style={{ padding: "4px 0" }}>
                            <input
                              type="checkbox"
                              checked={pendingFidChecked.has(key)}
                              onChange={() => togglePendingFid(key)}
                            />
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, padding: "4px 8px" }}>
                            {t.date}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: t.side === "sell" ? T.red : T.green, padding: "4px 8px" }}>
                            {t.side === "sell" ? "S" : "B"}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, padding: "4px 8px" }}>
                            {t.ticker}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, textAlign: "right", padding: "4px 8px" }}>
                            {fmtNum(t.qty)}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, textAlign: "right", padding: "4px 8px" }}>
                            {valuesHidden ? "•••" : fmtMoney(t.price, cur)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollHintTable>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={approvePendingFid}
                  disabled={approvingFid || pendingFidChecked.size === 0}
                  style={{
                    background: T.gold,
                    color: "#0b0d10",
                    border: "none",
                    borderRadius: 4,
                    padding: "8px 14px",
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    cursor: approvingFid || pendingFidChecked.size === 0 ? "default" : "pointer",
                    opacity: approvingFid || pendingFidChecked.size === 0 ? 0.5 : 1,
                  }}
                >
                  {approvingFid ? "Working…" : `Approve ${pendingFidChecked.size} of ${pendingFid.length}`}
                </button>
                <button
                  onClick={discardPendingFid}
                  disabled={approvingFid}
                  style={{
                    background: "transparent",
                    color: T.textDim,
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    padding: "8px 14px",
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    cursor: approvingFid ? "default" : "pointer",
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Income (dividend/interest/tax) staged by the SimpleFin sync — own
          checkboxes, separate from the trades table above. */}
      {pendingFidBond.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setPendingFidBondOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              background: "rgba(201,169,97,0.06)",
              border: `1px solid ${T.gold}55`,
              borderRadius: pendingFidBondOpen ? "4px 4px 0 0" : 4,
              padding: "10px 14px",
              cursor: "pointer",
              color: T.gold,
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
            }}
          >
            <ChevronDown
              size={12}
              style={{
                transform: pendingFidBondOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.2s",
              }}
            />
            Fidelity Income
            <span
              style={{
                marginLeft: 8,
                background: T.gold,
                color: "#0b0d10",
                fontFamily: FONT_MONO,
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 6px",
                borderRadius: 8,
              }}
            >
              {pendingFidBond.length} new
            </span>
          </button>

          {pendingFidBondOpen && (
            <div
              style={{
                background: T.card,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                borderRadius: "0 0 4px 4px",
                padding: 14,
              }}
            >
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: T.textDim,
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                Dividends, bond interest and withheld tax staged by the SimpleFin
                sync. Review and approve to add to your income history.
              </div>

              <div style={{ marginBottom: 12 }}>
                <ScrollHintTable>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 28 }}>
                          <input
                            type="checkbox"
                            checked={pendingFidBondChecked.size === pendingFidBond.length}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setPendingFidBondChecked(new Set(pendingFidBond.map((e) => e.id)));
                              } else {
                                setPendingFidBondChecked(new Set());
                              }
                            }}
                          />
                        </th>
                        {["Date", "Kind", "Ticker", "Amount"].map((h) => (
                          <th
                            key={h}
                            style={{
                              textAlign: h === "Amount" ? "right" : "left",
                              fontFamily: FONT_MONO,
                              fontSize: 9,
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              color: T.textFaint,
                              padding: "4px 8px",
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pendingFidBond.map((e) => (
                        <tr key={e.id} style={{ borderTop: `1px solid ${T.border}` }}>
                          <td style={{ padding: "4px 0" }}>
                            <input
                              type="checkbox"
                              checked={pendingFidBondChecked.has(e.id)}
                              onChange={() => togglePendingFidBond(e.id)}
                            />
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, padding: "4px 8px" }}>
                            {e.date}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim, padding: "4px 8px", textTransform: "capitalize" }}>
                            {e.kind}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, padding: "4px 8px" }}>
                            {e.kind === "interest" ? (
                              <select
                                value={bondTickerEdits[e.id] ?? e.ticker}
                                onChange={(ev) =>
                                  setBondTickerEdits((prev) => ({ ...prev, [e.id]: ev.target.value }))
                                }
                                style={{
                                  background: T.cardElev,
                                  border: `1px solid ${T.gold}`,
                                  color: T.gold,
                                  padding: "2px 4px",
                                  fontFamily: FONT_MONO,
                                  fontSize: 10,
                                  cursor: "pointer",
                                  maxWidth: 160,
                                }}
                              >
                                {!knownBankBondTickers.has(String(bondTickerEdits[e.id] ?? e.ticker).toUpperCase()) && (
                                  <option value={e.ticker}>{`${e.ticker} (unresolved)`}</option>
                                )}
                                {[...knownBankBondTickers].sort().map((tk) => (
                                  <option key={tk} value={tk}>
                                    {tk}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              e.ticker
                            )}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, textAlign: "right", padding: "4px 8px" }}>
                            {valuesHidden ? "•••" : fmtMoney(e.amount, "USD")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollHintTable>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={approvePendingFidBond}
                  disabled={approvingFidBond || pendingFidBondChecked.size === 0}
                  style={{
                    background: T.gold,
                    color: "#0b0d10",
                    border: "none",
                    borderRadius: 4,
                    padding: "8px 14px",
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    cursor: approvingFidBond || pendingFidBondChecked.size === 0 ? "default" : "pointer",
                    opacity: approvingFidBond || pendingFidBondChecked.size === 0 ? 0.5 : 1,
                  }}
                >
                  {approvingFidBond ? "Working…" : `Approve ${pendingFidBondChecked.size} of ${pendingFidBond.length}`}
                </button>
                <button
                  onClick={discardPendingFidBond}
                  disabled={approvingFidBond}
                  style={{
                    background: "transparent",
                    color: T.textDim,
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    padding: "8px 14px",
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    cursor: approvingFidBond ? "default" : "pointer",
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Balance Updates (Cash / Bank Bonds) — removed: these now auto-apply
          from the SimpleFin sync with no approval queue. See the "Last
          Synced (SimpleFin)" / "Market Value (SimpleFin)" info blocks in
          ManualHoldingRow's accordion (App.jsx) for the equivalent status
          surface. */}

      {/* Unmapped — SimpleFin rows that matched no known pattern (or matched
          one but couldn't be completed, e.g. a trade with no structured
          qty/price). Never auto-imported; each row gets a Dismiss for cases
          that don't need manual entry (e.g. an external transfer already
          captured by the Cash balance update). */}
      {pendingUnmapped.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setPendingUnmappedOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: pendingUnmappedOpen ? "4px 4px 0 0" : 4,
              padding: "10px 14px",
              cursor: "pointer",
              color: T.textDim,
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
            }}
          >
            <ChevronDown
              size={12}
              style={{
                transform: pendingUnmappedOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.2s",
              }}
            />
            Unmapped — needs review
            <span
              style={{
                marginLeft: 8,
                background: T.border,
                color: T.textDim,
                fontFamily: FONT_MONO,
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 6px",
                borderRadius: 8,
              }}
            >
              {pendingUnmapped.length}
            </span>
          </button>
          {pendingUnmappedOpen && (
            <div
              style={{
                background: T.card,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                borderRadius: "0 0 4px 4px",
                padding: 14,
              }}
            >
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: T.textDim,
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                SimpleFin transactions the sync couldn't map to a known category
                (or matched a pattern but couldn't build a valid entry, e.g. a
                stock trade or a new bond/CD purchase — SimpleFin has no
                structured qty/price for trades of any kind, so it always
                needs manual entry). Enter these manually if needed via the
                form or CSV import above.
              </div>
              <ScrollHintTable>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                  <thead>
                    <tr>
                      {["Date", "Description", "Amount", "Reason", ""].map((h, hi) => (
                        <th
                          key={h || hi}
                          style={{
                            textAlign: h === "Amount" ? "right" : "left",
                            fontFamily: FONT_MONO,
                            fontSize: 9,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            color: T.textFaint,
                            padding: "4px 8px",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pendingUnmapped.map((u, i) => {
                      const rowId = u.simplefinId || i;
                      const inFlight = unmappedActionId === rowId;
                      return (
                        <tr key={rowId} style={{ borderTop: `1px solid ${T.border}` }}>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, padding: "4px 8px" }}>
                            {u.date || "—"}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, padding: "4px 8px" }}>
                            {u.description}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.text, textAlign: "right", padding: "4px 8px" }}>
                            {valuesHidden ? "•••" : u.amount != null ? fmtMoney(u.amount, "USD") : "—"}
                          </td>
                          <td style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint, padding: "4px 8px" }}>
                            {u.reason}
                          </td>
                          <td style={{ padding: "4px 8px", textAlign: "right" }}>
                            <button
                              onClick={() => dismissUnmappedItem(u, i)}
                              disabled={inFlight}
                              style={{
                                background: "transparent",
                                color: T.textDim,
                                border: `1px solid ${T.border}`,
                                borderRadius: 4,
                                padding: "4px 8px",
                                fontFamily: FONT_MONO,
                                fontSize: 9,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                cursor: inFlight ? "default" : "pointer",
                                opacity: inFlight ? 0.5 : 1,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {inFlight ? "…" : "Dismiss"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollHintTable>
            </div>
          )}
        </div>
      )}
        </div>
      )}
      {/* end Fidelity Import group */}


      {/* Splits / Groupings inline card */}
      {(pendingSplits.length > 0 || splitEvents.length > 0) && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setSplitCardOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              background: pendingSplits.length > 0 ? "rgba(201,169,97,0.06)" : T.card,
              border: `1px solid ${pendingSplits.length > 0 ? T.gold + "55" : T.border}`,
              borderRadius: splitCardOpen ? "4px 4px 0 0" : 4,
              padding: "10px 14px",
              cursor: "pointer",
              color: pendingSplits.length > 0 ? T.gold : T.textDim,
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
            }}
          >
            <ChevronDown
              size={12}
              style={{
                transform: splitCardOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.2s",
              }}
            />
            Splits / Groupings
            {pendingSplits.length > 0 && (
              <span
                style={{
                  marginLeft: 8,
                  background: T.gold,
                  color: "#0b0d10",
                  fontFamily: FONT_MONO,
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "1px 6px",
                  borderRadius: 8,
                }}
              >
                {pendingSplits.length} pending
              </span>
            )}
          </button>

          {splitCardOpen && (
            <div
              style={{
                background: T.card,
                border: `1px solid ${T.border}`,
                borderTop: "none",
                borderRadius: "0 0 4px 4px",
                padding: 14,
              }}
            >
              {/* Pending section */}
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 9,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: T.textFaint,
                  marginBottom: 10,
                }}
              >
                Pending ({pendingSplits.length})
              </div>

              {pendingSplits.length === 0 ? (
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    color: T.textDim,
                    padding: "8px 0 16px",
                    lineHeight: 1.5,
                  }}
                >
                  No pending splits. History is up to date.
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    marginBottom: splitEvents.length > 0 ? 16 : 0,
                  }}
                >
                  {pendingSplits.map((sp) => {
                    const key = `${sp.ticker}|${sp.date}|${sp.numerator}|${sp.denominator}`;
                    const num = Number(sp.numerator);
                    const den = Number(sp.denominator);
                    const isReverse = den > num;
                    const factorLabel = isReverse ? `${num}:${den} reverse` : `${num}:${den}`;
                    const isThisInFlight = splitActionInFlight === key;
                    const anyInFlight = splitActionInFlight !== null;
                    const affected = transactions.filter(
                      (tx) =>
                        (tx.ticker || "").toUpperCase() === sp.ticker &&
                        tx.date < sp.date &&
                        !(tx.splitAdjusted && tx.splitDate === sp.date)
                    );
                    const thStyle = {
                      fontFamily: FONT_MONO,
                      fontSize: 9,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: T.textFaint,
                      padding: "6px 8px",
                      borderBottom: `1px solid ${T.border}`,
                      whiteSpace: "nowrap",
                    };
                    const tdStyle = {
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      padding: "6px 8px",
                      borderBottom: `1px solid ${T.borderSoft}`,
                      color: T.text,
                      whiteSpace: "nowrap",
                    };
                    return (
                      <div
                        key={key}
                        style={{
                          background: T.cardElev,
                          border: `1px solid ${T.borderSoft}`,
                          borderRadius: 4,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 10,
                            flexWrap: "wrap",
                            padding: "8px 12px",
                            borderBottom: `1px solid ${T.borderSoft}`,
                          }}
                        >
                          <span style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 600, color: T.text }}>
                            {sp.ticker}
                          </span>
                          <span
                            style={{
                              fontFamily: FONT_MONO,
                              fontSize: 11,
                              color: isReverse ? T.red : T.green,
                              letterSpacing: "0.08em",
                              textTransform: "uppercase",
                            }}
                          >
                            {factorLabel}
                          </span>
                          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.textDim }}>
                            {sp.date}
                          </span>
                          <span style={{ marginLeft: "auto", fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint }}>
                            {affected.length} tx affected
                          </span>
                        </div>

                        {affected.length > 0 && (
                          <ScrollHintTable fadeBg={T.cardElev}>
                            <table style={{ width: "100%", minWidth: 380, borderCollapse: "collapse" }}>
                              <thead>
                                <tr>
                                  <th style={{ ...thStyle, textAlign: "left" }}>Date</th>
                                  <th style={{ ...thStyle, textAlign: "right" }}>Qty {"→"} New</th>
                                  <th style={{ ...thStyle, textAlign: "right" }}>Price {"→"} New</th>
                                </tr>
                              </thead>
                              <tbody>
                                {affected.map((tx) => {
                                  const newQty = parseFloat((tx.qty * (num / den)).toFixed(6));
                                  const newPrice = parseFloat((tx.price * (den / num)).toFixed(6));
                                  return (
                                    <tr key={tx.id}>
                                      <td style={{ ...tdStyle, textAlign: "left" }}>{tx.date}</td>
                                      <td style={{ ...tdStyle, textAlign: "right" }}>
                                        {tx.qty} {"→"} <span style={{ color: T.gold }}>{newQty}</span>
                                      </td>
                                      <td style={{ ...tdStyle, textAlign: "right" }}>
                                        ${tx.price} {"→"} <span style={{ color: T.gold }}>${newPrice}</span>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </ScrollHintTable>
                        )}

                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            padding: "8px 12px",
                            borderTop: `1px solid ${T.borderSoft}`,
                            alignItems: "center",
                          }}
                        >
                          <button
                            onClick={() => onApproveSplit?.(sp)}
                            disabled={anyInFlight}
                            style={{
                              background: anyInFlight ? "rgba(201,169,97,0.4)" : T.gold,
                              border: "none",
                              color: "#0b0d10",
                              padding: "7px 12px",
                              fontFamily: FONT_MONO,
                              fontSize: 10,
                              letterSpacing: "0.15em",
                              textTransform: "uppercase",
                              cursor: anyInFlight ? "not-allowed" : "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                            }}
                          >
                            {isThisInFlight ? (
                              <>
                                <RefreshCw size={10} className="spin" />
                                Applying…
                              </>
                            ) : (
                              "Approve"
                            )}
                          </button>
                          <button
                            onClick={() => onDismissSplit?.(sp)}
                            disabled={anyInFlight}
                            style={{
                              background: "transparent",
                              border: `1px solid ${anyInFlight ? T.borderSoft : T.border}`,
                              color: anyInFlight ? T.textFaint : T.textDim,
                              padding: "7px 12px",
                              fontFamily: FONT_MONO,
                              fontSize: 10,
                              letterSpacing: "0.15em",
                              textTransform: "uppercase",
                              cursor: anyInFlight ? "not-allowed" : "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                            }}
                          >
                            {isThisInFlight ? (
                              <>
                                <RefreshCw size={10} className="spin" />
                                Dismissing…
                              </>
                            ) : (
                              "Dismiss"
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* History section */}
              {splitEvents.length > 0 && (
                <div>
                  <button
                    onClick={() => setSplitHistoryOpen((v) => !v)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      background: "transparent",
                      border: "none",
                      borderTop: `1px solid ${T.borderSoft}`,
                      padding: "10px 0 0",
                      cursor: "pointer",
                      color: T.textDim,
                      fontFamily: FONT_MONO,
                      fontSize: 9,
                      letterSpacing: "0.15em",
                      textTransform: "uppercase",
                    }}
                  >
                    <ChevronDown
                      size={11}
                      style={{
                        transform: splitHistoryOpen ? "none" : "rotate(-90deg)",
                        transition: "transform 0.2s",
                      }}
                    />
                    History ({splitEvents.length})
                  </button>
                  {splitHistoryOpen && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                      {[...splitEvents].reverse().map((ev, i) => {
                        const isApplied = ev.status === "applied";
                        const num = Number(ev.numerator);
                        const den = Number(ev.denominator);
                        const isReverse = den > num;
                        const factorLabel = isReverse ? `${num}:${den} reverse` : `${num}:${den}`;
                        const appliedDate = ev.appliedAt
                          ? new Date(ev.appliedAt).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })
                          : ev.date;
                        return (
                          <div
                            key={i}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              flexWrap: "wrap",
                              padding: "6px 10px",
                              background: T.cardElev,
                              border: `1px solid ${T.borderSoft}`,
                              borderRadius: 4,
                            }}
                          >
                            <span style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600, color: T.text }}>
                              {ev.ticker}
                            </span>
                            <span
                              style={{
                                fontFamily: FONT_MONO,
                                fontSize: 10,
                                color: isReverse ? T.red : T.green,
                                letterSpacing: "0.08em",
                                textTransform: "uppercase",
                              }}
                            >
                              {factorLabel}
                            </span>
                            <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.textFaint }}>
                              {ev.date}
                            </span>
                            <span
                              style={{
                                fontFamily: FONT_MONO,
                                fontSize: 9,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                color: isApplied ? T.green : T.textFaint,
                                background: isApplied ? "rgba(125,211,164,0.1)" : "transparent",
                                border: `1px solid ${isApplied ? T.green + "44" : T.borderSoft}`,
                                padding: "2px 5px",
                                borderRadius: 2,
                              }}
                            >
                              {isApplied ? "Applied" : "Dismissed"}
                            </span>
                            <span
                              style={{
                                marginLeft: "auto",
                                fontFamily: FONT_MONO,
                                fontSize: 9,
                                color: T.textFaint,
                              }}
                            >
                              {appliedDate}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
            </div>
          )}
        </div>
      )}

      {formOpen && !editing && (
        <TransactionForm
          knownTickers={knownTickers}
          onSubmit={handleAdd}
          onCancel={() => setFormOpen(false)}
          busy={saving}
          auth={auth}
        />
      )}

      {editing && (
        <TransactionForm
          initial={editing}
          knownTickers={knownTickers}
          onSubmit={handleUpdate}
          onCancel={() => setEditing(null)}
          busy={saving}
          auth={auth}
        />
      )}

      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: historyOpen ? "4px 4px 0 0" : 4,
            padding: "10px 14px",
            cursor: "pointer",
            color: T.textDim,
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
          }}
        >
          <ChevronDown
            size={12}
            style={{
              transform: historyOpen ? "none" : "rotate(-90deg)",
              transition: "transform 0.2s",
            }}
          />
          Transaction History
          <span
            style={{
              marginLeft: 8,
              background: T.border,
              color: T.textDim,
              fontFamily: FONT_MONO,
              fontSize: 9,
              fontWeight: 700,
              padding: "1px 6px",
              borderRadius: 8,
            }}
          >
            {transactions.length}
          </span>
        </button>
        {historyOpen && (
          <TransactionTable
            transactions={transactions}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onBulkDelete={handleBulkDelete}
            onBulkAssetClass={handleBulkAssetClass}
            busy={saving}
            valuesHidden={valuesHidden}
            tickerStatus={tickerStatus}
            checkingTickers={checkingTickers}
          />
        )}
      </div>

      <BondIncomeAudit
        bondIncome={bondIncome}
        onDelete={(key) => {
          const next = bondIncome.filter(
            (e) => (e.id || `${e.date}|${e.ticker}|${e.amount}`) !== key
          );
          persist(transactions, next);
        }}
        saving={saving}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onConfirm={handleImport}
        existingCount={transactions.length}
        existingTransactions={transactions}
      />

    </div>
  );
}
