// api/ingest-fidelity.js
//
// ADDITIVE / DORMANT endpoint for the Fidelity export automation (item 38).
// It NEVER touches the live `:transactions` or `:holdings` blobs. Parsed trades
// land in a separate staging key (`:fidelity-pending`); the user reviews and
// approves them inside the app before anything reaches live data.
//
// Auth: a single shared service token (env INGEST_TOKEN), NOT a logged-in user.
//   - INGEST_TOKEN unset  -> 503 (endpoint is inert until you opt in)
//   - wrong/absent token  -> 401
// Target account: derived from env INGEST_EMAIL (config, not request) so a leaked
// token can only ever write to YOUR own pending area, never redirect to another.
//
// Methods:
//   POST   { transactions: [...], bondIncome?: [...] }  -> merge into pending (deduped)
//   GET                                                  -> read pending (troubleshooting)
//   DELETE                                               -> clear pending (reset)

import { getRedis } from '../lib/redis.js';
import { emailStorageKey, constantTimeEqual } from '../lib/auth.js';

// Mirrors dupKey(tx) in src/Transactions.jsx so server-side dedupe matches the app.
function dupKey(tx) {
  const tk = String(tx.ticker || '').trim().toUpperCase();
  return `${tk}|${tx.side}|${Number(tx.qty)}|${tx.date}`;
}

function bondKey(ev) {
  const tk = String(ev.ticker || '').trim().toUpperCase();
  return `${ev.date}|${tk}|${Number(ev.amount)}|${ev.kind || ''}`;
}

function readBlob(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    // Dormant by design: nothing happens until you set INGEST_TOKEN in Vercel.
    return res.status(503).json({ error: 'Ingestion disabled (INGEST_TOKEN not configured)' });
  }

  const provided = req.headers['x-ingest-token'] || req.headers['X-Ingest-Token'];
  if (!constantTimeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Invalid ingest token' });
  }

  const email = process.env.INGEST_EMAIL;
  if (!email) {
    return res.status(500).json({ error: 'INGEST_EMAIL not configured' });
  }

  const holdingsKey = emailStorageKey(email);
  const pendingKey = holdingsKey.replace(/:holdings$/, ':fidelity-pending');
  const txKey = holdingsKey.replace(/:holdings$/, ':transactions');

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    return res.status(503).json({ error: `Storage unavailable: ${err.message}` });
  }

  try {
    if (req.method === 'GET') {
      const pending = readBlob(await redis.get(pendingKey));
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

    if (req.method === 'POST') {
      const body = req.body || {};
      const incoming = Array.isArray(body.transactions) ? body.transactions : null;
      if (!incoming) {
        return res.status(400).json({ error: 'transactions array required' });
      }
      const incomingBond = Array.isArray(body.bondIncome) ? body.bondIncome : [];

      // Live transactions are read ONLY to skip rows already imported. Never written.
      const live = readBlob(await redis.get(txKey));
      const liveTx = Array.isArray(live.transactions)
        ? live.transactions
        : Array.isArray(live)
          ? live
          : [];
      const liveKeys = new Set(liveTx.map(dupKey));

      const pending = readBlob(await redis.get(pendingKey));
      const pendingTx = Array.isArray(pending.transactions) ? pending.transactions : [];
      const pendingBond = Array.isArray(pending.bondIncome) ? pending.bondIncome : [];
      const pendingKeys = new Set(pendingTx.map(dupKey));

      let added = 0;
      let alreadyLive = 0;
      let dupPending = 0;
      for (const tx of incoming) {
        const k = dupKey(tx);
        if (liveKeys.has(k)) { alreadyLive++; continue; }
        if (pendingKeys.has(k)) { dupPending++; continue; }
        pendingKeys.add(k);
        pendingTx.push(tx);
        added++;
      }

      const pendingBondKeys = new Set(pendingBond.map(bondKey));
      let addedBond = 0;
      for (const ev of incomingBond) {
        const k = bondKey(ev);
        if (pendingBondKeys.has(k)) continue;
        pendingBondKeys.add(k);
        pendingBond.push(ev);
        addedBond++;
      }

      const updatedAt = new Date().toISOString();
      await redis.set(
        pendingKey,
        JSON.stringify({ transactions: pendingTx, bondIncome: pendingBond, updatedAt })
      );

      // Status only — never echo trade contents or credentials.
      return res.status(200).json({
        ok: true,
        received: incoming.length,
        added,
        alreadyLive,
        dupPending,
        addedBond,
        totalPending: pendingTx.length,
        updatedAt,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('ingest-fidelity handler error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
