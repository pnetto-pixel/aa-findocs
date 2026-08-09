// Vercel serverless function — multi-source quotes
// US stocks: Finnhub (price + profile)
// Brazilian B3 stocks: brapi.dev (BRL price) + brapi (USD/BRL FX, real-time)
// Auth: Google ID token OR APP_PASSWORD (via shared lib/auth.js)

import { authenticate } from "../lib/auth.js";
import { getRedis } from "../lib/redis.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Redis quote cache -------------------------------------------------------
// Quotes are public market data, so the cache is GLOBAL (no storageKey): one
// user's refresh warms the cache for everyone, and repeated refreshes within
// 60s never touch Finnhub/brapi. Fails open when Redis is unavailable.
const QUOTE_CACHE_TTL_SEC = 60;

function quoteCacheKey(ticker, quoteOnly) {
  return `portfolio:quotecache:v1:${ticker}:${quoteOnly ? "q" : "full"}`;
}

function getRedisSafe() {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

async function cacheGetQuote(redis, ticker, quoteOnly) {
  if (!redis) return null;
  try {
    const raw = await redis.get(quoteCacheKey(ticker, quoteOnly));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function cacheSetQuote(redis, ticker, quoteOnly, payload) {
  if (!redis) return;
  try {
    await redis.set(
      quoteCacheKey(ticker, quoteOnly),
      JSON.stringify(payload),
      "EX",
      QUOTE_CACHE_TTL_SEC
    );
  } catch {}
}

// Retry fetch with exponential backoff on 429 (rate limit) — important for Finnhub free tier.
async function fetchWithRetry(url, options = {}, maxAttempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // 800ms, 1.6s, 3.2s
      await sleep(800 * Math.pow(2, attempt - 1));
    }
    try {
      const r = await fetch(url, options);
      if (r.status === 429) {
        lastError = new Error("429 Too Many Requests");
        continue;
      }
      return r;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("Fetch failed");
}

// In-memory profile cache (lives across requests within the same warm function instance).
// Profile data (name, industry) almost never changes — long TTL avoids hammering Finnhub.
const profileCache = new Map();
const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getCachedProfile(ticker) {
  const entry = profileCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.ts > PROFILE_TTL_MS) {
    profileCache.delete(ticker);
    return null;
  }
  return entry.data;
}

function setCachedProfile(ticker, data) {
  profileCache.set(ticker, { ts: Date.now(), data });
}

function isBrazilianTicker(t) {
  // Explicit .SA suffix, or B3 pattern: 4 letters + 1-2 digits (BBSE3, TAEE11)
  return /\.SA$/i.test(t) || /^[A-Z]{4}\d{1,2}$/i.test(t);
}

function stripSA(t) {
  return t.replace(/\.SA$/i, "");
}

async function fetchUsdBrlRate(brapiKey, finnhubKey) {
  // Try Finnhub forex first — real-time, works in free tier
  if (finnhubKey) {
    try {
      const url = `https://finnhub.io/api/v1/forex/rates?base=USD&token=${encodeURIComponent(finnhubKey)}`;
      const r = await fetch(url);
      if (r.ok) {
        const d = await r.json();
        const rate = d?.quote?.BRL;
        if (rate && rate > 0) return rate;
      }
    } catch (e) {}
  }
  // Fallback 1: open.er-api.com (free, real-time, no key)
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    if (r.ok) {
      const d = await r.json();
      const rate = d?.rates?.BRL;
      if (rate && rate > 0) return rate;
    }
  } catch (e) {}
  // Fallback 2: Frankfurter (ECB, daily EOD — last resort)
  const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL");
  if (!r.ok) throw new Error(`FX fetch failed (${r.status})`);
  const d = await r.json();
  const rate = d?.rates?.BRL;
  if (!rate || rate <= 0) throw new Error("No BRL rate returned");
  return rate;
}

async function fetchBrapi(ticker, token) {
  const url = `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}?token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`brapi ${r.status}`);
  const d = await r.json();
  const result = Array.isArray(d?.results) ? d.results[0] : null;
  if (!result || result.regularMarketPrice == null) {
    throw new Error(`No data for ${ticker}`);
  }
  return {
    price: result.regularMarketPrice,
    previousClose:
      result.regularMarketPreviousClose ??
      (result.regularMarketChange != null
        ? result.regularMarketPrice - result.regularMarketChange
        : null),
    name: result.shortName || result.longName || ticker,
    currency: result.currency || "BRL",
    sector: result.sector || null,
  };
}

async function fetchYahooBR(ticker) {
  const symbol = ticker.endsWith(".SA") ? ticker : `${ticker}.SA`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=1d&interval=1d`;
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const d = await r.json();
  const meta = d?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error(`No data for ${symbol}`);
  return {
    price: meta.regularMarketPrice,
    previousClose: meta.previousClose ?? meta.chartPreviousClose ?? null,
    name: meta.shortName || meta.longName || ticker,
    currency: meta.currency || "BRL",
  };
}

// --- USD/BRL FX helper -----------------------------------------------------
// Lets the client convert a manual holding entered in BRL (e.g. a Nubank
// balance) into USD using a live rate. Reuses the same cascade as B3 quotes.
async function handleFx(brapiKey, finnhubKey) {
  const brlPerUsd = await fetchUsdBrlRate(brapiKey, finnhubKey);
  return { pair: "USDBRL", rate: brlPerUsd, fxRate: brlPerUsd };
}

async function handleBrazilian(ticker, brapiKey, finnhubKey, quoteOnly = false, prefetchedFx = null) {
  const baseTicker = stripSA(ticker).toUpperCase();

  // Fetch BRL price (try brapi first if key available, else Yahoo)
  let brl;
  if (brapiKey) {
    try {
      brl = await fetchBrapi(baseTicker, brapiKey);
    } catch (e) {
      try {
        brl = await fetchYahooBR(baseTicker);
      } catch (e2) {
        throw new Error(`No BR data: ${e.message} | Yahoo: ${e2.message}`);
      }
    }
  } else {
    brl = await fetchYahooBR(baseTicker);
  }

  // Get USD/BRL rate (real-time via Finnhub forex, then open.er-api, then
  // Frankfurter EOD). Batch requests prefetch it once for all BR tickers.
  const brlPerUsd = prefetchedFx || (await fetchUsdBrlRate(brapiKey, finnhubKey));

  const base = {
    price: brl.price / brlPerUsd,
    previousClose: brl.previousClose != null ? brl.previousClose / brlPerUsd : null,
    currency: "USD",
    originalCurrency: "BRL",
    originalPrice: brl.price,
    originalPreviousClose: brl.previousClose,
    fxRate: brlPerUsd,
    market: "B3",
  };

  if (quoteOnly) return base;

  return {
    ...base,
    name: brl.name,
    // NOTE (bugfix aug/2026): this used to also return `assetClass: brl.sector`,
    // which the frontend merged straight into holding.assetClass on every
    // refresh, silently overwriting the class the user recorded in
    // transactions (e.g. a stock reclassified as "Alternative"). brapi's
    // `sector` is industry metadata, not one of the app's 9 fixed asset
    // classes, so it's no longer surfaced as `assetClass` — kept only as
    // `industryLabel` for potential future debug/display use.
    industryLabel: brl.sector || null,
  };
}

async function handleUS(ticker, finnhubKey, quoteOnly = false) {
  // Quote: always fresh (it's the price)
  const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
    ticker
  )}&token=${finnhubKey}`;
  const r = await fetchWithRetry(quoteUrl);
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const data = await r.json();
  if (!data || data.c == null || data.c === 0) {
    throw new Error(`No data for "${ticker}"`);
  }

  // quoteOnly: client has cached profile already — return price only.
  if (quoteOnly) {
    return {
      price: data.c,
      currency: "USD",
      previousClose: data.pc ?? null,
      market: "US",
    };
  }

  // Profile (name + industry): check cache first to avoid hitting Finnhub on every refresh
  let cached = getCachedProfile(ticker);
  let name = cached?.name || ticker;
  let industry = cached?.industry || null;

  if (!cached) {
    try {
      const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(
        ticker
      )}&token=${finnhubKey}`;
      const pr = await fetchWithRetry(profileUrl);
      if (pr.ok) {
        const profile = await pr.json();
        if (profile?.name) name = profile.name;
        if (profile?.finnhubIndustry) industry = profile.finnhubIndustry;
      }
    } catch (e) {}

    // Fallback for ETFs: search endpoint
    if (name === ticker) {
      try {
        const searchUrl = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(
          ticker
        )}&exchange=US&token=${finnhubKey}`;
        const sr = await fetchWithRetry(searchUrl);
        if (sr.ok) {
          const sd = await sr.json();
          const match =
            (sd?.result || []).find(
              (x) => (x.symbol || "").toUpperCase() === ticker.toUpperCase()
            ) || (sd?.result || [])[0];
          if (match?.description) {
            name = match.description
              .toLowerCase()
              .replace(/\b\w/g, (c) => c.toUpperCase());
          }
          if (!industry && match?.type) {
            industry = match.type === "ETP" ? "ETF" : match.type;
          }
        }
      } catch (e) {}
    }

    // Only cache if we got a real name (not just ticker fallback)
    if (name !== ticker) {
      setCachedProfile(ticker, { name, industry });
    }
  }

  return {
    price: data.c,
    name,
    currency: "USD",
    previousClose: data.pc ?? null,
    // NOTE (bugfix aug/2026): no longer returning `assetClass: industry`.
    // Finnhub's `finnhubIndustry` (e.g. "Technology Hardware, Storage &
    // Peripherals") has no relation to the app's 9 fixed asset classes
    // (Stocks, BRA Stocks, Alternative, Real Estate, ...); the frontend used
    // to merge it straight into holding.assetClass on every refresh, which
    // silently overwrote classes the user set via transactions. Kept as
    // `industryLabel` only, for potential future debug/display use — not
    // read as assetClass anywhere in the frontend.
    industryLabel: industry || null,
    industry,
    sector: industry,
    market: "US",
  };
}

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const finnhubKey = process.env.FINNHUB_API_KEY;
  const brapiKey = process.env.BRAPI_API_KEY || null;

  if (!finnhubKey) {
    return res.status(500).json({ error: "FINNHUB_API_KEY not configured" });
  }

  // FX endpoint: /api/price?fx=USDBRL → current USD/BRL rate (for BRL→USD manual holdings).
  if ((req.query.fx || "").toString().toUpperCase() === "USDBRL") {
    try {
      const payload = await handleFx(brapiKey, finnhubKey);
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.status(200).json(payload);
    } catch (e) {
      return res.status(502).json({ error: e.message || "FX fetch failed" });
    }
  }

  // quoteOnly=1: client signals it already has name/industry/sector cached.
  // We skip the profile + search endpoints entirely, saving ~2/3 of Finnhub calls.
  const quoteOnly = req.query.quoteOnly === "1" || req.query.quoteOnly === "true";
  const redis = getRedisSafe();

  async function resolveQuote(ticker, prefetchedFx) {
    const cached = await cacheGetQuote(redis, ticker, quoteOnly);
    if (cached) return cached;
    const payload = isBrazilianTicker(ticker)
      ? await handleBrazilian(ticker, brapiKey, finnhubKey, quoteOnly, prefetchedFx)
      : await handleUS(ticker, finnhubKey, quoteOnly);
    await cacheSetQuote(redis, ticker, quoteOnly, payload);
    return payload;
  }

  // Batch endpoint: /api/price?tickers=AAPL,VNQ,BBSE3 → one serverless
  // invocation resolves every quote (bounded concurrency), instead of the
  // client fanning out one request per holding.
  const tickersRaw = (req.query.tickers || "").toString().toUpperCase().trim();
  if (tickersRaw) {
    const tickers = [...new Set(tickersRaw.split(",").map((t) => t.trim()).filter(Boolean))];
    if (
      tickers.length === 0 ||
      tickers.length > 60 ||
      tickers.some((t) => !/^[A-Z0-9.\-]{1,12}$/.test(t))
    ) {
      return res.status(400).json({ error: "Invalid tickers list (max 60)" });
    }

    // Prefetch USD/BRL once for all BR tickers in the batch.
    let prefetchedFx = null;
    if (tickers.some(isBrazilianTicker)) {
      try {
        prefetchedFx = await fetchUsdBrlRate(brapiKey, finnhubKey);
      } catch {}
    }

    const quotes = {};
    const queue = [...tickers];
    const CONCURRENCY = 4;
    async function worker() {
      while (queue.length > 0) {
        const t = queue.shift();
        try {
          quotes[t] = await resolveQuote(t, prefetchedFx);
        } catch (e) {
          quotes[t] = { error: e.message || "Fetch failed" };
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, worker)
    );

    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).json({ quotes });
  }

  const tickerRaw = (req.query.ticker || "").toString().toUpperCase().trim();
  if (!tickerRaw || !/^[A-Z0-9.\-]{1,12}$/.test(tickerRaw)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }

  try {
    const payload = await resolveQuote(tickerRaw, null);
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: e.message || "Fetch failed" });
  }
}
