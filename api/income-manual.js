// api/income-manual.js
// GET:  { exists, entries, savedAt }
// PUT { entries }: { ok, savedAt }
// Manual income entries: coupons (Tesouro, Bank Bonds), dividends/JCP (BRA Stocks).
// Storage key derived from auth.storageKey by swapping ":holdings" for ":income-manual".

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

function incomeManualKey(auth) {
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':income-manual');
}

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const storageKey = incomeManualKey(auth);
  if (!storageKey) return res.status(500).json({ error: 'No storage key derived' });

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    return res.status(503).json({ error: `Storage unavailable: ${err.message}` });
  }

  try {
    if (req.method === 'GET') {
      const raw = await redis.get(storageKey);
      let entries = [];
      let savedAt = null;
      let exists = false;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            entries = parsed;
          } else if (parsed && Array.isArray(parsed.entries)) {
            entries = parsed.entries;
            savedAt = parsed.savedAt || null;
          }
          exists = true;
        } catch {}
      }
      return res.status(200).json({ exists, entries, savedAt });
    }

    if (req.method === 'PUT') {
      const { entries } = req.body || {};
      if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array required' });
      const savedAt = new Date().toISOString();
      await redis.set(storageKey, JSON.stringify({ entries, savedAt }));
      return res.status(200).json({ ok: true, savedAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('income-manual handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
