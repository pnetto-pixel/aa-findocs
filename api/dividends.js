// api/dividends.js
// POST { transactions }
// Fetches US dividend history from Yahoo Finance (primary, keyless) with Finnhub as
// fallback for tickers Yahoo returns null/empty for (e.g. ADRs like VALE).
// Yahoo provides the EX-DIVIDEND date and per-share amount — that is the correct
// date for share-entitlement (you must hold before the ex-date to earn the dividend).
// But the cash actually lands on the PAY date, which Yahoo does NOT provide. We enrich
// each event with the pay date from Polygon.io (v3/reference/dividends), matched by
// ex-date, and store it as the event `date` so monthly buckets line up with brokerage
// statements. Finnhub (/stock/dividend) already includes payDate so Polygon is skipped
// for Finnhub-sourced events. (Nasdaq's api was tried first but Akamai blocks Vercel's
// datacenter IPs with a 403; Polygon is a server-friendly keyed API that works from cloud.)
//
// Polygon free tier is 5 req/min, so pay dates are cached PER TICKER in Redis (dividend
// dates are immutable historical facts) and only a few cold tickers are fetched per
// request — over a couple of loads every ticker warms up and the rate limit never bites.
// Qty is always computed at the ex-date; if Polygon is unavailable/lacks a row (or no
// POLYGON_API_KEY is set), the event gracefully falls back to the ex-date as `date`.
// BRA Stocks is included in AUTO_CLASSES so US-listed tickers (e.g. VALE, a NYSE ADR)
// that are tagged "BRA Stocks" are still fetched — isBrazilianTicker gates out B3 tickers.
// Cache: Redis, versioned, TTL until next US market close.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

// v6: Fidelity-imported dividend events (bondIncome kind=dividend) bypass Yahoo/Finnhub entirely.
// v5: Finnhub fallback for Yahoo-empty tickers (e.g. VALE ADR); stale empty results busted.
// v4: future-pay-date dividends now excluded (was: included as received income).
// v3: pay dates now sourced from Polygon (was Nasdaq in v2, ex-date in v1).
const CACHE_VERSION = 'v6';
const TIMEOUT_MS = 12000;
// Max day gap when matching a Yahoo ex-date to a Polygon row's ex-date (sources can differ ±1d).
const EX_DATE_MATCH_TOLERANCE_DAYS = 5;
// Per-ticker pay-date cache (immutable facts) — refetched weekly to pick up new dividends.
const PAYDATE_CACHE_VERSION = 'v1';
const PAYDATE_CACHE_TTL_SECONDS = 7 * 24 * 3600;
// Polygon free tier ≈ 5 req/min. Warm at most this many cold tickers per request (burst).
const MAX_FRESH_PAYDATE_FETCHES = 5;

// Asset classes where we auto-fetch dividends via Yahoo (US tickers only).
// BRA Stocks is also included here so that US-listed tickers (e.g. VALE) that the
// user classifies under "BRA Stocks" still get dividend data — the isBrazilianTicker
// guard below keeps actual B3 tickers (e.g. VALE3) out of the fetch.
const AUTO_CLASSES = new Set(['Stocks', 'Real Estate', 'Alternative', 'Bonds', 'BRA Stocks']);

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
}

function simpleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(auth, txsHash) {
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, `:dividends:${CACHE_VERSION}:${txsHash}`);
}

