// Vercel serverless function — multi-source quotes
// US stocks: Finnhub (price + profile)
// Brazilian B3 stocks: brapi.dev (BRL price) + brapi (USD/BRL FX, real-time)
// Auth: APP_PASSWORD header. Required env: APP_PASSWORD, FINNHUB_API_KEY, BRAPI_API_KEY (optional, falls back to Yahoo).

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function handleBrazilian(ticker, brapiKey, finnhubKey) {
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

  // Get USD/BRL rate (real-time via Finnhub forex, then open.er-api, then Frankfurter EOD)
  const brlPerUsd = await fetchUsdBrlRate(brapiKey, finnhubKey);

  return {
    price: brl.price / brlPerUsd,
    previousClose: brl.previousClose != null ? brl.previousClose / brlPerUsd : null,
    name: brl.name,
    currency: "USD",
    assetClass: brl.sector || "Brazilian Equity",
    originalCurrency: "BRL",
    originalPrice: brl.price,
    originalPreviousClose: brl.previousClose,
    fxRate: brlPerUsd,
    market: "B3",
  };
}

async function handleUS(ticker, finnhubKey) {
  const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
    ticker
  )}&token=${finnhubKey}`;
  const r = await fetch(quoteUrl);
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const data = await r.json();
  if (!data || data.c == null || data.c === 0) {
    throw new Error(`No data for "${ticker}"`);
  }

  let name = ticker;
  let industry = null;
  try {
    const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(
      ticker
    )}&token=${finnhubKey}`;
    const pr = await fetch(profileUrl);
    if (pr.ok) {
      const profile = await pr.json();
      if (profile?.name) name = profile.name;
      if (profile?.finnhubIndustry) industry = profile.finnhubIndustry;
    }
  } catch (e) {}

  // Fallback for ETFs / instruments not in profile2: use symbol search
  // Sometimes Finnhub rate-limits the search endpoint when called rapidly (Refresh All).
  // Retry once with a small delay if the first attempt fails or returns nothing useful.
  if (name === ticker) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(400);
      try {
        const searchUrl = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(
          ticker
        )}&exchange=US&token=${finnhubKey}`;
        const sr = await fetch(searchUrl);
        if (!sr.ok) continue;
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
        if (name !== ticker) break; // got a name, stop retrying
      } catch (e) {}
    }
  }

  return {
    price: data.c,
    name,
    currency: "USD",
    previousClose: data.pc ?? null,
    assetClass: industry || "Uncategorized",
    industry,
    sector: industry,
    market: "US",
  };
}

export default async function handler(req, res) {
  const expectedPassword = process.env.APP_PASSWORD;
  const providedPassword = req.headers["x-app-password"];

  if (!expectedPassword) {
    return res.status(500).json({ error: "APP_PASSWORD not configured" });
  }
  if (providedPassword !== expectedPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const finnhubKey = process.env.FINNHUB_API_KEY;
  const brapiKey = process.env.BRAPI_API_KEY || null;

  if (!finnhubKey) {
    return res.status(500).json({ error: "FINNHUB_API_KEY not configured" });
  }

  const tickerRaw = (req.query.ticker || "").toString().toUpperCase().trim();
  if (!tickerRaw || !/^[A-Z0-9.\-]{1,12}$/.test(tickerRaw)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }

  try {
    let payload;
    if (isBrazilianTicker(tickerRaw)) {
      payload = await handleBrazilian(tickerRaw, brapiKey, finnhubKey);
    } else {
      payload = await handleUS(tickerRaw, finnhubKey);
    }
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: e.message || "Fetch failed" });
  }
}
