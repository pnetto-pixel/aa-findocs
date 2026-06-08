// api/dividends.js
// POST { transactions }
// Fetches US dividend history from Yahoo Finance (keyless, same host as perf-history.js).
// Yahoo provides the EX-DIVIDEND date and per-share amount — that is the correct
// date for share-entitlement (you must hold before the ex-date to earn the dividend).
// But the cash actually lands on the PAY date, which Yahoo does NOT provide. We enrich
// each event with the pay date from Nasdaq (api.nasdaq.com), matched by ex-date, and
// store it as the event `date` so monthly buckets line up with brokerage statements.
// Qty is always computed at the ex-date; if Nasdaq is unavailable/lacks a row, the
// event gracefully falls back to using the ex-date as `date` (previous behaviour).
// BRA Stocks and fixed income are covered by income-manual.js (no free API).
// Cache: Redis, versioned, TTL until next US market close.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

// v2: events now bucket by PAY date (Nasdaq) instead of ex-date; added exDate/payDate fields.
const CACHE_VERSION = 'v2';
const TIMEOUT_MS = 12000;
// Max day gap when matching a Yahoo ex-date to a Nasdaq row's ex-date (sources can differ ±1d).
const EX_DATE_MATCH_TOLERANCE_DAYS = 5;

// Asset classes where we auto-fetch dividends via Yahoo (US tickers only).
const AUTO_CLASSES = new Set(['Stocks', 'Real Estate', 'Alternative', 'Bonds']);

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

// Parse Nasdaq's MM/DD/YYYY into YYYY-MM-DD, or null if not a real date ("N/A", "").
function parseUsDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

const MS_PER_DAY = 86400000;
function daysBetween(isoA, isoB) {
  return Math.abs(
    (new Date(isoA + 'T00:00:00Z').getTime() - new Date(isoB + 'T00:00:00Z').getTime()) / MS_PER_DAY
  );
}

// Fetch pay dates from Nasdaq. Returns [{exDate, payDate}] (both YYYY-MM-DD), or null on
// failure. The right assetclass (stocks vs etf) is unknown for a given ticker, so we try
// stocks first and fall back to etf. Rows without a usable pay date are dropped.
async function fetchNasdaqPayDates(ticker) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
  };
  for (const assetclass of ['stocks', 'etf']) {
    const url =
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/dividends` +
      `?assetclass=${assetclass}&limit=9999`;
    try {
      const r = await fetchWithTimeout(url, { headers });
      if (!r.ok) continue;
      const data = await r.json();
      const rows = data?.data?.dividends?.rows;
      if (!Array.isArray(rows) || !rows.length) continue;
      const parsed = rows
        .map((row) => ({
          exDate: parseUsDate(row.exOrEffDate),
          payDate: parseUsDate(row.paymentDate),
        }))
        .filter((x) => x.exDate && x.payDate);
      if (parsed.length) return parsed;
    } catch {
      // try next assetclass / give up
    }
  }
  return null;
}

// Given a ticker's Nasdaq rows, return the pay date whose ex-date best matches the
// supplied ex-date (within tolerance), or null if none is close enough.
function payDateForExDate(nasdaqRows, exDate) {
  if (!Array.isArray(nasdaqRows)) return null;
  let best = null;
  let bestGap = Infinity;
  for (const row of nasdaqRows) {
    const gap = daysBetween(row.exDate, exDate);
    if (gap < bestGap) {
      bestGap = gap;
      best = row;
    }
  }
  if (best && bestGap <= EX_DATE_MATCH_TOLERANCE_DAYS) return best.payDate;
  return null;
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

  // Only US tickers in eligible classes
  const relevant = transactions.filter(
    (tx) =>
      tx.ticker && tx.date && tx.qty != null && tx.side &&
      AUTO_CLASSES.has(tx.assetClass) &&
      !isBrazilianTicker(tx.ticker)
  );

  const txHashInput = relevant
    .map((tx) => `${tx.id}|${tx.date}|${tx.side}|${tx.ticker}|${tx.qty}`)
    .join(';');
  const txsHash = simpleHash(txHashInput);
  const key = cacheKey(auth, txsHash);

  if (key) {
    const cached = await redis.get(key).catch(() => null);
    if (cached) return res.status(200).json(JSON.parse(cached));
  }

  const tickers = [...new Set(relevant.map((tx) => tx.ticker))];

  if (!tickers.length) {
    return res.status(200).json({ events: [], meta: { tickers: 0, eventsFound: 0 } });
  }

  // Yahoo gives ex-dates + amounts; Nasdaq gives pay dates. Fetch both per ticker.
  const fetchResults = await mapConcurrent(
    tickers,
    async (ticker) => {
      const [divs, nasdaqRows] = await Promise.all([
        fetchYahooDividends(ticker),
        fetchNasdaqPayDates(ticker),
      ]);
      return { ticker, divs, nasdaqRows };
    },
    3
  );

  const events = [];
  let payDatesMatched = 0;
  let payDatesMissing = 0;
  for (const { ticker, divs, nasdaqRows } of fetchResults) {
    if (!Array.isArray(divs)) continue;
    const assetClass = relevant.find((tx) => tx.ticker === ticker)?.assetClass || 'Stocks';
    for (const { date: exDate, amount } of divs) {
      // Entitlement is fixed at the ex-date — that is the qty that earned this dividend.
      const qty = qtyAtDate(transactions, ticker, exDate);
      if (qty <= 0) continue;
      const payDate = payDateForExDate(nasdaqRows, exDate);
      if (payDate) payDatesMatched++;
      else payDatesMissing++;
      // Bucket by pay date (when cash lands) when known; otherwise fall back to ex-date.
      const date = payDate || exDate;
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
      eventsFound: events.length,
      payDatesMatched,
      payDatesMissing,
    },
  };

  if (key) {
    await redis.set(key, JSON.stringify(result), 'EX', secondsUntilNextMarketClose()).catch(() => {});
  }

  return res.status(200).json(result);
}
