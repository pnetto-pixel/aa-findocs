// api/perf-history.js
// POST { transactions }: { dates, portfolio, spy }
// Calculates daily portfolio vs SPY performance, normalized to % return.
// Includes only: Stocks, BRA Stocks, Alternative, Real Estate.
// US tickers: Finnhub daily candles. B3 tickers: brapi.dev daily candles.
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

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
}

function perfKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':perf-history');
}

function toDateStr(unixSec) {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

async function fetchFinnhubCandles(ticker, fromSec, toSec, token) {
  const url =
    `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(ticker)}` +
    `&resolution=D&from=${fromSec}&to=${toSec}&token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.s !== 'ok' || !Array.isArray(d.t) || d.t.length === 0) return null;
    const map = {};
    for (let i = 0; i < d.t.length; i++) {
      if (d.c[i] != null) map[toDateStr(d.t[i])] = d.c[i];
    }
    return map;
  } catch {
    return null;
  }
}

async function fetchBrapiCandles(ticker, token) {
  const url =
    `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}` +
    `?range=5y&interval=1d&token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    const result = Array.isArray(d?.results) ? d.results[0] : null;
    if (!Array.isArray(result?.historicalDataPrice) || result.historicalDataPrice.length === 0) {
      return null;
    }
    const map = {};
    for (const entry of result.historicalDataPrice) {
      if (entry.close == null) continue;
      // date is Unix timestamp (seconds) or ISO string
      const dateStr =
        typeof entry.date === 'number'
          ? toDateStr(entry.date)
          : String(entry.date).slice(0, 10);
      map[dateStr] = entry.close;
    }
    return map;
  } catch {
    return null;
  }
}

// Frankfurter free historical series — ECB business days.
// open.er-api free tier only exposes current rates; Frankfurter covers date ranges.
async function fetchFxHistory(fromDate, toDate) {
  try {
    const url = `https://api.frankfurter.dev/v1/${fromDate}..${toDate}?from=USD&to=BRL`;
    const r = await fetch(url);
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

// For each date in `dates`, carry forward the last known value from rawMap.
function carryForward(rawMap, dates) {
  let last = null;
  const result = {};
  for (const d of dates) {
    if (rawMap[d] != null) last = rawMap[d];
    if (last != null) result[d] = last;
  }
  return result;
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

  // Serve from Redis cache if available (24h TTL)
  const cacheKey = perfKeyFromAuth(auth);
  if (cacheKey) {
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

  const filtered = transactions.filter(
    (tx) => tx?.assetClass && INCLUDED_CLASSES.has(tx.assetClass)
  );

  if (filtered.length === 0) {
    return res.status(200).json({ dates: [], portfolio: [], spy: [] });
  }

  // Sort by date ascending
  filtered.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const firstDate = filtered[0].date.slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);

  const finnhubKey = process.env.FINNHUB_API_KEY;
  const brapiKey = process.env.BRAPI_API_KEY || null;

  if (!finnhubKey) {
    return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });
  }

  const fromSec = Math.floor(new Date(firstDate + 'T00:00:00Z').getTime() / 1000);
  const toSec = Math.floor(new Date(todayDate + 'T23:59:59Z').getTime() / 1000);

  const uniqueTickers = [
    ...new Set(filtered.map((tx) => tx.ticker?.toUpperCase()).filter(Boolean)),
  ];
  const brTickers = uniqueTickers.filter(isBrazilianTicker);
  const usTickers = uniqueTickers.filter((t) => !isBrazilianTicker(t));

  // Fetch all candles + FX in parallel
  const [spyCandles, usResults, brResults, fxMap] = await Promise.all([
    fetchFinnhubCandles('SPY', fromSec, toSec, finnhubKey),
    Promise.all(usTickers.map((t) => fetchFinnhubCandles(t, fromSec, toSec, finnhubKey))),
    Promise.all(
      brTickers.map((t) =>
        brapiKey ? fetchBrapiCandles(t, brapiKey) : Promise.resolve(null)
      )
    ),
    brTickers.length > 0 ? fetchFxHistory(firstDate, todayDate) : Promise.resolve({}),
  ]);

  const candleMap = {};
  usTickers.forEach((t, i) => { if (usResults[i]) candleMap[t] = usResults[i]; });
  brTickers.forEach((t, i) => { if (brResults[i]) candleMap[t] = brResults[i]; });

  // Build calendar of all days in range
  const allDates = buildDateRange(firstDate, todayDate);

  // Carry-forward prices so weekends/holidays use last trading day's close
  const filled = {};
  for (const [t, raw] of Object.entries(candleMap)) {
    filled[t] = carryForward(raw, allDates);
  }
  const filledSpy = spyCandles ? carryForward(spyCandles, allDates) : {};
  const filledFx = carryForward(fxMap, allDates);

  // Group transactions by date for efficient processing
  const txByDate = {};
  for (const tx of filtered) {
    const d = tx.date.slice(0, 10);
    if (!txByDate[d]) txByDate[d] = [];
    txByDate[d].push(tx);
  }

  const positions = {}; // ticker → cumulative qty
  const outDates = [];
  const portfolioValues = [];
  const spyValues = [];

  for (const d of allDates) {
    // Apply transactions on this date before pricing
    if (txByDate[d]) {
      for (const tx of txByDate[d]) {
        const ticker = tx.ticker?.toUpperCase();
        if (!ticker) continue;
        const qty = Number(tx.qty) || 0;
        const isSell = (tx.side || '').toLowerCase() === 'sell';
        positions[ticker] = (positions[ticker] || 0) + (isSell ? -qty : qty);
      }
    }

    // Only emit data on SPY trading days
    if (filledSpy[d] == null) continue;

    // Calculate portfolio value in USD
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
    spyValues.push(filledSpy[d]);
  }

  if (outDates.length === 0) {
    return res.status(200).json({ dates: [], portfolio: [], spy: [] });
  }

  // Normalize to % return since first data point
  const basePortfolio = portfolioValues[0];
  const baseSpy = spyValues[0];

  const portfolio = portfolioValues.map((v) => +((v / basePortfolio - 1) * 100).toFixed(2));
  const spy = spyValues.map((v) => +((v / baseSpy - 1) * 100).toFixed(2));

  const result = { dates: outDates, portfolio, spy };

  // Cache for 24h
  if (cacheKey) {
    try {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);
    } catch {}
  }

  return res.status(200).json(result);
}
