// api/alerts-read.js
// GET: { exists, readIds, savedAt, method, email, admin }
// PUT { add: string[] }: { ok, savedAt, readIds }
//   - Read-modify-write: unions `add` into the stored set of read alert ids,
//     then caps the result to the 200 most-recently-added ids (the ids in
//     `add` are treated as the freshest and kept first).
// Auth required (x-google-token or x-app-password).
//
// Storage: derives from auth.storageKey by swapping ":holdings" suffix for
// ":alerts-read". Keeps the holdings/transactions blobs untouched.
//
// This is a cross-device sync store for the "read" state of the Bell alert
// log (App.jsx alertLog), not a cache — no version suffix needed.
//
// Blob shape: { readIds: string[], savedAt }

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

const MAX_READ_IDS = 200;

function alertsReadKeyFromAuth(auth) {
  // auth.storageKey ends with ":holdings" — swap suffix.
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':alerts-read');
}

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

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
    return res.status(500).json({ error: err.message });
  }
}
