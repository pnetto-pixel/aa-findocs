// api/events.js
// POST { tickers }
// Returns calendar events (ex-dividends, earnings, splits, payouts) for the
// requested US tickers within a rolling window of today-30d to today+90d.
//
// Sources:
//   ex_dividend / payout  — Yahoo Finance chart?events=div (keyless)
//                           Fallback: Finnhub /stock/dividend (FINNHUB_API_KEY)
//   pay dates             — Polygon.io v3/reference/dividends (POLYGON_API_KEY)
//                           Reutilizes per-ticker Redis cache from api/dividends.js
//   splits                — Yahoo Finance chart?events=split (keyless)
//                           Fallback: Polygon.io v3/reference/splits (POLYGON_API_KEY)
//   earnings              — Finnhub /calendar/earnings (FINNHUB_API_KEY)
//                           Fallback: Yahoo Finance chart?events=earn (keyless)
//
// Cache: global Redis key events:v1:{tickersHash}, TTL until next market close.
// BRA Stocks (B3 tickers) are excluded at the client side; this endpoint trusts
// the caller to only send US tickers.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

const CACHE_VERSION = 'v1';
const TIMEOUT_MS = 12000;
const EX_DATE_MATCH_TOLERANCE_DAYS = 5;
const PAYDATE_CACHE_VERSION = 'v1';
const PAYDATE_CACHE_TTL_SECONDS = 7 * 24 * 3600;
const MAX_FRESH_PAYDATE_FETCHES = 5;

function simpleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(36);
}

function secondsUntilNextMarketClose() {
  const now = Date.now();
  const MS_PER_DAY = 86400000;
  const todayMidnight = now - (now % MS_PER_DAY);
  const todayClose = todayMidnight + 21 * 3600000; // ~21:00 UTC = 4 PM ET
  const next = now < todayClose ? todayClose : todayClose + MS_PER_DAY;
  return Math.max(1800, Math.round((next - now) / 1000));
}

async function fetchWithTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function mapConcurrent(items, fn, concurrency = 3) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const MS_PER_DAY = 86400000;

function daysBetween(isoA, isoB) {
  return Math.abs(
    (new Date(isoA + 'T00:00:00Z').getTime() - new Date(isoB + 'T00:00:00Z').getTime()) / MS_PER_DAY
  );
}

