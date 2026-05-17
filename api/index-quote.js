// Lightweight index quote endpoint — used for S&P 500 ticker (SPY) reference card.
// Same auth as /api/price. Uses Finnhub quote endpoint with retry.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options = {}, maxAttempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(600 * Math.pow(2, attempt - 1));
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
  if (!finnhubKey) {
    return res.status(500).json({ error: "FINNHUB_API_KEY not configured" });
  }

  const symbol = (req.query.symbol || "SPY").toString().toUpperCase().trim();
  if (!/^[A-Z0-9.\-^]{1,12}$/.test(symbol)) {
    return res.status(400).json({ error: "Invalid symbol" });
  }

  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
      symbol
    )}&token=${finnhubKey}`;
    const r = await fetchWithRetry(url);
    if (!r.ok) throw new Error(`Finnhub ${r.status}`);
    const data = await r.json();
    if (!data || data.c == null || data.c === 0) {
      throw new Error(`No data for "${symbol}"`);
    }
    const price = data.c;
    const previousClose = data.pc ?? null;
    const dayChangePct =
      previousClose && previousClose !== 0 ? ((price - previousClose) / previousClose) * 100 : null;

    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).json({
      symbol,
      price,
      previousClose,
      dayChangePct,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message || "Fetch failed" });
  }
}
