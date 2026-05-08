export default async function handler(req, res) {
  const expectedPassword = process.env.APP_PASSWORD;
  const providedPassword = req.headers["x-app-password"];

  if (!expectedPassword) {
    return res.status(500).json({ error: "APP_PASSWORD not configured" });
  }
  if (providedPassword !== expectedPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const ticker = (req.query.ticker || "").toString().toUpperCase().trim();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }

  // Try Stooq first (more reliable from cloud IPs)
  const stooqSymbol = ticker.includes(".") ? ticker.toLowerCase() : `${ticker.toLowerCase()}.us`;
  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcvn&h&e=csv`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (r.ok) {
      const text = await r.text();
      const lines = text.trim().split("\n");
      if (lines.length >= 2) {
        const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
        const values = lines[1].split(",").map((v) => v.trim());
        const closeIdx = headers.indexOf("close");
        const nameIdx = headers.indexOf("name");
        const close = parseFloat(values[closeIdx]);
        if (!isNaN(close) && close > 0) {
          res.setHeader("Cache-Control", "private, max-age=60");
          return res.status(200).json({
            price: close,
            name: nameIdx >= 0 ? values[nameIdx] : ticker,
            currency: "USD",
          });
        }
      }
    }
  } catch (e) {}

  // Fallback to Yahoo
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!r.ok) {
      return res.status(502).json({ error: `No data for "${ticker}"` });
    }
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) {
      return res.status(404).json({ error: `No data for "${ticker}"` });
    }
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).json({
      price: meta.regularMarketPrice,
      name: meta.shortName || meta.longName || ticker,
      currency: meta.currency || "USD",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Fetch failed" });
  }
}
