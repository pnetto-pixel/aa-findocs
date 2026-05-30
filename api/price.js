// Vercel serverless function — multi-source quotes
// US stocks: Finnhub (price + profile)
// Brazilian B3 stocks: brapi.dev (BRL price) + brapi (USD/BRL FX, real-time)
// Auth: Google ID token OR APP_PASSWORD (via shared lib/auth.js)

import { authenticate } from "../lib/auth.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// --- Tesouro Direto (official open data: Tesouro Transparente / CKAN) -------
// brapi's Tesouro endpoint needs a paid plan (403) and the old tesourodireto.com.br
// JSON was decommissioned (410 Gone). We query the official Tesouro Transparente
// CKAN datastore via SQL, which lets us fetch just the bond we need (the full
// dataset is a multi-MB daily CSV). Columns are PT-BR with comma decimals.
const TESOURO_RESOURCE_ID = "796d2059-14e9-44e3-80c9-2d9e30b405c1";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Parse a brapi-style slug (e.g. "tesouro-ipca-com-juros-semestrais-15052035")
// into a maturity date + bond kind + semiannual-coupon flag.
function parseTesouroSlug(slug) {
  const m = String(slug || "")
    .toLowerCase()
    .match(/^tesouro-(.+)-(\d{8})$/);
  if (!m) return null;
  const type = m[1];
  const d = m[2]; // DDMMYYYY
  const maturityBR = `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4, 8)}`; // DD/MM/YYYY
  const maturity = `${d.slice(4, 8)}-${d.slice(2, 4)}-${d.slice(0, 2)}`; // YYYY-MM-DD
  const hasJuros = /juros-semestrais/.test(type);
  let kind = null;
  if (/selic/.test(type)) kind = "selic";
  else if (/ipca/.test(type)) kind = "ipca";
  else if (/prefixado/.test(type)) kind = "prefixado";
  else if (/renda/.test(type)) kind = "renda";
  else if (/educa/.test(type)) kind = "educa";
  return { type, maturity, maturityBR, hasJuros, kind };
}

// Parse a PT-BR / numeric value. "1.234,56" → 1234.56; "1234.56" → 1234.56.
function parseBRNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// DD/MM/YYYY → sortable YYYYMMDD (returns "" if unparseable).
function brDateSortKey(s) {
  const m = String(s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}${m[2]}${m[1]}` : "";
}

// Does a "Tipo Titulo" string match the slug's bond kind + coupon flag?
function tipoMatchesSlug(tipo, p) {
  const t = String(tipo || "").toLowerCase();
  if (p.kind && !t.includes(p.kind)) return false;
  const tipoJuros = /juros\s+semestrais/.test(t);
  if (tipoJuros !== p.hasJuros) return false;
  return true;
}

// Query the CKAN datastore (structured search) for one bond's price history,
// filtering by maturity date; we disambiguate the bond type in code because
// the exact "Tipo Titulo" label varies and datastore filters are exact-match.
async function fetchTesouroCKAN(p) {
  const filters = JSON.stringify({ "Data Vencimento": p.maturityBR });
  const url =
    `https://www.tesourotransparente.gov.br/ckan/api/3/action/datastore_search` +
    `?resource_id=${TESOURO_RESOURCE_ID}&limit=100000&filters=${encodeURIComponent(filters)}`;
  const r = await fetchWithRetry(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
  });
  let body = null;
  try {
    body = await r.json();
  } catch (e) {
    body = { _parseError: e.message };
  }
  const records = Array.isArray(body?.result?.records) ? body.result.records : [];
  return { status: r.status, ok: r.ok && body?.success !== false, records, body, url };
}

// From all records for a maturity date, pick the most recent one matching the kind.
function pickLatestTesouroRecord(records, p) {
  let best = null;
  let bestKey = "";
  for (const rec of records) {
    if (!tipoMatchesSlug(rec["Tipo Titulo"], p)) continue;
    const key = brDateSortKey(rec["Data Base"]);
    if (key >= bestKey) {
      bestKey = key;
      best = rec;
    }
  }
  return best;
}

