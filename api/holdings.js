// api/holdings.js
// GET: { exists, holdings, savedAt, method, email, admin }
// PUT { holdings }: { ok, savedAt }
// Auth required (x-google-token or x-app-password).

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

export default async function handler(req, res) {
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

  try {
    if (req.method === 'GET') {
      const raw = await redis.get(auth.storageKey);
      let holdings = null;
      let savedAt = null;
      let exists = false;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            holdings = parsed;
          } else if (parsed && Array.isArray(parsed.holdings)) {
            holdings = parsed.holdings;
            savedAt = parsed.savedAt || null;
          }
          exists = Array.isArray(holdings);
        } catch {
          exists = false;
        }
      }
      return res.status(200).json({
        exists,
        holdings,
        savedAt,
        method: auth.method,
        email: auth.email,
        admin: auth.admin,
      });
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const holdings = body.holdings;
      if (!Array.isArray(holdings)) {
        return res.status(400).json({ error: 'holdings array required' });
      }

      // Optimistic concurrency: when the client sends expectedSavedAt (the
      // savedAt it last read), reject the write if another device saved in
      // between — last-write-wins silently losing data across devices.
      // Clients that omit the field keep the old unconditional behavior.
      if ('expectedSavedAt' in body) {
        let currentSavedAt = null;
        try {
          const prev = await redis.get(auth.storageKey);
          if (prev) {
            const parsedPrev = JSON.parse(prev);
            if (parsedPrev && !Array.isArray(parsedPrev)) {
              currentSavedAt = parsedPrev.savedAt || null;
            }
          }
        } catch {}
        if (currentSavedAt && currentSavedAt !== (body.expectedSavedAt || null)) {
          return res.status(409).json({
            error: 'Conflict: data was modified on another device',
            savedAt: currentSavedAt,
          });
        }
      }

      const savedAt = new Date().toISOString();
      const payload = JSON.stringify({ holdings, savedAt });
      await redis.set(auth.storageKey, payload);
      return res.status(200).json({ ok: true, savedAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('holdings handler error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
