// api/perf-history.js
// POST { transactions }: { dates, portfolio, spy, meta }
// Calculates daily portfolio vs SPY performance, normalized to % return.
// Includes only: Stocks, BRA Stocks, Alternative, Real Estate.
// US tickers + SPY: Yahoo Finance chart API (free).
// B3 tickers: brapi.dev daily candles.
// USD/BRL historical FX: Frankfurter date-range series (free tier).
// Result cached in Redis 24h per user.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

const INCLUDED_CLASSES = new Set([
  'Stocks',
  'BRA Stocks',
  'Alternative',
  'Real Estate',
]);

const YAHOO_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
}

function perfKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  // v2: switched US source from Finnhub (premium-only candles) to Yahoo.
  return auth.storageKey.replace(/:holdings$/, ':perf-history:v2');
}

function toDateStr(unixSec) {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithRetry(url, options = {}, maxAttempts = 3) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleep(500 * Math.pow(2, i - 1));
    try {
      const r = await fetch(url, options);
      if (r.status === 429) { lastErr = new Error('429'); continue; }
      return r;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return null;
}

// Yahoo Finance chart API — free, no key. Same pattern already used in
// api/price.js fetchYahooBR (proven). Requires browser User-Agent to bypass
// anti-bot. Returns { 'YYYY-MM-DD': close } or null.
async function fetchYahooCandles(ticker, fromSec, toSec) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${fromSec}&period2=${toSec}&interval=1d`;
  try {
    const r = await fetchWithRetry(url, {
      headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' },
    });
    if (!r?.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result?.timestamp?.length) return null;
    const closes = result.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) return null;
    const map = {};
    for (let i = 0; i < result.timestamp.length; i++) {
      if (closes[i] != null) map[toDateStr(result.timestamp[i])] = closes[i];
    }
    return Object.keys(map).length > 0 ? map : null;
  } catch {
    return null;
  }
}

async function fetchBrapiCandles(ticker, token) {
  const url =
    `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}` +
    `?range=5y&interval=1d&token=${encodeURIComponent(token)}`;
  try {
    const r = await fetchWithRetry(url);
    if (!r?.ok) return null;
    const d = await r.json();
    const result = Array.isArray(d?.results) ? d.results[0] : null;
    if (!Array.isArray(result?.historicalDataPrice) || result.historicalDataPrice.length === 0) {
      return null;
    }
    const map = {};
    for (const entry of result.historicalDataPrice) {
      if (entry.close == null) continue;
      const dateStr =
        typeof entry.date === 'number'
          ? toDateStr(entry.date)
          : String(entry.date).slice(0, 10);
      map[dateStr] = entry.close;
    }
    return Object.keys(map).length > 0 ? map : null;
  } catch {
    return null;
  }
}

async function fetchFxHistory(fromDate, toDate) {
  try {
    const url = `https://api.frankfurter.dev/v1/${fromDate}..${toDate}?from=USD&to=BRL`;
    const r = await fetchWithRetry(url);
    if (!r?.ok) return {};
    const d = await r.json();
    const map = {};
    for (const [date, rates] of Object.entries(d.rates || {})) {
      if (rates?.BRL) map[date] = rates.BRL;
    }
    return map;
  } catch {
    return {};
  }
}

