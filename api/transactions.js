// api/transactions.js
// GET: { exists, transactions, savedAt, method, email, admin }
// PUT { transactions }: { ok, savedAt }
// Auth required (x-google-token or x-app-password).
//
// Storage: derives from auth.storageKey by swapping ":holdings" suffix
// for ":transactions". Keeps the holdings blob untouched.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

function transactionsKeyFromAuth(auth) {
  // auth.storageKey ends with ":holdings" — swap suffix.
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':transactions');
}

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const storageKey = transactionsKeyFromAuth(auth);
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
      let transactions = null;
      let savedAt = null;
      let exists = false;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            transactions = parsed;
          } else if (parsed && Array.isArray(parsed.transactions)) {
            transactions = parsed.transactions;
            savedAt = parsed.savedAt || null;
          }
          exists = Array.isArray(transactions);
        } catch {
          exists = false;
        }
      }
      return res.status(200).json({
        exists,
        transactions: transactions || [],
        savedAt,
        method: auth.method,
        email: auth.email,
        admin: auth.admin,
      });
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const transactions = body.transactions;
      if (!Array.isArray(transactions)) {
        return res.status(400).json({ error: 'transactions array required' });
      }
      const savedAt = new Date().toISOString();
      const payload = JSON.stringify({ transactions, savedAt });
      await redis.set(storageKey, payload);
      return res.status(200).json({ ok: true, savedAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('transactions handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