// Diagnostic: shows upstream status and the matched record.
async function debugTesouro(slug) {
  const p = parseTesouroSlug(slug);
  if (!p || !p.kind) {
    return { requestedSlug: slug, error: "Unrecognized Tesouro slug", parsed: p };
  }
  const { status, ok, records, body, url } = await fetchTesouroCKAN(p);
  const rec = pickLatestTesouroRecord(records, p);
  return {
    requestedSlug: slug,
    parsed: p,
    upstreamStatus: status,
    upstreamOk: ok,
    recordCount: records.length,
    distinctTipos: Array.from(new Set(records.map((r) => r["Tipo Titulo"]).filter(Boolean))),
    matched: rec
      ? {
          tipo: rec["Tipo Titulo"],
          dataBase: rec["Data Base"],
          sellPriceRaw: rec["PU Venda Manha"],
          sellPrice: parseBRNumber(rec["PU Venda Manha"]),
        }
      : null,
    url,
    rawSnippet: records.length === 0 ? JSON.stringify(body).slice(0, 600) : undefined,
  };
}

async function handleTesouro(slug, brapiKey, finnhubKey) {
  const p = parseTesouroSlug(slug);
  if (!p || !p.kind) throw new Error("Unrecognized Tesouro slug");
  const { ok, status, records } = await fetchTesouroCKAN(p);
  if (!ok) throw new Error(`tesouro source ${status}`);
  const rec = pickLatestTesouroRecord(records, p);
  const sellPrice = parseBRNumber(rec?.["PU Venda Manha"]);
  if (!rec || sellPrice == null) {
    throw new Error("Treasury bond not found");
  }
  const brlPerUsd = await fetchUsdBrlRate(brapiKey, finnhubKey);
  return {
    price: sellPrice / brlPerUsd,
    currency: "USD",
    originalCurrency: "BRL",
    originalPrice: sellPrice,
    fxRate: brlPerUsd,
    source: "tesouro-transparente",
    market: "B3",
  };
}

async function handleBrazilian(ticker, brapiKey, finnhubKey, quoteOnly = false) {
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
    assetClass: brl.sector || "Brazilian Equity",
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
    assetClass: industry || "Uncategorized",
    industry,
    sector: industry,
    market: "US",
  };
}

export default async function handler(req, res) {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const finnhubKey = process.env.FINNHUB_API_KEY;
  const brapiKey = process.env.BRAPI_API_KEY || null;

  if (!finnhubKey) {
    return res.status(500).json({ error: "FINNHUB_API_KEY not configured" });
  }

  // Tesouro Direto slugs (e.g. "tesouro-selic-01032027") are lowercase, hyphenated,
  // and longer than the B3/US ticker format — detect them before the standard validation.
  const tesouroRaw = (req.query.ticker || "").toString().trim();
  if (/^tesouro-/i.test(tesouroRaw)) {
    // Diagnostic mode: ?debug=1 returns what brapi actually sends (no price math).
    if (req.query.debug === "1" || req.query.debug === "true") {
      try {
        const info = await debugTesouro(tesouroRaw.toLowerCase());
        return res.status(200).json(info);
      } catch (e) {
        return res.status(200).json({ error: e.message || "debug failed" });
      }
    }
    try {
      const payload = await handleTesouro(tesouroRaw.toLowerCase(), brapiKey, finnhubKey);
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.status(200).json(payload);
    } catch (e) {
      // Surface the real reason (upstream status / parse / not found) to aid debugging.
      return res.status(404).json({ error: e.message || "Treasury bond not found" });
    }
  }

  const tickerRaw = (req.query.ticker || "").toString().toUpperCase().trim();
  if (!tickerRaw || !/^[A-Z0-9.\-]{1,12}$/.test(tickerRaw)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }

  // quoteOnly=1: client signals it already has name/industry/sector cached.
  // We skip the profile + search endpoints entirely, saving ~2/3 of Finnhub calls.
  const quoteOnly = req.query.quoteOnly === "1" || req.query.quoteOnly === "true";

  try {
    let payload;
    if (isBrazilianTicker(tickerRaw)) {
      payload = await handleBrazilian(tickerRaw, brapiKey, finnhubKey, quoteOnly);
    } else {
      payload = await handleUS(tickerRaw, finnhubKey, quoteOnly);
    }
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: e.message || "Fetch failed" });
  }
}
