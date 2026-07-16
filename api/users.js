// api/users.js
// Admin-only allowlist management.
// GET: { users: [{ email, role }] }
// POST { email }: add to Redis allowlist
// DELETE { email }: remove from allowlist + delete portfolio data

import { getRedis } from '../lib/redis.js';
import { authenticate, emailStorageKey } from '../lib/auth.js';

const ALLOWLIST_KEY = 'portfolio:allowlist';

function getEnvList(name) {
  const raw = process.env[name] || '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  if (!auth.admin) {
    return res.status(403).json({ error: 'Admin only' });
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    return res.status(503).json({ error: `Storage unavailable: ${err.message}` });
  }

  try {
    if (req.method === 'GET') {
      const redisEmails = await redis.smembers(ALLOWLIST_KEY);
      const envEmails = getEnvList('ALLOWED_EMAILS');
      const adminEmails = getEnvList('ADMIN_EMAILS');

      const map = new Map();
      for (const e of adminEmails) map.set(e, { email: e, role: 'admin' });
      for (const e of envEmails) {
        if (!map.has(e)) map.set(e, { email: e, role: 'env' });
      }
      for (const e of redisEmails.map((x) => x.toLowerCase())) {
        if (!map.has(e)) map.set(e, { email: e, role: 'invited' });
      }

      const users = Array.from(map.values()).sort((a, b) =>
        a.email.localeCompare(b.email)
      );
      return res.status(200).json({ users });
    }

    if (req.method === 'POST') {
      const { email } = req.body || {};
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email required' });
      }
      const normalized = email.trim().toLowerCase();
      if (!isValidEmail(normalized)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      await redis.sadd(ALLOWLIST_KEY, normalized);
      return res.status(200).json({ ok: true, email: normalized });
    }

    if (req.method === 'DELETE') {
      const { email } = req.body || {};
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email required' });
      }
      const normalized = email.trim().toLowerCase();

      const admins = getEnvList('ADMIN_EMAILS');
      if (admins.includes(normalized)) {
        return res.status(400).json({ error: 'Cannot remove admin' });
      }

      await redis.srem(ALLOWLIST_KEY, normalized);

      // Remove ALL of the user's data, not just :holdings — transactions,
      // contributions-history, alerts-read, fidelity-pending and any
      // versioned caches (:perf-history:*, :dividends:*) share the same
      // `portfolio:email:<hash>:` prefix.
      const prefix = emailStorageKey(normalized).replace(/:holdings$/, '');
      let cursor = '0';
      let deleted = 0;
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          `${prefix}:*`,
          'COUNT',
          100
        );
        cursor = next;
        if (keys.length > 0) {
          deleted += await redis.del(...keys);
        }
      } while (cursor !== '0');

      return res.status(200).json({ ok: true, deletedKeys: deleted });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('users handler error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
