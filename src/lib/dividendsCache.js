// src/lib/dividendsCache.js
// Shared client-side cache for POST /api/dividends responses, used by the
// Dividends, Performance, and Contributions (AporteQuinzenal) tabs, plus
// App.jsx's warm-up prefetch. Before this module each of those four call
// sites kept its own cache (or none at all — AporteQuinzenal had zero
// caching, re-posting the full payload on every Contributions tab mount),
// and the two that did cache hashed differently-shaped payloads
// (`{ txs, bi, day }` vs `{ txs, bondIncome, day }`), so identical data
// produced different keys and nothing was ever actually shared.
//
// Two-layer cache:
//   - in-memory Map (module scope): survives tab switches within a session,
//     dies on reload.
//   - localStorage (`divCache:v1:<hash>`): survives a full page reload.
// Every localStorage read/write is wrapped in try/catch — same tolerant
// pattern already used for `usdBrlRate` (App.jsx) — private browsing /
// quota-exceeded must never break the tab.

function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

// Local (not UTC) "today" as YYYY-MM-DD. Same helper duplicated in
// App.jsx/Dividends.jsx/Performance.jsx/AporteQuinzenal.jsx/Events.jsx — kept
// here too only as a default for callers that omit `todayISO`; every real
// call site passes its own so the hash always reflects the caller's local day.
function localTodayISO(d = new Date()) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

const LS_PREFIX = "divCache:v1:";

// FNV-1a — same algorithm the old per-file caches used, just now fed a
// normalized payload so identical data always hashes identically regardless
// of which screen computed it.
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// Normalized payload shape shared by every call site. Field names MUST match
// exactly (`transactions`, `bondIncome`, `day`) or the same data produces a
// different hash per screen and the cache silently stops being shared.
export function divCacheHash({ transactions, bondIncome, day }) {
  return fnv1a(JSON.stringify({ transactions, bondIncome, day }));
}

// In-memory layer.
const memCache = new Map();

let pruned = false;
// One-time-per-session sweep of localStorage entries left over from a
// previous day (the hash already changes day to day, so stale entries are
// simply dead weight, never wrongly hit) — keeps storage from growing
// unbounded across reloads. Cheap, lazy: runs once, on the first write.
function pruneStaleEntries(today) {
  if (pruned) return;
  pruned = true;
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX)) continue;
      let stale = true;
      try {
        const raw = localStorage.getItem(k);
        const parsed = raw ? JSON.parse(raw) : null;
        stale = !parsed || parsed.cachedAt !== today;
      } catch {
        stale = true;
      }
      if (stale) toRemove.push(k);
    }
    toRemove.forEach((k) => {
      try { localStorage.removeItem(k); } catch {}
    });
  } catch {}
}

// Reads memory first, then localStorage (backfilling memory on a
// localStorage hit so subsequent reads in the same session skip JSON.parse).
// Returns the cached /api/dividends response, or null if nothing is cached.
export function getDivCacheEntry(hash) {
  if (memCache.has(hash)) return memCache.get(hash);
  try {
    const raw = localStorage.getItem(LS_PREFIX + hash);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data) {
        memCache.set(hash, parsed.data);
        return parsed.data;
      }
    }
  } catch {}
  return null;
}

// Writes both layers. `day` is only used to decide which stale localStorage
// entries to prune — it is NOT part of the cache key (the hash already
// encodes it via the normalized payload).
export function setDivCacheEntry(hash, data, day = localTodayISO()) {
  memCache.set(hash, data);
  try {
    pruneStaleEntries(day);
    localStorage.setItem(LS_PREFIX + hash, JSON.stringify({ data, cachedAt: day }));
  } catch {}
}

// Single entry point every call site (Dividends.jsx, Performance.jsx,
// AporteQuinzenal.jsx, App.jsx's warm-up) should use instead of hand-rolling
// a fetch + cache. Usage:
//
//   const { cached, fresh } = fetchDividendsCached({ auth, transactions, bondIncome, todayISO });
//   if (cached) applyImmediately(cached);       // optimistic render, may be stale
//   fresh.then(applySilently).catch((err) => {  // always fires in the background
//     if (err.code === 401) onAuthFail?.();
//   });
//
// `fresh` always issues the POST — even when `cached` is non-null — so a
// server-side change (e.g. a pay date that just resolved) still reaches the
// UI eventually. The caller decides how to reconcile cached vs fresh (every
// current call site just overwrites state silently, since the values rarely
// differ).
export function fetchDividendsCached({ auth, transactions, bondIncome, todayISO }) {
  const day = todayISO || localTodayISO();
  const hash = divCacheHash({ transactions, bondIncome, day });
  const cached = getDivCacheEntry(hash);
  const fresh = (async () => {
    const res = await fetch("/api/dividends", {
      method: "POST",
      headers: { ...authHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify({ transactions, bondIncome, todayISO: day }),
    });
    if (res.status === 401) {
      const err = new Error("Unauthorized");
      err.code = 401;
      throw err;
    }
    if (!res.ok) throw new Error(`Dividends: ${res.status}`);
    const data = await res.json();
    setDivCacheEntry(hash, data, day);
    return data;
  })();
  return { cached, fresh };
}
