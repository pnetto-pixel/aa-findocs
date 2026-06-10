// api/perf-history.js
// POST { transactions }
//
// Fetches US ticker prices server-side:
//   Primary:  Twelve Data (requires TWELVEDATA_API_KEY)
//   Fallback: Yahoo Finance (User-Agent header, low concurrency)
// B3 tickers: brapi (requires BRAPI_API_KEY). FX: Frankfurter.
// Results cached in Redis 24h.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

const INCLUDED_CLASSES = new Set([
  'Stocks',
  'BRA Stocks',
  'Alternative',
  'Real Estate',
  'Bonds',
  'Bank Bonds',
  'BRA Fixed Income',
  'Unallocated USD',
]);

const FETCH_TIMEOUT_MS = 15000;
const TWELVEDATA_BATCH = 20; // tickers per request

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

function perfKeyFromAuth(auth, txsHash) {
  if (!auth?.storageKey) return null;
  // v12: cache key includes transaction hash so any change invalidates automatically.
  return auth.storageKey.replace(/:holdings$/, `:perf-history:v12:${txsHash}`);
}

// Returns seconds until the next US market close (≈21:00 UTC = 4 PM ET).
// Cache is valid until the next close so data always reflects the last settled day.
function secondsUntilNextMarketClose() {
  const now = Date.now();
  const MS_PER_DAY = 86400000;
  const todayMidnightUTC = now - (now % MS_PER_DAY);
  const todayClose = todayMidnightUTC + 21 * 3600000; // 21:00 UTC ≈ 4 PM ET
  const nextClose = now < todayClose ? todayClose : todayClose + MS_PER_DAY;
  return Math.max(1800, Math.round((nextClose - now) / 1000)); // minimum 30 min
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

// Returns { prices: {[ticker]: priceMap}, error: string|null }.
// Captures actual error details instead of swallowing them.
async function fetchTwelvedataBatch(tickers, apiKey, fromDate, toDate) {
  if (!tickers.length) return { prices: {}, error: null };
  const symbol = tickers.join(',');
  const url =
    `https://api.twelvedata.com/time_series?symbol=${symbol}` +
    `&interval=1day&start_date=${fromDate}&end_date=${toDate}&outputsize=5000` +
    `&apikey=${encodeURIComponent(apiKey)}`;
  let httpStatus = null;
  try {
    const r = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
    httpStatus = r.status;
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { prices: {}, error: `HTTP ${httpStatus}: ${body.slice(0, 300)}` };
    }
    const data = await r.json();
    // Top-level error (plan limit, bad params, etc.)
    if (data.status === 'error') {
      return { prices: {}, error: `API ${data.code}: ${data.message}` };
    }
    const prices = {};
    if (tickers.length === 1) {
      const map = parseTwelvedataSeries(data);
      if (Object.keys(map).length > 0) prices[tickers[0]] = map;
    } else {
      for (const ticker of tickers) {
        const series = data[ticker];
        if (!series || series.status === 'error') continue;
        const map = parseTwelvedataSeries(series);
        if (Object.keys(map).length > 0) prices[ticker] = map;
      }
    }
    return { prices, error: null };
  } catch (e) {
    return { prices: {}, error: `${e?.name || 'Error'}: ${e?.message || 'network error'} (HTTP ${httpStatus ?? 'none'})` };
  }
}

