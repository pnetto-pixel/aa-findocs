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
//
// ?resource=alerts-read routes to a second, unrelated state store (the Bell
// alert log's cross-device "read" state) instead of adding a 13th file under
// api/ — the Vercel Hobby plan caps a deployment at 12 Serverless Functions.
// GET: { exists, readIds, savedAt, method, email, admin }
// PUT { add: string[] }: { ok, savedAt, readIds }
//   - Read-modify-write: unions `add` into the stored set of read alert ids,
//     capped at the 200 most-recently-added ids.
// Storage: auth.storageKey with ":holdings" swapped for ":alerts-read".

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

function historyKeyFromAuth(auth) {
  // auth.storageKey ends with ":holdings" — swap suffix.
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':contributions-history');
}

function alertsReadKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':alerts-read');
}

const MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_READ_IDS = 200;

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  if (req.query?.resource === 'alerts-read') {
    return handleAlertsRead(req, res, auth);
  }
  return handleContributionsHistory(req, res, auth);
}

async function handleContributionsHistory(req, res, auth) {
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
    return res.status(500).json({ error: 'Internal error' });
  }
}

async function handleAlertsRead(req, res, auth) {
  const storageKey = alertsReadKeyFromAuth(auth);
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
      let readIds = [];
      let savedAt = null;
      let exists = false;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            readIds = Array.isArray(parsed.readIds) ? parsed.readIds : [];
            savedAt = parsed.savedAt || null;
            exists = true;
          } else if (Array.isArray(parsed)) {
            // Defensive: tolerate a bare array if ever written that way.
            readIds = parsed;
            exists = true;
          }
        } catch {
          exists = false;
        }
      }
      return res.status(200).json({
        exists,
        readIds,
        savedAt,
        method: auth.method,
        email: auth.email,
        admin: auth.admin,
      });
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const add = body.add;
      if (!Array.isArray(add)) {
        return res.status(400).json({ error: 'add array required' });
      }
      const addIds = add.filter((id) => typeof id === 'string' && id);

      // Read-modify-write: union the existing ids with the newly added ones.
      let existingIds = [];
      try {
        const prev = await redis.get(storageKey);
        if (prev) {
          const parsed = JSON.parse(prev);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            existingIds = Array.isArray(parsed.readIds) ? parsed.readIds : [];
          } else if (Array.isArray(parsed)) {
            existingIds = parsed;
          }
        }
      } catch {}

      // Keep the freshly-added ids first (most recent), then backfill with
      // existing ids not already included, capped at MAX_READ_IDS.
      const seen = new Set();
      const merged = [];
      for (const id of addIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
      }
      for (const id of existingIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
      }
      const readIds = merged.slice(0, MAX_READ_IDS);

      const savedAt = new Date().toISOString();
      await redis.set(storageKey, JSON.stringify({ readIds, savedAt }));
      return res.status(200).json({ ok: true, savedAt, readIds });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('alerts-read handler error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