// ── Yahoo Finance helpers ──────────────────────────────────────────────────────

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Fetch dividends from Yahoo for a ticker. Returns [{date, amount}] or null.
async function fetchYahooDividends(ticker) {
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=10y&interval=1d&events=div`;
  try {
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': YAHOO_UA } });
    if (!r.ok) return null;
    const data = await r.json();
    const divs = data?.chart?.result?.[0]?.events?.dividends || {};
    const entries = Object.values(divs);
    if (!entries.length) return [];
    return entries
      .map((d) => ({
        date: new Date(d.date * 1000).toISOString().slice(0, 10),
        amount: d.amount,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

// Fetch splits from Yahoo. Returns [{date, numerator, denominator}] or null.
// Yahoo's splits format: { date: unix_ts, numerator, denominator, splitRatio }
// denominator > numerator = reverse split (grouping).
async function fetchYahooSplits(ticker) {
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=10y&interval=1d&events=split`;
  try {
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': YAHOO_UA } });
    if (!r.ok) return null;
    const data = await r.json();
    const splits = data?.chart?.result?.[0]?.events?.splits || {};
    const entries = Object.values(splits);
    if (!entries.length) return [];
    return entries
      .map((s) => ({
        date: new Date(s.date * 1000).toISOString().slice(0, 10),
        numerator: s.numerator,
        denominator: s.denominator,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

// Fetch earnings from Yahoo. Returns [{date, epsEstimate, epsActual}] or null.
// Yahoo events=earn returns an `earnings` object keyed by timestamp.
async function fetchYahooEarnings(ticker) {
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=2y&interval=1d&events=earn`;
  try {
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': YAHOO_UA } });
    if (!r.ok) return null;
    const data = await r.json();
    const earns = data?.chart?.result?.[0]?.events?.earnings || {};
    const entries = Object.values(earns);
    if (!entries.length) return [];
    return entries
      .map((e) => ({
        date: new Date(e.date * 1000).toISOString().slice(0, 10),
        epsEstimate: e.epsestimate ?? null,
        epsActual: e.epsactual ?? null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

// ── Finnhub helpers ────────────────────────────────────────────────────────────

// Fetch dividends from Finnhub (fallback for ADRs where Yahoo returns empty).
// Returns [{date, amount, payDate}] or null.
async function fetchFinnhubDividends(ticker, apiKey) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 10 * 365 * MS_PER_DAY).toISOString().slice(0, 10);
  const url =
    `https://finnhub.io/api/v1/stock/dividend` +
    `?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data
      .filter((d) => d.date && d.amount != null)
      .map((d) => ({
        date: d.date,
        amount: d.amount,
        payDate: d.payDate || null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

// Fetch earnings calendar from Finnhub.
// Returns [{date, epsEstimate, epsActual}] or null.
async function fetchFinnhubEarnings(ticker, apiKey) {
  const to = new Date(Date.now() + 90 * MS_PER_DAY).toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * MS_PER_DAY).toISOString().slice(0, 10);
  const url =
    `https://finnhub.io/api/v1/calendar/earnings` +
    `?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json();
    const arr = data?.earningsCalendar;
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr
      .filter((e) => e.date)
      .map((e) => ({
        date: e.date,
        epsEstimate: e.epsEstimate ?? null,
        epsActual: e.epsActual ?? null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

// ── Polygon helpers ────────────────────────────────────────────────────────────

// Pay-date cache key — same as api/dividends.js so both endpoints share the warm cache.
function payDateCacheKey(ticker) {
  return `dividends:paydates:${PAYDATE_CACHE_VERSION}:${ticker.toUpperCase()}`;
}

async function fetchPolygonPayDates(ticker) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;
  const url =
    `https://api.polygon.io/v3/reference/dividends` +
    `?ticker=${encodeURIComponent(ticker.toUpperCase())}&limit=1000&apiKey=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json();
    const results = data?.results;
    if (!Array.isArray(results)) return null;
    return results
      .map((row) => ({ exDate: row.ex_dividend_date, payDate: row.pay_date }))
      .filter((x) => x.exDate && x.payDate);
  } catch {
    return null;
  }
}

// Fetch splits from Polygon. Returns [{date, numerator, denominator}] or null.
async function fetchPolygonSplits(ticker) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;
  const url =
    `https://api.polygon.io/v3/reference/splits` +
    `?ticker=${encodeURIComponent(ticker.toUpperCase())}&limit=1000&apiKey=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json();
    const results = data?.results;
    if (!Array.isArray(results)) return null;
    return results
      .filter((s) => s.execution_date && s.split_from != null && s.split_to != null)
      .map((s) => ({
        date: s.execution_date,
        // Polygon: split_to = new shares, split_from = old shares
        // Yahoo: numerator = new, denominator = old
        // Unify to numerator/denominator = new:old
        numerator: s.split_to,
        denominator: s.split_from,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

function payDateForExDate(rows, exDate) {
  if (!Array.isArray(rows)) return null;
  let best = null;
  let bestGap = Infinity;
  for (const row of rows) {
    const gap = daysBetween(row.exDate, exDate);
    if (gap < bestGap) {
      bestGap = gap;
      best = row;
    }
  }
  if (best && bestGap <= EX_DATE_MATCH_TOLERANCE_DAYS) return best.payDate;
  return null;
}

// Load Polygon pay dates for tickers from Redis cache, warming cold tickers.
// Reuses the same cache keys as api/dividends.js.
async function loadPayDateRows(redis, tickers) {
  const rowsByTicker = new Map();
  const cached = await Promise.all(
    tickers.map((t) => redis.get(payDateCacheKey(t)).catch(() => null))
  );
  const cold = [];
  tickers.forEach((t, i) => {
    if (cached[i] != null) {
      try {
        rowsByTicker.set(t, JSON.parse(cached[i]));
        return;
      } catch {
        /* fall through to cold */
      }
    }
    rowsByTicker.set(t, null);
    cold.push(t);
  });

  const toFetch = cold.slice(0, MAX_FRESH_PAYDATE_FETCHES);
  await Promise.all(
    toFetch.map(async (t) => {
      const rows = await fetchPolygonPayDates(t);
      if (rows != null) {
        rowsByTicker.set(t, rows);
        await redis
          .set(payDateCacheKey(t), JSON.stringify(rows), 'EX', PAYDATE_CACHE_TTL_SECONDS)
          .catch(() => {});
      }
    })
  );

  return rowsByTicker;
}

// ── Date window helpers ────────────────────────────────────────────────────────

function dateWindow() {
  const todayISO = new Date().toISOString().slice(0, 10);
  const startISO = new Date(Date.now() - 30 * MS_PER_DAY).toISOString().slice(0, 10);
  const endISO = new Date(Date.now() + 90 * MS_PER_DAY).toISOString().slice(0, 10);
  return { todayISO, startISO, endISO };
}

// ── Per-ticker event builder ───────────────────────────────────────────────────

// Builds events for one ticker. Returns an array of event objects or [] on total failure.
async function buildTickerEvents(ticker, redis, rowsByTicker, finnhubKey, window) {
  const { startISO, endISO } = window;
  const events = [];

  // ── 1) Dividends (ex_dividend) + payouts ─────────────────────────────────────
  let divs = null;
  try { divs = await fetchYahooDividends(ticker); } catch { divs = null; }
  if (finnhubKey && (divs === null || divs.length === 0)) {
    try { divs = await fetchFinnhubDividends(ticker, finnhubKey); } catch { divs = null; }
  }

  if (Array.isArray(divs)) {
    const payRows = rowsByTicker ? rowsByTicker.get(ticker) : null;
    for (const { date: exDate, amount, payDate: divPayDate } of divs) {
      if (!exDate) continue;
      // Resolve pay date
      const payDate = divPayDate || payDateForExDate(payRows, exDate);

      // Ex-dividend event
      if (exDate >= startISO && exDate <= endISO) {
        events.push({
          date: exDate,
          ticker,
          type: 'ex_dividend',
          amount,
          payDate: payDate || null,
        });
      }

      // Payout event (cash landing date — only if pay date is known and in window)
      if (payDate && payDate !== exDate && payDate >= startISO && payDate <= endISO) {
        events.push({
          date: payDate,
          ticker,
          type: 'payout',
          amount,
          payDate,
        });
      }
    }
  }

  // ── 2) Splits ────────────────────────────────────────────────────────────────
  let splits = null;
  try { splits = await fetchYahooSplits(ticker); } catch { splits = null; }
  if (splits === null) {
    try { splits = await fetchPolygonSplits(ticker); } catch { splits = null; }
  }

  if (Array.isArray(splits)) {
    for (const s of splits) {
      if (!s.date || s.date < startISO || s.date > endISO) continue;
      const num = s.numerator;
      const den = s.denominator;
      // Build ratio string: for splits num > den (e.g. "10:1"), for reverse den > num (e.g. "1:10")
      const splitRatio = num != null && den != null ? `${num}:${den}` : null;
      events.push({
        date: s.date,
        ticker,
        type: 'split',
        splitRatio,
        splitNumerator: num ?? null,
        splitDenominator: den ?? null,
      });
    }
  }

  // ── 3) Earnings ──────────────────────────────────────────────────────────────
  let earnings = null;
  if (finnhubKey) {
    try { earnings = await fetchFinnhubEarnings(ticker, finnhubKey); } catch { earnings = null; }
  }
  if (earnings === null) {
    try { earnings = await fetchYahooEarnings(ticker); } catch { earnings = null; }
  }

  if (Array.isArray(earnings)) {
    for (const e of earnings) {
      if (!e.date || e.date < startISO || e.date > endISO) continue;
      events.push({
        date: e.date,
        ticker,
        type: 'earnings',
        epsEstimate: e.epsEstimate ?? null,
        epsActual: e.epsActual ?? null,
      });
    }
  }

  return events;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    return res.status(503).json({ error: `Storage unavailable: ${err.message}` });
  }

  const body = req.body || {};
  if (!Array.isArray(body.tickers) || !body.tickers.length) {
    return res.status(400).json({ error: 'tickers array required' });
  }

  // Deduplicate and uppercase; trust caller to send only US tickers.
  const tickers = [...new Set(body.tickers.map((t) => String(t).toUpperCase()))].sort();

  // Global cache key (events are public — not per-user)
  const tickersHash = simpleHash(tickers.join(','));
  const cacheKey = `events:${CACHE_VERSION}:${tickersHash}`;
  const ttl = secondsUntilNextMarketClose();

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta = { ...parsed.meta, cacheHit: true };
      return res.status(200).json(parsed);
    } catch { /* fall through and recompute */ }
  }

  const window = dateWindow();
  const finnhubKey = process.env.FINNHUB_API_KEY || null;

  // Pre-warm Polygon pay-date cache for all tickers
  const rowsByTicker = await loadPayDateRows(redis, tickers).catch(() => new Map());

  let tickersFailed = 0;
  const allEvents = [];

  await mapConcurrent(tickers, async (ticker) => {
    try {
      const events = await buildTickerEvents(ticker, redis, rowsByTicker, finnhubKey, window);
      allEvents.push(...events);
    } catch {
      tickersFailed++;
    }
  }, 3);

  // Filter to window and sort by date asc
  const { startISO, endISO } = window;
  const filtered = allEvents
    .filter((e) => e.date >= startISO && e.date <= endISO)
    .sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  const result = {
    events: filtered,
    meta: {
      tickersFetched: tickers.length,
      tickersFailed,
      cacheHit: false,
      cacheVersion: CACHE_VERSION,
      earningsSource: finnhubKey ? 'finnhub+yahoo' : 'yahoo',
      splitsSource: process.env.POLYGON_API_KEY ? 'yahoo+polygon' : 'yahoo',
    },
  };

  await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl).catch(() => {});

  return res.status(200).json(result);
}