// Per-ticker pay-date cache key is global (not per-user) — dividend dates are public facts.
function payDateCacheKey(ticker) {
  return `dividends:paydates:${PAYDATE_CACHE_VERSION}:${ticker.toUpperCase()}`;
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

// Returns [{date:"YYYY-MM-DD", amount}] sorted asc, or null on network failure.
async function fetchYahooDividends(ticker) {
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=10y&interval=1d&events=div`;
  try {
    const r = await fetchWithTimeout(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
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

// Fallback for tickers Yahoo returns null/empty on (e.g. ADRs).
// Returns [{date:"YYYY-MM-DD", amount, payDate:"YYYY-MM-DD"|null}] or null on failure.
async function fetchFinnhubDividends(ticker, apiKey) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 10 * 365 * 86400000).toISOString().slice(0, 10);
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
        date: d.date,                     // ex-date, already YYYY-MM-DD
        amount: d.amount,
        payDate: d.payDate || null,       // Finnhub includes pay date directly
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

const MS_PER_DAY = 86400000;
function daysBetween(isoA, isoB) {
  return Math.abs(
    (new Date(isoA + 'T00:00:00Z').getTime() - new Date(isoB + 'T00:00:00Z').getTime()) / MS_PER_DAY
  );
}

// Fetch pay dates from Polygon. Returns [{exDate, payDate}] (both already YYYY-MM-DD), or
// null on failure (network / 429 / no key). Rows without both dates are dropped. An empty
// array (ticker has no covered dividends) is a valid "warm" result, distinct from null.
async function fetchPolygonPayDates(ticker) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;
  const url =
    `https://api.polygon.io/v3/reference/dividends` +
    `?ticker=${encodeURIComponent(ticker.toUpperCase())}&limit=1000&apiKey=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null; // 429 (rate limit) or other → retry on a later request
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

// Given a ticker's pay-date rows, return the pay date whose ex-date best matches the
// supplied ex-date (within tolerance), or null if none is close enough.
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

// Resolve pay-date rows per ticker using a per-ticker Redis cache, warming at most
// MAX_FRESH_PAYDATE_FETCHES cold tickers per request (so Polygon's 5/min never bites).
// Returns { rowsByTicker: Map<ticker, rows[]|null>, allWarm, warmed }.
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
  let warmed = 0;
  await Promise.all(
    toFetch.map(async (t) => {
      const rows = await fetchPolygonPayDates(t);
      if (rows != null) {
        rowsByTicker.set(t, rows);
        warmed++;
        await redis
          .set(payDateCacheKey(t), JSON.stringify(rows), 'EX', PAYDATE_CACHE_TTL_SECONDS)
          .catch(() => {});
      }
    })
  );

  const allWarm = tickers.every((t) => rowsByTicker.get(t) != null);
  return { rowsByTicker, allWarm, warmed };
}

// Qty of ticker held at close of date, derived from transaction log.
function qtyAtDate(transactions, ticker, date) {
  let qty = 0;
  for (const tx of transactions) {
    if (tx.ticker !== ticker || tx.date > date) continue;
    if (tx.side === 'buy') qty += (tx.qty || 0);
    else if (tx.side === 'sell') qty -= (tx.qty || 0);
  }
  return Math.max(0, qty);
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
  if (!Array.isArray(body.transactions)) {
    return res.status(400).json({ error: 'transactions array required' });
  }

  const transactions = body.transactions;

  // Fidelity-imported stock dividend events: exact amounts, no API fetch needed.
  // These come from bondIncome entries with kind="dividend" (same store as bond interest).
  const fidelityDivEvents = Array.isArray(body.bondIncome)
    ? body.bondIncome.filter((e) => e.kind === 'dividend' && e.ticker && e.date && e.amount > 0)
    : [];
  const fidelityTickers = new Set(fidelityDivEvents.map((e) => e.ticker));

  // Only US tickers in eligible classes
  const relevant = transactions.filter(
    (tx) =>
      tx.ticker && tx.date && tx.qty != null && tx.side &&
      AUTO_CLASSES.has(tx.assetClass) &&
      !isBrazilianTicker(tx.ticker)
  );

  // Include a hash of Fidelity dividend events in the cache key so that importing
  // new dividends from Fidelity immediately invalidates any stale cached response.
  const fdHash = fidelityDivEvents.length > 0
    ? simpleHash(fidelityDivEvents.map((e) => `${e.date}|${e.ticker}|${e.amount}`).join(';'))
    : '';
  const txHashInput = relevant
    .map((tx) => `${tx.id}|${tx.date}|${tx.side}|${tx.ticker}|${tx.qty}`)
    .join(';') + (fdHash ? `:fd:${fdHash}` : '');
  const txsHash = simpleHash(txHashInput);
  const key = cacheKey(auth, txsHash);

  if (key) {
    const cached = await redis.get(key).catch(() => null);
    if (cached) return res.status(200).json(JSON.parse(cached));
  }

  // Skip Yahoo/Finnhub for tickers already covered by Fidelity import (use exact data).
  const tickers = [...new Set(relevant.map((tx) => tx.ticker))].filter(
    (t) => !fidelityTickers.has(t)
  );

  if (!tickers.length && !fidelityDivEvents.length) {
    return res.status(200).json({ events: [], meta: { tickers: 0, eventsFound: 0 } });
  }

  // Yahoo (primary, keyless) → ex-dates + amounts.
  // Finnhub (fallback, keyed) → used when Yahoo returns null or empty (common for ADRs).
  // Polygon (keyed, per-ticker cached) → pay dates for Yahoo-sourced events.
  // When tickers is empty (all covered by Fidelity), skip external API calls entirely.
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const [divsByTicker, payInfo] = await Promise.all([
    tickers.length
      ? mapConcurrent(tickers, async (ticker) => {
          let divs = await fetchYahooDividends(ticker);
          if (finnhubKey && (divs === null || divs.length === 0)) {
            divs = await fetchFinnhubDividends(ticker, finnhubKey);
          }
          return { ticker, divs };
        }, 3)
      : Promise.resolve([]),
    loadPayDateRows(redis, tickers),
  ]);
  const { rowsByTicker, allWarm } = payInfo;

  const events = [];
  let payDatesMatched = 0;
  let payDatesMissing = 0;
  let futureSkipped = 0;
  const todayISO = new Date().toISOString().slice(0, 10);

  // Convert Fidelity-imported dividend events directly — exact amounts, no API reconstruction.
  for (const fe of fidelityDivEvents) {
    if (fe.date > todayISO) { futureSkipped++; continue; }
    const assetClass = relevant.find((tx) => tx.ticker === fe.ticker)?.assetClass || 'Stocks';
    events.push({
      date: fe.date,
      exDate: fe.date,
      payDate: fe.date,
      ticker: fe.ticker,
      assetClass,
      incomeType: 'dividend',
      amountPerShare: null,
      qtyHeld: null,
      totalReceived: Math.round(fe.amount * 100) / 100,
      currency: 'USD',
      source: 'fidelity',
    });
    payDatesMatched++;
  }

  // Cash that hasn't landed yet isn't received income. Yahoo lists recently-declared
  // dividends whose ex-date has already passed (so qtyAtDate > 0 and we'd build an event)
  // but whose pay date is still in the future — those must not show in history/KPIs.
  for (const { ticker, divs } of divsByTicker) {
    if (!Array.isArray(divs)) continue;
    const assetClass = relevant.find((tx) => tx.ticker === ticker)?.assetClass || 'Stocks';
    const payRows = rowsByTicker.get(ticker); // rows[] | null (not warmed yet)
    for (const { date: exDate, amount, payDate: divPayDate } of divs) {
      // Entitlement is fixed at the ex-date — that is the qty that earned this dividend.
      const qty = qtyAtDate(transactions, ticker, exDate);
      if (qty <= 0) continue;
      // Finnhub supplies payDate directly; Yahoo-sourced events fall back to Polygon lookup.
      const payDate = divPayDate || payDateForExDate(payRows, exDate);
      if (payDate) payDatesMatched++;
      else payDatesMissing++;
      // Bucket by pay date (when cash lands) when known; otherwise fall back to ex-date.
      const date = payDate || exDate;
      // Skip dividends not yet paid (future pay date, or future ex-date in the fallback).
      if (date > todayISO) {
        futureSkipped++;
        continue;
      }
      events.push({
        date,
        exDate,
        payDate: payDate || null,
        ticker,
        assetClass,
        incomeType: 'dividend',
        amountPerShare: amount,
        qtyHeld: qty,
        totalReceived: Math.round(amount * qty * 100) / 100,
        currency: 'USD',
        source: 'api',
      });
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  const result = {
    events,
    meta: {
      tickers: tickers.length,
      fidelityTickers: fidelityTickers.size,
      eventsFound: events.length,
      payDatesMatched,
      payDatesMissing,
      futureSkipped,
      payDatesWarm: allWarm,
      payDatesSource: process.env.POLYGON_API_KEY ? 'polygon' : 'none',
    },
  };

  // Only persist the (expensive) result cache once every ticker's pay dates are warmed —
  // otherwise keep recomputing so the next request can warm a few more cold tickers.
  if (key && allWarm) {
    await redis.set(key, JSON.stringify(result), 'EX', secondsUntilNextMarketClose()).catch(() => {});
  }

  return res.status(200).json(result);
}
