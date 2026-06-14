// api/contributions-history.js
// GET: { exists, history, savedAt, method, email, admin }
// PUT { month: "YYYY-MM", snapshot: {...} }: { ok, savedAt }
//   - Upserts a single month snapshot into the history map.
//   - Idempotent: always overwrites the given month with the freshest values.
//   - Only the CURRENT month should be PUT by the client on mount; past months
//     already stored are preserved untouched (read-modify-write of the map).
// Auth required (x-google-token or x-app-password).
//
// Storage: derives from auth.storageKey by swapping ":holdings" suffix for
// ":contributions-history". Keeps the holdings/transactions blobs untouched.
//
// Blob shape (JSON object keyed by "YYYY-MM"):
//   {
//     "2026-05": { monthlyFixed, dividends, dellSale, extras: [{name, amount}],
//                  planTotal, invested, savedAt },
//     ...
//   }

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

function historyKeyFromAuth(auth) {
  // auth.storageKey ends with ":holdings" — swap suffix.
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':contributions-history');
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const storageKey = historyKeyFromAuth(auth);
  if (!storageKey) {
    return res.status(500).json({ error: 'No storage key derived' });
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    return res.status(503).json({ error: `Storage unavailable: ${err.message}` });
  }

  try {
    if (req.method === 'GET') {
      const raw = await redis.get(storageKey);
      let history = {};
      let exists = false;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            history = parsed.history && typeof parsed.history === 'object'
              ? parsed.history
              : parsed;
            exists = true;
          }
        } catch {
          exists = false;
        }
      }
      // If wrapped form { history, savedAt } was stored, unwrap savedAt too.
      let savedAt = null;
      if (history && history.savedAt && history.history) {
        // defensive: should not happen, but guard
        savedAt = history.savedAt;
        history = history.history;
      }
      return res.status(200).json({
        exists,
        history,
        savedAt,
        method: auth.method,
        email: auth.email,
        admin: auth.admin,
      });
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const month = body.month;
      const snapshot = body.snapshot;
      if (typeof month !== 'string' || !MONTH_RE.test(month)) {
        return res.status(400).json({ error: 'month "YYYY-MM" required' });
      }
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return res.status(400).json({ error: 'snapshot object required' });
      }

      // Read-modify-write the map so past months are preserved.
      let history = {};
      try {
        const prev = await redis.get(storageKey);
        if (prev) {
          const parsed = JSON.parse(prev);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            history = parsed.history && typeof parsed.history === 'object'
              ? parsed.history
              : parsed;
          }
        }
      } catch {}

      const savedAt = new Date().toISOString();
      history[month] = { ...snapshot, savedAt };

      await redis.set(storageKey, JSON.stringify(history));
      return res.status(200).json({ ok: true, savedAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('contributions-history handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
