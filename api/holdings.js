// Vercel serverless function — server-side holdings storage backed by Upstash Redis.
// GET  /api/holdings → loads the current holdings array (or null if never saved)
// PUT  /api/holdings → saves the entire holdings array (body: { holdings: [...] })
//
// Auth: APP_PASSWORD header (same as other endpoints).
// Storage key: derived from APP_PASSWORD so different passwords never collide.
//
// Required env vars:
// - APP_PASSWORD
// - KV_REST_API_URL or UPSTASH_REDIS_REST_URL  (auto-set by Vercel Marketplace integration)
// - KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN

import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

// Build a Redis client from whichever env vars are available.
function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// Hash the password to a stable key so we never store the raw password in keys.
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
      error: "Redis not configured. Add the Upstash Redis integration in Vercel Marketplace.",
    });
  }

  const key = storageKey(providedPassword);

  try {
    if (req.method === "GET") {
      const value = await redis.get(key);
      // Upstash auto-deserializes JSON values
      if (value == null) {
        return res.status(200).json({ holdings: null, exists: false });
      }
      // value may be the array directly or wrapped in { holdings, savedAt }
      const wrapped =
        Array.isArray(value)
          ? { holdings: value }
          : (value && typeof value === "object" ? value : { holdings: null });
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
      // Cap to avoid abuse — a personal portfolio shouldn't exceed this.
      if (holdings.length > 500) {
        return res.status(413).json({ error: "Too many holdings (max 500)" });
      }
      const payload = { holdings, savedAt: new Date().toISOString() };
      await redis.set(key, payload);
      return res.status(200).json({ ok: true, savedAt: payload.savedAt, count: holdings.length });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Storage error" });
  }
}
