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
//
// ?resource=probe routes to a second, unrelated operation (SimpleFin feed plan,
// Fase 0 — see docs/plans/simplefin-fidelity-feed.md) instead of adding a 13th
// file under api/ — the Vercel Hobby plan caps a deployment at 12 Serverless
// Functions (same rationale as api/contributions-history.js's ?resource routes).
// Read-only inspection of the raw SimpleFin `/accounts` payload so the shape
// (qty/price on transactions? holdings array? description format?) can be
// confirmed before writing the real mapper. Never touches Redis. Admin-only.
//   GET -> { ok, fetchedAt, simplefinErrors, accountCount, accounts: [...] }
// A SimpleFin connection returns EVERY linked institution, not just Fidelity
// (confirmed jul/2026: 22 accounts, only 1 Fidelity — 21 personal Chase/
// Capital One accounts). Non-Fidelity accounts only get metadata (balance/
// counts) in the response; only the Fidelity account(s) get full holdings/
// transactions detail. This filter is load-bearing, not cosmetic — it's the
// only thing standing between this endpoint and leaking unrelated personal
// banking data. The real mapper (Fase 1) must apply the same filter.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';

function pendingKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':fidelity-pending');
}

const PROBE_TIMEOUT_MS = 8000;
const PROBE_WINDOW_DAYS = 90;
const PROBE_MAX_ACCOUNTS = 50;
// Fidelity accounts get full detail (not just a sample) — a real probe run
// (jul/2026) showed a SimpleFin connection returns EVERY linked institution,
// not just Fidelity (22 accounts, only 1 was Fidelity — the other 21 were
// personal Chase/Capital One banking). Non-Fidelity accounts get metadata
// only (balance/counts), never transaction or holding detail, so this
// diagnostic endpoint doesn't surface unrelated personal spending data.
const PROBE_FIDELITY_MAX_ITEMS = 200;
const FIDELITY_ORG_HINTS = ['fidelity'];

function isFidelityOrg(org) {
  const haystack = `${org?.name || ''} ${org?.domain || ''}`.toLowerCase();
  return FIDELITY_ORG_HINTS.some((hint) => haystack.includes(hint));
}

// SimpleFin access URLs embed Basic Auth credentials in the userinfo part
// (https://user:pass@bridge.simplefin.org/simplefin/...). Some fetch
// implementations don't forward userinfo automatically, so extract it and
// send an explicit Authorization header against the credential-stripped URL.
function parseSimplefinUrl(raw) {
  const u = new URL(raw);
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  return {
    url: u.toString(),
    authHeader: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
  };
}

function unixToISO(sec) {
  if (typeof sec !== 'number' || !isFinite(sec)) return null;
  try {
    return new Date(sec * 1000).toISOString();
  } catch {
    return null;
  }
}

async function handleProbe(req, res, auth) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!auth.admin) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const rawUrl = process.env.SIMPLEFIN_ACCESS_URL;
  if (!rawUrl) {
    return res.status(503).json({ error: 'SimpleFin not configured (SIMPLEFIN_ACCESS_URL unset)' });
  }

  let url, authHeader;
  try {
    ({ url, authHeader } = parseSimplefinUrl(rawUrl));
  } catch {
    return res.status(500).json({ error: 'SIMPLEFIN_ACCESS_URL is malformed' });
  }

  const startDate = Math.floor((Date.now() - PROBE_WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000);
  const accountsUrl = `${url.replace(/\/+$/, '')}/accounts?start-date=${startDate}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  let payload;
  try {
    const upstream = await fetch(accountsUrl, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      return res.status(502).json({
        error: `SimpleFin returned HTTP ${upstream.status}`,
      });
    }
    payload = await upstream.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'SimpleFin request timed out' });
    }
    return res.status(502).json({ error: `SimpleFin fetch failed: ${err.message}` });
  } finally {
    clearTimeout(timeout);
  }

  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const summarized = accounts.slice(0, PROBE_MAX_ACCOUNTS).map((acct) => {
    const org = acct.org ? { name: acct.org.name, domain: acct.org.domain } : null;
    const holdings = Array.isArray(acct.holdings) ? acct.holdings : [];
    const transactions = Array.isArray(acct.transactions) ? acct.transactions : [];
    const base = {
      id: acct.id,
      name: acct.name,
      currency: acct.currency,
      org,
      balance: acct.balance,
      availableBalance: acct['available-balance'],
      balanceDate: acct['balance-date'],
      balanceDateISO: unixToISO(acct['balance-date']),
      holdingsCount: holdings.length,
      transactionsCount: transactions.length,
    };
    if (!isFidelityOrg(org)) {
      // Metadata only — no holdings/transaction detail for unrelated
      // institutions linked to the same SimpleFin connection.
      return base;
    }
    const sortedTx = [...transactions].sort(
      (a, b) => (b.posted || b.transacted_at || 0) - (a.posted || a.transacted_at || 0)
    );
    return {
      ...base,
      holdingsSample: holdings.slice(0, PROBE_FIDELITY_MAX_ITEMS),
      transactionsSample: sortedTx.slice(0, PROBE_FIDELITY_MAX_ITEMS).map((tx) => ({
        ...tx,
        postedISO: unixToISO(tx.posted),
        transactedAtISO: unixToISO(tx.transacted_at),
      })),
    };
  });

  return res.status(200).json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    simplefinErrors: Array.isArray(payload?.errors) ? payload.errors : [],
    accountCount: accounts.length,
    accounts: summarized,
  });
}

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  if (req.query?.resource === 'probe') {
    return handleProbe(req, res, auth);
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
    return res.status(500).json({ error: 'Internal error' });
  }
}
