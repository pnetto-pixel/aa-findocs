// Vercel serverless function — server-side holdings storage backed by Redis (via ioredis TCP).
// Works with the Vercel Marketplace "Redis" integration that provides REDIS_URL.
//
// GET  /api/holdings → loads the current holdings array (or null if never saved)
// PUT  /api/holdings → saves the entire holdings array (body: { holdings: [...] })
//
// Auth: APP_PASSWORD header (same as other endpoints).
// Storage key: derived from APP_PASSWORD so different passwords never collide.
//
// Required env vars:
// - APP_PASSWORD
// - REDIS_URL (auto-set by Vercel Marketplace integration; rediss://default:<token>@<host>:<port>)

import Redis from "ioredis";
import crypto from "node:crypto";

// Singleton Redis client across warm function invocations.
let redisClient = null;
function getRedis() {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  redisClient = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    connectTimeout: 5000,
    lazyConnect: false,
  });
  // Silence unhandled error events on the client
  redisClient.on("error", (err) => {
    console.error("[redis] error:", err.message);
  });
  return redisClient;
}

function storageKey(password) {
  const hash = crypto.createHash("sha256").update(password).digest("hex").slice(0, 16);
  return `portfolio:${hash}:holdings`;
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

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({
      error: "Redis not configured. Add the Redis integration in Vercel Marketplace.",
    });
  }

  const key = storageKey(providedPassword);

  try {
    if (req.method === "GET") {
      const raw = await redis.get(key);
      if (raw == null) {
        return res.status(200).json({ holdings: null, exists: false });
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return res.status(500).json({ error: "Stored data is not valid JSON" });
      }
      const wrapped =
        Array.isArray(parsed)
          ? { holdings: parsed }
          : (parsed && typeof parsed === "object" ? parsed : { holdings: null });
      return res.status(200).json({ ...wrapped, exists: true });
    }

    if (req.method === "PUT" || req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (e) {
          return res.status(400).json({ error: "Invalid JSON body" });
        }
      }
      const holdings = body?.holdings;
      if (!Array.isArray(holdings)) {
        return res.status(400).json({ error: "Body must contain `holdings` array" });
      }
      if (holdings.length > 500) {
        return res.status(413).json({ error: "Too many holdings (max 500)" });
      }
      const payload = { holdings, savedAt: new Date().toISOString() };
      await redis.set(key, JSON.stringify(payload));
      return res.status(200).json({ ok: true, savedAt: payload.savedAt, count: holdings.length });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Storage error" });
  }
}
