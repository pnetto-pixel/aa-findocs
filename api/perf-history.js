// api/perf-history.js
// POST { transactions }: { dates, portfolio, spy, meta }
// Calculates daily portfolio vs SPY performance, normalized to % return.
// Includes only: Stocks, BRA Stocks, Alternative, Real Estate.
// US tickers + SPY: Stooq.com CSV (primary, bulk-friendly) → Yahoo fallback.
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

// Hard per-fetch ceiling. Vercel default function timeout is 30s; we run
// Stooq (phase 1) and Yahoo fallback (phase 2) as separate concurrent
// sweeps to stay well under budget.
const FETCH_TIMEOUT_MS = 2500;

function isBrazilianTicker(t) {
  return /^[A-Z]{4}\d{1,2}$/i.test(t);
}

function perfKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  // v5: two-phase fetch (Stooq sweep → Yahoo for misses), 2.5s per-fetch timeout.
  return auth.storageKey.replace(/:holdings$/, ':perf-history:v5');
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

// Error capture for diagnostics. Each fetcher records its first failure
// reason so the response meta can show why a source failed.
const errorLog = { stooq: [], yahoo: [], brapi: [], fx: [] };
function recordErr(source, ticker, status, snippet) {
  if (errorLog[source].length >= 5) return; // cap to keep response small
  errorLog[source].push({ ticker, status, snippet: (snippet || '').slice(0, 120) });
}

// Stooq.com CSV — designed for bulk historical downloads.
// Symbol convention: lowercase ticker + ".us" (e.g. "aapl.us", "spy.us").
// No User-Agent: browser-UA + datacenter IP combo can trigger anti-bot;
// Stooq is permissive with default Node fetch UA.
export async function fetchStooqCandles(ticker, fromDate, toDate) {
  const symbol = ticker.toLowerCase() + '.us';
  const d1 = fromDate.replace(/-/g, '');
  const d2 = toDate.replace(/-/g, '');
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&d1=${d1}&d2=${d2}&i=d`;
  try {
    const r = await fetchWithTimeout(url, {
      headers: { Accept: 'text/csv,text/plain,*/*' },
    });
    if (!r.ok) { recordErr('stooq', ticker, r.status, ''); return null; }
    const text = await r.text();
    if (!text || text.length < 20) { recordErr('stooq', ticker, r.status, text); return null; }
    if (/^no data/i.test(text.trim())) { recordErr('stooq', ticker, r.status, 'No data'); return null; }
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) { recordErr('stooq', ticker, r.status, text.slice(0, 80)); return null; }
    const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
    const dateIdx = header.indexOf('date');
    const closeIdx = header.indexOf('close');
    if (dateIdx < 0 || closeIdx < 0) {
      recordErr('stooq', ticker, r.status, `bad headers: ${lines[0]}`);
      return null;
    }
    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const date = cols[dateIdx]?.trim();
      const close = parseFloat(cols[closeIdx]);
      if (date && Number.isFinite(close)) map[date] = close;
    }
    return Object.keys(map).length > 0 ? map : null;
  } catch (e) {
    recordErr('stooq', ticker, 0, e.message);
    return null;
  }
}

// Yahoo Finance chart API — uses range= form (same as api/price.js
// fetchYahooBR which is proven in production). period1/period2 form
// sometimes requires a "crumb" cookie token; range= does not.
async function fetchYahooCandles(ticker) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=10y&interval=1d`;
  try {
    const r = await fetchWithTimeout(url, {
      headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' },
    });
    if (!r.ok) {
      let body = '';
      try { body = await r.text(); } catch {}
      recordErr('yahoo', ticker, r.status, body);
      return null;
    }
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    const ycode = d?.chart?.error?.code;
    if (!result?.timestamp?.length) {
      recordErr('yahoo', ticker, r.status, ycode || 'no-timestamps');
      return null;
    }
    const closes = result.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) {
      recordErr('yahoo', ticker, r.status, 'no-closes');
      return null;
    }
    const map = {};
    for (let i = 0; i < result.timestamp.length; i++) {
      if (closes[i] != null) map[toDateStr(result.timestamp[i])] = closes[i];
    }
    return Object.keys(map).length > 0 ? map : null;
  } catch (e) {
    recordErr('yahoo', ticker, 0, e.message);
    return null;
  }
}

// Try Stooq first (bulk-friendly), fall back to Yahoo. Returns
// { map, source } where source is 'stooq' | 'yahoo' | null.
async function fetchUSCandles(ticker, fromDate, toDate) {
  const stooq = await fetchStooqCandles(ticker, fromDate, toDate);
  if (stooq) return { map: stooq, source: 'stooq' };
  const yahoo = await fetchYahooCandles(ticker);
  if (yahoo) return { map: yahoo, source: 'yahoo' };
  return { map: null, source: null };
}

