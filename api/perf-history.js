// api/perf-history.js
// POST { transactions }
//
// Fetches US ticker prices server-side from Twelve Data (requires TWELVEDATA_API_KEY).
// B3 tickers fetched from brapi (requires BRAPI_API_KEY). FX from Frankfurter.
// Results cached in Redis 24h.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

const INCLUDED_CLASSES = new Set([
  'Stocks',
  'BRA Stocks',
  'Alternative',
  'Real Estate',
]);

const FETCH_TIMEOUT_MS = 15000;
const TWELVEDATA_BATCH = 20; // tickers per request

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
}

function perfKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  // v9: Twelve Data server-side fetching.
  return auth.storageKey.replace(/:holdings$/, ':perf-history:v9');
}

function toDateStr(unixSec) {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseTwelvedataSeries(series) {
  const map = {};
  for (const entry of (series?.values || [])) {
    if (entry.datetime && entry.close != null) {
      map[entry.datetime.slice(0, 10)] = parseFloat(entry.close);
    }
  }
  return map;
}

// Twelve Data — batch up to TWELVEDATA_BATCH US tickers per call.
// Single-ticker and multi-ticker responses have different shapes.
async function fetchTwelvedataBatch(tickers, apiKey, fromDate, toDate) {
  if (!tickers.length) return {};
  const symbol = tickers.join(',');
  const url =
    `https://api.twelvedata.com/time_series?symbol=${symbol}` +
    `&interval=1day&start_date=${fromDate}&end_date=${toDate}&outputsize=5000` +
    `&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
    if (!r.ok) return {};
    const data = await r.json();
    if (tickers.length === 1) {
      if (data.status === 'error') return {};
      const map = parseTwelvedataSeries(data);
      return Object.keys(map).length > 0 ? { [tickers[0]]: map } : {};
    }
    const result = {};
    for (const ticker of tickers) {
      const series = data[ticker];
      if (!series || series.status === 'error') continue;
      const map = parseTwelvedataSeries(series);
      if (Object.keys(map).length > 0) result[ticker] = map;
    }
    return result;
  } catch {
    return {};
  }
}

// brapi.dev — used only for B3 tickers (BRL prices).
async function fetchBrapiCandles(ticker, token) {
  const url =
    `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}` +
    `?range=5y&interval=1d&token=${encodeURIComponent(token)}`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) return null;
    const d = await r.json();
    const result = Array.isArray(d?.results) ? d.results[0] : null;
    if (!Array.isArray(result?.historicalDataPrice) || !result.historicalDataPrice.length) {
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
    const r = await fetchWithTimeout(url);
    if (!r.ok) return {};
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

// Pure calculation — exported for testability.
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

    if (rawSpy[d] == null) continue;

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
    meta: { txFiltered: filtered.length, daysComputed: outDates.length },
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

  const twelvedataKey = process.env.TWELVEDATA_API_KEY;
  if (!twelvedataKey) {
    return res.status(503).json({ error: 'Price data unavailable: TWELVEDATA_API_KEY not configured.' });
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
      if (cached) return res.status(200).json(JSON.parse(cached));
    } catch {}
  }

  const { transactions } = req.body || {};
  if (!Array.isArray(transactions)) {
    return res.status(400).json({ error: 'transactions array required' });
  }

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

  const uniqueTickers = [
    ...new Set(eligible.map((tx) => tx.ticker?.toUpperCase()).filter(Boolean)),
  ];
  const brTickers = uniqueTickers.filter(isBrazilianTicker);
  const usTickers = uniqueTickers.filter((t) => !isBrazilianTicker(t));

  const t0 = Date.now();

  // Batch all US tickers + SPY for Twelve Data (reduces HTTP round-trips).
  const allUsTickers = ['SPY', ...usTickers];
  const usBatches = [];
  for (let i = 0; i < allUsTickers.length; i += TWELVEDATA_BATCH) {
    usBatches.push(allUsTickers.slice(i, i + TWELVEDATA_BATCH));
  }

  const [batchResults, brResults, fxMap] = await Promise.all([
    mapConcurrent(usBatches, (batch) => fetchTwelvedataBatch(batch, twelvedataKey, firstDate, todayDate), 2),
    mapConcurrent(brTickers, (t) => process.env.BRAPI_API_KEY ? fetchBrapiCandles(t, process.env.BRAPI_API_KEY) : Promise.resolve(null), 4),
    brTickers.length > 0 ? fetchFxHistory(firstDate, todayDate) : Promise.resolve({}),
  ]);

  const twelveMap = Object.assign({}, ...batchResults);
  const candleMap = {};
  for (const t of usTickers) {
    if (twelveMap[t]) candleMap[t] = twelveMap[t];
  }
  brTickers.forEach((t, i) => { if (brResults[i]) candleMap[t] = brResults[i]; });
  const spyCandles = twelveMap['SPY'] || null;

  const fetchMs = Date.now() - t0;

  const result = computePerformance({
    transactions: eligible,
    candles: candleMap,
    spyCandles: spyCandles || {},
    fxMap,
    firstDate,
    todayDate,
  });

  const usMissing = usTickers.filter((t) => !candleMap[t]);

  result.meta = {
    ...(result.meta || {}),
    txTotal: transactions.length,
    txEligible: eligible.length,
    uniqueTickers: uniqueTickers.length,
    usTickersFetched: usTickers.filter((t) => candleMap[t]).length,
    usTickersMissing: usMissing.length,
    usMissingSample: usMissing.slice(0, 8),
    brTickersFetched: brTickers.filter((t) => candleMap[t]).length,
    spyDays: spyCandles ? Object.keys(spyCandles).length : 0,
    spySource: spyCandles ? 'twelvedata' : null,
    fxDays: Object.keys(fxMap).length,
    fetchMs,
  };

  if (cacheKey && result.dates.length > 0) {
    try {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);
    } catch {}
  }

  return res.status(200).json(result);
}
