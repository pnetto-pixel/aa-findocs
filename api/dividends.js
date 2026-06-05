// api/dividends.js
// POST { transactions }
// Fetches US dividend history from Yahoo Finance (keyless, same host as perf-history.js)
// and computes dividends received based on qty held at each ex-date.
// BRA Stocks and fixed income are covered by income-manual.js (no free API).
// Cache: Redis, versioned, TTL until next US market close.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

const CACHE_VERSION = 'v1';
const TIMEOUT_MS = 12000;

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

  const fetchResults = await mapConcurrent(
    tickers,
    async (ticker) => ({ ticker, divs: await fetchYahooDividends(ticker) }),
    3
  );

  const events = [];
  for (const { ticker, divs } of fetchResults) {
    if (!Array.isArray(divs)) continue;
    const assetClass = relevant.find((tx) => tx.ticker === ticker)?.assetClass || 'Stocks';
    for (const { date, amount } of divs) {
      const qty = qtyAtDate(transactions, ticker, date);
      if (qty <= 0) continue;
      events.push({
        date,
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

  const result = { events, meta: { tickers: tickers.length, eventsFound: events.length } };

  if (key) {
    await redis.set(key, JSON.stringify(result), 'EX', secondsUntilNextMarketClose()).catch(() => {});
  }

  return res.status(200).json(result);
}
