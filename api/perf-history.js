// api/perf-history.js
// POST { transactions, priceData? }
//
// Two-call protocol:
//   1st call (no priceData): check Redis cache. If miss, respond with
//     { needsPrices: true, tickers: [...], firstDate: "YYYY-MM-DD" }
//     so the browser can fetch US ticker prices directly from Yahoo Finance.
//   2nd call (with priceData: { [ticker]: { [date]: price } }):
//     use client-provided prices for US tickers + SPY; fetch B3 tickers
//     via brapi; compute portfolio vs SPY % return; cache 24h.
//
// Rationale: Vercel datacenter IPs are rate-limited/blocked by Yahoo Finance
// and Stooq. The user's browser IP is not rate-limited by Yahoo.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

const INCLUDED_CLASSES = new Set([
  'Stocks',
  'BRA Stocks',
  'Alternative',
  'Real Estate',
]);

const FETCH_TIMEOUT_MS = 5000;

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
}

function perfKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  // v8: client-side price fetching via browser.
  return auth.storageKey.replace(/:holdings$/, ':perf-history:v8');
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

// brapi.dev — used only for B3 tickers (BRL prices). US tickers are handled
// by the browser-side fetch (not subject to Vercel IP rate limiting).
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

  const { transactions, priceData } = req.body || {};
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

  // If no priceData was sent, ask the client to fetch prices from Yahoo Finance.
  // The browser is not subject to the IP-based rate limiting that blocks Vercel.
  if (!priceData || typeof priceData !== 'object' || !Object.keys(priceData).length) {
    return res.status(200).json({
      needsPrices: true,
      tickers: ['SPY', ...usTickers],
      firstDate,
    });
  }

  // priceData received — build candle maps.
  const candleMap = {};
  for (const [ticker, map] of Object.entries(priceData)) {
    if (ticker !== 'SPY' && map && typeof map === 'object') {
      candleMap[ticker] = map;
    }
  }
  const spyCandles = priceData['SPY'] && typeof priceData['SPY'] === 'object'
    ? priceData['SPY']
    : null;

  const brapiKey = process.env.BRAPI_API_KEY || null;
  const t0 = Date.now();

  // Fetch B3 tickers via brapi (server-side, API key, works fine from Vercel).
  const [brResults, fxMap] = await Promise.all([
    mapConcurrent(brTickers, (t) => brapiKey ? fetchBrapiCandles(t, brapiKey) : Promise.resolve(null), 4),
    brTickers.length > 0 ? fetchFxHistory(firstDate, todayDate) : Promise.resolve({}),
  ]);
  brTickers.forEach((t, i) => { if (brResults[i]) candleMap[t] = brResults[i]; });

  const fetchMs = Date.now() - t0;

  const result = computePerformance({
    transactions: eligible,
    candles: candleMap,
    spyCandles: spyCandles || {},
    fxMap,
    firstDate,
    todayDate,
  });

  const usFetchedCount = Object.keys(candleMap).filter((t) => !isBrazilianTicker(t)).length;
  const usMissing = usTickers.filter((t) => !candleMap[t]);
  const brFetchedCount = Object.keys(candleMap).filter((t) => isBrazilianTicker(t)).length;

  result.meta = {
    ...(result.meta || {}),
    txTotal: transactions.length,
    txEligible: eligible.length,
    uniqueTickers: uniqueTickers.length,
    usTickersFetched: usFetchedCount,
    usTickersMissing: usMissing.length,
    usMissingSample: usMissing.slice(0, 8),
    brTickersFetched: brFetchedCount,
    spyDays: spyCandles ? Object.keys(spyCandles).length : 0,
    spySource: spyCandles ? 'client' : null,
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
