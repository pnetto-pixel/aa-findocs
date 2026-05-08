export default async function handler(req, res) {
  const expectedPassword = process.env.APP_PASSWORD;
  const providedPassword = req.headers["x-app-password"];

  if (!expectedPassword) {
    return res.status(500).json({ error: "APP_PASSWORD not configured" });
  }
  if (providedPassword !== expectedPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "FINNHUB_API_KEY not configured" });
  }

  const ticker = (req.query.ticker || "").toString().toUpperCase().trim();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }

  try {
    const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`;
    const r = await fetch(quoteUrl);
    if (!r.ok) {
      return res.status(502).json({ error: `Finnhub returned ${r.status}` });
    }
    const data = await r.json();
    if (!data || data.c == null || data.c === 0) {
      return res.status(404).json({ error: `No data for "${ticker}"` });
    }

    let name = ticker;
    try {
      const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`;
      const pr = await fetch(profileUrl);
      if (pr.ok) {
        const profile = await pr.json();
        if (profile && profile.name) name = profile.name;
      }
    } catch (e) {}

    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).json({
      price: data.c,
      name,
      currency: "USD",
      previousClose: data.pc ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Fetch failed" });
  }
}
