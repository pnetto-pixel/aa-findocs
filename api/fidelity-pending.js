// api/fidelity-pending.js
//
// USER-authenticated companion to api/ingest-fidelity.js (item 38).
// The scraper writes staged trades via the service-token endpoint; THIS endpoint
// lets the logged-in user (Google/password auth) read and clear that staging area
// from inside the app. Approval (merging into live transactions) happens client-side
// through the existing persist() path, so holdings sync keeps working unchanged.
//
// Reads/writes ONLY the `:fidelity-pending` key. Never modifies `:transactions`
// or `:holdings` here.
//
//   GET     -> { transactions, bondIncome, updatedAt }
//   DELETE  -> clears the staging area (after the client has approved/discarded)

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

function pendingKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':fidelity-pending');
}

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const pendingKey = pendingKeyFromAuth(auth);
  if (!pendingKey) {
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
      let pending = {};
      const raw = await redis.get(pendingKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') pending = parsed;
        } catch {}
      }
      return res.status(200).json({
        ok: true,
        transactions: Array.isArray(pending.transactions) ? pending.transactions : [],
        bondIncome: Array.isArray(pending.bondIncome) ? pending.bondIncome : [],
        updatedAt: pending.updatedAt || null,
      });
    }

    if (req.method === 'DELETE') {
      await redis.del(pendingKey);
      return res.status(200).json({ ok: true, cleared: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('fidelity-pending handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
