// api/split-detect.js
// POST { tickers }
// Returns ALL splits/groupings (no date window) for the requested US tickers,
// for the client to reconcile against the transaction history and surface any
// split that has not yet been applied.
//
// Sources:
//   splits — Yahoo Finance chart?events=split (keyless)
//            Fallback: Polygon.io v3/reference/splits (POLYGON_API_KEY)
//
// Both sources normalize to { date, numerator, denominator } where
// numerator:denominator = new:old. denominator > numerator = reverse split.
//
// Cache: global Redis key splitdetect:v1:{tickersHash}, TTL until next market
// close. Splits are public data — not per-user.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

const CACHE_VERSION = 'v1';
const TIMEOUT_MS = 12000;

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

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

// Fetch all splits for one ticker (Yahoo primary, Polygon fallback).
// Returns an array (possibly empty) or null on total failure.
async function fetchTickerSplits(ticker) {
  let splits = null;
  try { splits = await fetchYahooSplits(ticker); } catch { splits = null; }
  if (splits === null) {
    try { splits = await fetchPolygonSplits(ticker); } catch { splits = null; }
  }
  return splits;
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
  if (!Array.isArray(body.tickers) || !body.tickers.length) {
    return res.status(400).json({ error: 'tickers array required' });
  }

  // Deduplicate and uppercase; trust caller to send only US tickers.
  const tickers = [...new Set(body.tickers.map((t) => String(t).toUpperCase()))].sort();

  // Global cache key (splits are public — not per-user)
  const tickersHash = simpleHash(tickers.join(','));
  const cacheKey = `splitdetect:${CACHE_VERSION}:${tickersHash}`;
  const ttl = secondsUntilNextMarketClose();

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta = { ...parsed.meta, cacheHit: true };
      return res.status(200).json(parsed);
    } catch { /* fall through and recompute */ }
  }

  let tickersFailed = 0;
  const allSplits = [];

  await mapConcurrent(tickers, async (ticker) => {
    try {
      const splits = await fetchTickerSplits(ticker);
      if (splits === null) {
        tickersFailed++;
        return;
      }
      for (const s of splits) {
        if (!s.date || s.numerator == null || s.denominator == null) continue;
        allSplits.push({
          ticker,
          date: s.date,
          numerator: s.numerator,
          denominator: s.denominator,
        });
      }
    } catch {
      tickersFailed++;
    }
  }, 3);

  allSplits.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  const result = {
    splits: allSplits,
    meta: {
      tickersFetched: tickers.length,
      tickersFailed,
      cacheHit: false,
      cacheVersion: CACHE_VERSION,
      splitsSource: process.env.POLYGON_API_KEY ? 'yahoo+polygon' : 'yahoo',
    },
  };

  await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl).catch(() => {});

  return res.status(200).json(result);
}