// Yahoo Finance fallback — User-Agent avoids plain-scraper blocks.
// With 24h Redis cache this runs at most once per day per portfolio.
async function fetchYahooCandle(ticker, fromDate) {
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=10y&interval=1d`;
  try {
    const r = await fetchWithTimeout(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }, 8000);
    if (!r.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result?.timestamp?.length) return null;
    const closes = result.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) return null;
    const map = {};
    for (let i = 0; i < result.timestamp.length; i++) {
      if (closes[i] != null) {
        const date = new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10);
        if (date >= fromDate) map[date] = closes[i];
      }
    }
    return Object.keys(map).length > 0 ? map : null;
  } catch {
    return null;
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
// Uses Time-Weighted Return (TWR): each day's return is computed from the
// PREVIOUS day's positions at today's vs yesterday's prices. New capital
// additions (buys) and withdrawals (sells) do not inflate or deflate the
// return — only price appreciation counts.
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
  let prevDayPositions = {}; // positions at close of last trading day
  let prevDayPrices = {};    // USD prices at close of last trading day
  let chainedReturn = 1;
  let isFirstDay = true;

  const outDates = [];
  const portfolioValues = [];
  const portfolioUSD = [];
  const spyValues = [];

  for (const d of allDates) {
    // Apply today's transactions (buys/sells update positions).
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

    // Compute today's USD price for each held ticker.
    const todayPrices = {};
    for (const [ticker, qty] of Object.entries(positions)) {
      if (qty <= 0) continue;
      const price = filled[ticker]?.[d];
      if (price == null) continue;
      if (isBrazilianTicker(ticker)) {
        const fx = filledFx[d];
        if (fx) todayPrices[ticker] = price / fx;
      } else {
        todayPrices[ticker] = price;
      }
    }

    const valueCurrent = Object.entries(positions).reduce(
      (s, [t, q]) => (q > 0 && todayPrices[t] != null ? s + q * todayPrices[t] : s), 0
    );

    if (isFirstDay) {
      if (valueCurrent > 0) {
        outDates.push(d);
        portfolioValues.push(0);
        portfolioUSD.push(+valueCurrent.toFixed(2));
        spyValues.push(rawSpy[d]);
        isFirstDay = false;
        prevDayPositions = { ...positions };
        prevDayPrices = { ...todayPrices };
      }
    } else {
      // TWR sub-period return: (prev positions × today prices) / (prev positions × yesterday prices) − 1.
      // Buys and sells that happened today are NOT in prevDayPositions, so they
      // don't contribute to this day's return (capital flows are neutralised).
      let num = 0;
      let den = 0;
      for (const [ticker, qty] of Object.entries(prevDayPositions)) {
        if (qty <= 0) continue;
        const tp = todayPrices[ticker];
        const yp = prevDayPrices[ticker];
        if (tp != null && yp != null) {
          num += qty * tp;
          den += qty * yp;
        }
      }
      if (den > 0) {
        chainedReturn *= num / den;
        outDates.push(d);
        portfolioValues.push(+((chainedReturn - 1) * 100).toFixed(2));
        portfolioUSD.push(+valueCurrent.toFixed(2));
        spyValues.push(rawSpy[d]);
      }
      prevDayPositions = { ...positions };
      prevDayPrices = { ...todayPrices };
    }
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

  const baseSpy = spyValues[0];
  const spy = spyValues.map((v) => +((v / baseSpy - 1) * 100).toFixed(2));

  return {
    dates: outDates,
    portfolio: portfolioValues, // TWR %, base = 0
    portfolioUSD,              // absolute USD value each trading day
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

  const bypassCache = req.query?.refresh === '1';

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

  // Hash over fields that affect the performance calculation so any change busts the cache.
  const txsHash = simpleHash(
    eligible.map(t => `${t.id}|${t.date}|${t.side}|${t.ticker}|${t.qty}|${t.price}`).sort().join(',')
  );
  const cacheKey = perfKeyFromAuth(auth, txsHash);

  if (cacheKey && !bypassCache) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return res.status(200).json(JSON.parse(cached));
    } catch {}
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

  // Batch US tickers + SPY for Twelve Data.
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

  const twelvedataErrors = batchResults.filter(r => r.error).map(r => r.error).slice(0, 3);
  const twelveMap = Object.assign({}, ...batchResults.map(r => r.prices));

  const candleMap = {};
  for (const t of usTickers) {
    if (twelveMap[t]) candleMap[t] = twelveMap[t];
  }
  brTickers.forEach((t, i) => { if (brResults[i]) candleMap[t] = brResults[i]; });
  let spyCandles = twelveMap['SPY'] || null;

  // Yahoo Finance fallback for SPY and any US tickers that Twelve Data couldn't price.
  const missingForYahoo = [
    ...(!spyCandles ? ['SPY'] : []),
    ...usTickers.filter(t => !candleMap[t]),
  ];
  let yahooFetched = 0;
  if (missingForYahoo.length > 0) {
    const yahooResults = await mapConcurrent(missingForYahoo, t => fetchYahooCandle(t, firstDate), 2);
    for (let i = 0; i < missingForYahoo.length; i++) {
      if (!yahooResults[i]) continue;
      const t = missingForYahoo[i];
      if (t === 'SPY') spyCandles = yahooResults[i];
      else candleMap[t] = yahooResults[i];
      yahooFetched++;
    }
  }

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
    spySource: spyCandles ? (twelveMap['SPY'] ? 'twelvedata' : 'yahoo') : null,
    yahooFallbackFetched: yahooFetched,
    twelvedataErrors,
    fxDays: Object.keys(fxMap).length,
    fetchMs,
  };

  if (cacheKey && result.dates.length > 0) {
    try {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', secondsUntilNextMarketClose());
    } catch {}
  }

  return res.status(200).json(result);
}
