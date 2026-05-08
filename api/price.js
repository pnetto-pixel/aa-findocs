// Vercel serverless function — proxies stock price requests to Yahoo Finance
// 100% free. Gates access via APP_PASSWORD so only you can use it.

export default async function handler(req, res) {
  // Password gate
  const expectedPassword = process.env.APP_PASSWORD;
  const providedPassword = req.headers["x-app-password"];

  if (!expectedPassword) {
    return res.status(500).json({ error: "APP_PASSWORD not configured on server" });
  }
  if (providedPassword !== expectedPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Validate ticker
  const ticker = (req.query.ticker || "").toString().toUpperCase().trim();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }

  try {
    // Yahoo Finance unofficial chart endpoint — free, no API key
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?range=1d&interval=1d`;

    const upstream = await fetch(url, {
      headers: {
        // Yahoo blocks default fetch user agents; this header is required
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!upstream.ok) {
      return res
        .status(502)
        .json({ error: `Yahoo returned ${upstream.status}` });
    }

    const data = await upstream.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;

    if (!meta || meta.regularMarketPrice == null) {
      return res
        .status(404)
        .json({ price: null, error: `No data for "${ticker}"` });
    }

    // Cache at the edge for 60s to reduce upstream load and speed up Refresh All
    res.setHeader("Cache-Control", "private, max-age=60");

    return res.status(200).json({
      price: meta.regularMarketPrice,
      name: meta.shortName || meta.longName || meta.symbol || ticker,
      currency: meta.currency || "USD",
      previousClose: meta.previousClose ?? null,
      exchange: meta.exchangeName || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown error" });
  }
}