// Run async tasks with limited concurrency. Yahoo rate-limits at higher rates.
async function mapConcurrent(items, fn, concurrency = 4) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildDateRange(fromDate, toDate) {
  const dates = [];
  const cur = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function carryForward(rawMap, dates) {
  let last = null;
  const result = {};
  for (const d of dates) {
    if (rawMap[d] != null) last = rawMap[d];
    if (last != null) result[d] = last;
  }
  return result;
}

// Pure calculation — exported for testability. Given pre-fetched candle maps
// and a transactions list, computes the % return series for portfolio + SPY.
export function computePerformance({
  transactions,
  candles,
  spyCandles,
  fxMap = {},
  firstDate,
  todayDate,
}) {
  const filtered = transactions
    .filter((tx) => tx?.assetClass && INCLUDED_CLASSES.has(tx.assetClass))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (filtered.length === 0) {
    return { dates: [], portfolio: [], spy: [], meta: { reason: 'no-eligible-transactions', txFiltered: 0 } };
  }

  const allDates = buildDateRange(firstDate, todayDate);
  const filled = {};
  for (const [t, raw] of Object.entries(candles)) {
    filled[t] = carryForward(raw, allDates);
  }
  // SPY carry-forward is used for portfolio pricing on non-trading days,
  // but we emit chart points ONLY on raw SPY trading days (no weekend padding).
  const rawSpy = spyCandles || {};
  const filledFx = carryForward(fxMap, allDates);

  const txByDate = {};
  for (const tx of filtered) {
    const d = tx.date.slice(0, 10);
    if (!txByDate[d]) txByDate[d] = [];
    txByDate[d].push(tx);
  }

  const positions = {};
  const outDates = [];
  const portfolioValues = [];
  const spyValues = [];

  for (const d of allDates) {
    if (txByDate[d]) {
      for (const tx of txByDate[d]) {
        const ticker = tx.ticker?.toUpperCase();
        if (!ticker) continue;
        const qty = Number(tx.qty) || 0;
        const isSell = (tx.side || '').toLowerCase() === 'sell';
        positions[ticker] = (positions[ticker] || 0) + (isSell ? -qty : qty);
      }
    }

    if (rawSpy[d] == null) continue; // only emit on actual SPY trading days

    let value = 0;
    for (const [ticker, qty] of Object.entries(positions)) {
      if (qty === 0) continue;
      const price = filled[ticker]?.[d];
      if (price == null) continue;
      if (isBrazilianTicker(ticker)) {
        const fx = filledFx[d];
        if (!fx) continue;
        value += qty * (price / fx);
      } else {
        value += qty * price;
      }
    }

    if (value <= 0) continue;

    outDates.push(d);
    portfolioValues.push(value);
    spyValues.push(rawSpy[d]);
  }

  if (outDates.length === 0) {
    return {
      dates: [], portfolio: [], spy: [],
      meta: {
        reason: 'no-priced-days',
        txFiltered: filtered.length,
        candleTickers: Object.keys(candles).filter((k) => candles[k]).length,
        spyCandleDays: Object.keys(spyCandles || {}).length,
      },
    };
  }

  const basePortfolio = portfolioValues[0];
  const baseSpy = spyValues[0];
  const portfolio = portfolioValues.map((v) => +((v / basePortfolio - 1) * 100).toFixed(2));
  const spy = spyValues.map((v) => +((v / baseSpy - 1) * 100).toFixed(2));

  return {
    dates: outDates,
    portfolio,
    spy,
    meta: {
      txFiltered: filtered.length,
      daysComputed: outDates.length,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    return res.status(503).json({ error: `Storage unavailable: ${err.message}` });
  }

  const cacheKey = perfKeyFromAuth(auth);
  const bypassCache = req.query?.refresh === '1';

  if (cacheKey && !bypassCache) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {}
  }

  const { transactions } = req.body || {};
  if (!Array.isArray(transactions)) {
    return res.status(400).json({ error: 'transactions array required' });
  }

  // Pre-filter to find tickers we actually need to fetch.
  const eligible = transactions.filter(
    (tx) => tx?.assetClass && INCLUDED_CLASSES.has(tx.assetClass)
  );
  if (eligible.length === 0) {
    return res.status(200).json({
      dates: [], portfolio: [], spy: [],
      meta: {
        reason: 'no-eligible-transactions',
        txTotal: transactions.length,
        txFiltered: 0,
        sampleAssetClasses: [...new Set(transactions.map((t) => t?.assetClass).filter(Boolean))].slice(0, 10),
      },
    });
  }

  eligible.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const firstDate = eligible[0].date.slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);
  const fromSec = Math.floor(new Date(firstDate + 'T00:00:00Z').getTime() / 1000);
  const toSec = Math.floor(new Date(todayDate + 'T23:59:59Z').getTime() / 1000);

  const brapiKey = process.env.BRAPI_API_KEY || null;

  const uniqueTickers = [
    ...new Set(eligible.map((tx) => tx.ticker?.toUpperCase()).filter(Boolean)),
  ];
  const brTickers = uniqueTickers.filter(isBrazilianTicker);
  const usTickers = uniqueTickers.filter((t) => !isBrazilianTicker(t));

  // Fetch in parallel groups; concurrency caps Yahoo Finance pressure.
  const [spyCandles, usResults, brResults, fxMap] = await Promise.all([
    fetchYahooCandles('SPY', fromSec, toSec),
    mapConcurrent(usTickers, (t) => fetchYahooCandles(t, fromSec, toSec), 4),
    mapConcurrent(brTickers, (t) => brapiKey ? fetchBrapiCandles(t, brapiKey) : Promise.resolve(null), 4),
    brTickers.length > 0 ? fetchFxHistory(firstDate, todayDate) : Promise.resolve({}),
  ]);

  const candleMap = {};
  usTickers.forEach((t, i) => { if (usResults[i]) candleMap[t] = usResults[i]; });
  brTickers.forEach((t, i) => { if (brResults[i]) candleMap[t] = brResults[i]; });

  const result = computePerformance({
    transactions: eligible,
    candles: candleMap,
    spyCandles: spyCandles || {},
    fxMap,
    firstDate,
    todayDate,
  });

  // Enrich meta with fetch-level diagnostics so failures are visible client-side.
  result.meta = {
    ...(result.meta || {}),
    txTotal: transactions.length,
    txEligible: eligible.length,
    uniqueTickers: uniqueTickers.length,
    usTickersFetched: Object.keys(candleMap).filter((t) => !isBrazilianTicker(t)).length,
    usTickersMissing: usTickers.length - Object.keys(candleMap).filter((t) => !isBrazilianTicker(t)).length,
    brTickersFetched: Object.keys(candleMap).filter((t) => isBrazilianTicker(t)).length,
    brTickersMissing: brTickers.length - Object.keys(candleMap).filter((t) => isBrazilianTicker(t)).length,
    spyDays: spyCandles ? Object.keys(spyCandles).length : 0,
    fxDays: Object.keys(fxMap).length,
  };

  // Only cache non-empty successful results.
  if (cacheKey && result.dates.length > 0) {
    try {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);
    } catch {}
  }

  return res.status(200).json(result);
}