async function fetchBrapiCandles(ticker, token) {
  const url =
    `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}` +
    `?range=5y&interval=1d&token=${encodeURIComponent(token)}`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) { recordErr('brapi', ticker, r.status, ''); return null; }
    const d = await r.json();
    const result = Array.isArray(d?.results) ? d.results[0] : null;
    if (!Array.isArray(result?.historicalDataPrice) || result.historicalDataPrice.length === 0) {
      recordErr('brapi', ticker, r.status, 'no-historical');
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
  } catch (e) {
    recordErr('brapi', ticker, 0, e.message);
    return null;
  }
}

async function fetchFxHistory(fromDate, toDate) {
  try {
    const url = `https://api.frankfurter.dev/v1/${fromDate}..${toDate}?from=USD&to=BRL`;
    const r = await fetchWithTimeout(url);
    if (!r.ok) { recordErr('fx', null, r.status, ''); return {}; }
    const d = await r.json();
    const map = {};
    for (const [date, rates] of Object.entries(d.rates || {})) {
      if (rates?.BRL) map[date] = rates.BRL;
    }
    return map;
  } catch (e) {
    recordErr('fx', null, 0, e.message);
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

  // Reset per-request diagnostics (warm function instances persist state)
  errorLog.stooq = [];
  errorLog.yahoo = [];
  errorLog.brapi = [];
  errorLog.fx = [];

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

  const brapiKey = process.env.BRAPI_API_KEY || null;

  const uniqueTickers = [
    ...new Set(eligible.map((tx) => tx.ticker?.toUpperCase()).filter(Boolean)),
  ];
  const brTickers = uniqueTickers.filter(isBrazilianTicker);
  const usTickers = uniqueTickers.filter((t) => !isBrazilianTicker(t));

  // Two-phase fetch strategy to stay within the 30s Vercel function budget:
  //   Phase 1 — Stooq for all US tickers + SPY, concurrency 20, 2.5s timeout.
  //             Runs in parallel with B3 + FX fetches.
  //   Phase 2 — Yahoo fallback only for Phase 1 misses, concurrency 15.
  // Worst case: ceil(66/20)×2.5s + ceil(66/15)×2.5s ≈ 10s + 12.5s = 22.5s.
  const allUsTickers = ['SPY', ...usTickers];
  const t0 = Date.now();

  const [stooqResultsArr, brResults, fxMap] = await Promise.all([
    mapConcurrent(allUsTickers, (t) => fetchStooqCandles(t, firstDate, todayDate), 20),
    mapConcurrent(brTickers, (t) => brapiKey ? fetchBrapiCandles(t, brapiKey) : Promise.resolve(null), 4),
    brTickers.length > 0 ? fetchFxHistory(firstDate, todayDate) : Promise.resolve({}),
  ]);

  // Phase 2: Yahoo fallback for any ticker Stooq missed.
  const phase2Tickers = allUsTickers.filter((_, i) => !stooqResultsArr[i]);
  const yahooResultsArr = phase2Tickers.length > 0
    ? await mapConcurrent(phase2Tickers, (t) => fetchYahooCandles(t), 15)
    : [];

  const fetchMs = Date.now() - t0;

  // Merge results: build per-ticker candle map and track source counts.
  const candleMap = {};
  const sourceCount = { stooq: 0, yahoo: 0 };
  const yahooByTicker = {};
  phase2Tickers.forEach((t, i) => { if (yahooResultsArr[i]) yahooByTicker[t] = yahooResultsArr[i]; });

  allUsTickers.forEach((t, i) => {
    const map = stooqResultsArr[i] || yahooByTicker[t] || null;
    const source = stooqResultsArr[i] ? 'stooq' : yahooByTicker[t] ? 'yahoo' : null;
    if (map && t !== 'SPY') {
      candleMap[t] = map;
      sourceCount[source] = (sourceCount[source] || 0) + 1;
    }
  });
  brTickers.forEach((t, i) => { if (brResults[i]) candleMap[t] = brResults[i]; });

  const spyEntry = stooqResultsArr[0] || yahooByTicker['SPY'] || null;
  const spySource = stooqResultsArr[0] ? 'stooq' : yahooByTicker['SPY'] ? 'yahoo' : null;
  const spyCandles = spyEntry || null;

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
    brTickersMissing: brTickers.length - brFetchedCount,
    spyDays: spyCandles ? Object.keys(spyCandles).length : 0,
    spySource: spySource,
    sources: sourceCount,
    fxDays: Object.keys(fxMap).length,
    fetchMs,
    errors: {
      stooq: errorLog.stooq,
      yahoo: errorLog.yahoo,
      brapi: errorLog.brapi,
      fx: errorLog.fx,
    },
  };

  // Only cache non-empty successful results.
  if (cacheKey && result.dates.length > 0) {
    try {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);
    } catch {}
  }

  return res.status(200).json(result);
}
