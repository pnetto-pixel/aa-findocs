// api/fidelity-pending.js
//
// USER-authenticated staging area for Fidelity trade import (item 38 origin).
// Originally paired with a service-token scraper endpoint (api/ingest-fidelity.js,
// removed in the SimpleFin Fase 3 cleanup — see docs/plans/simplefin-fidelity-feed.md
// section 6) that wrote staged trades from a headless browser scrape. That path is gone;
// staging is now populated exclusively by ?resource=sync below (SimpleFin Bridge).
// THIS endpoint lets the logged-in user (Google/password auth) read and clear that
// staging area from inside the app. Approval (merging into live transactions)
// happens client-side through the existing persist() path, so holdings sync keeps
// working unchanged.
//
// Reads/writes the `:fidelity-pending` key. Never modifies `:transactions`
// directly (only reads it, read-only, to skip rows already imported when
// deduping) and never modifies `:holdings` here.
//
//   GET     -> { transactions, bondIncome, balanceCandidates, unmapped, updatedAt, lastSync, lastError }
//   PUT     -> { transactions?, bondIncome?, balanceCandidates?, unmapped? } (partial;
//               read-modify-write, like api/transactions.js) — lets the client
//               remove approved/dismissed rows without wiping sync metadata or
//               the other arrays.
//   DELETE  -> clears the entire staging area (after the client has approved/discarded)
//
// ?resource=probe / ?resource=sync / ?resource=status route to SimpleFin feed
// operations (see docs/plans/simplefin-fidelity-feed.md) instead of adding new
// files under api/ — the Vercel Hobby plan caps a deployment at 12 Serverless
// Functions (same rationale as api/contributions-history.js's ?resource routes).
//
// ?resource=probe (Fase 0): read-only inspection of the raw SimpleFin `/accounts`
// payload. Never touches Redis. Admin-only.
//   GET -> { ok, fetchedAt, simplefinErrors, accountCount, accounts: [...] }
//
// ?resource=sync (Fase 1): fetches SimpleFin for real, maps the payload via
// lib/simplefin-map.js, and merges the result into the `:fidelity-pending`
// staging blob (deduped against both live transactions/bondIncome and
// whatever's already staged). Admin-only (same access-URL-holder assumption
// as the probe — see docs/plans/simplefin-fidelity-feed.md §4.2). Throttled to
// one real SimpleFin fetch per SYNC_THROTTLE_MS; calls inside the window
// return the current staging state without re-fetching.
//   POST -> { ok, synced, throttled, added, addedBond, addedBalance, addedUnmapped, lastSync, lastError, nextSyncAt }
//
// ?resource=status: cheap read of sync metadata, no fetch.
//   GET -> { connected, lastSync, lastError, nextSyncAt, simplefinErrors }
//
// A SimpleFin connection returns EVERY linked institution, not just Fidelity
// (confirmed jul/2026: 22 accounts, only 1 Fidelity — 21 personal Chase/
// Capital One accounts). Non-Fidelity accounts only get metadata (balance/
// counts) from the probe; the sync mapper (lib/simplefin-map.js) filters to
// Fidelity internally and never touches other accounts' holdings/transactions.
// This filter is load-bearing, not cosmetic — it's the only thing standing
// between this endpoint and leaking unrelated personal banking data.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';
import { mapSimplefinPayload, isFidelityOrg } from '../lib/simplefin-map.js';

function pendingKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':fidelity-pending');
}

function txKeyFromAuth(auth) {
  if (!auth?.storageKey) return null;
  return auth.storageKey.replace(/:holdings$/, ':transactions');
}

const SIMPLEFIN_TIMEOUT_MS = 8000;
// SimpleFin has a hard cap at 90 days (requesting exactly that got capped, per
// a warning seen in payload.errors) AND a lower "recommended" range of 45 days
// — going over 45 already produces a payload.errors advisory ("may be capped
// in the future") even though nothing is actually capped yet. Either warning
// becomes `lastError` here, which the Transactions tab and the sync heartbeat
// (Fase 3) both surface as if it were a real failure. Stay comfortably under
// the lower, "recommended" threshold so neither warning ever fires.
const SIMPLEFIN_WINDOW_DAYS = 44;
const SIMPLEFIN_MAX_ACCOUNTS = 50;
// Fidelity accounts get full detail (not just a sample) — a real probe run
// (jul/2026) showed a SimpleFin connection returns EVERY linked institution,
// not just Fidelity (22 accounts, only 1 was Fidelity — the other 21 were
// personal Chase/Capital One banking). Non-Fidelity accounts get metadata
// only (balance/counts), never transaction or holding detail, so this
// diagnostic endpoint doesn't surface unrelated personal spending data.
const PROBE_FIDELITY_MAX_ITEMS = 200;
// Sync is on-demand (button click), not a cron — but throttled server-side so
// a chatty client (or a user mashing the button) can't hammer the Bridge.
const SYNC_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h

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

  const startDate = Math.floor((Date.now() - SIMPLEFIN_WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000);
  const accountsUrl = `${url.replace(/\/+$/, '')}/accounts?start-date=${startDate}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIMPLEFIN_TIMEOUT_MS);

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
  const summarized = accounts.slice(0, SIMPLEFIN_MAX_ACCOUNTS).map((acct) => {
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

function readBlob(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePending(pending) {
  return {
    transactions: Array.isArray(pending.transactions) ? pending.transactions : [],
    bondIncome: Array.isArray(pending.bondIncome) ? pending.bondIncome : [],
    balanceCandidates: Array.isArray(pending.balanceCandidates) ? pending.balanceCandidates : [],
    unmapped: Array.isArray(pending.unmapped) ? pending.unmapped : [],
    updatedAt: pending.updatedAt || null,
    lastSync: pending.lastSync || null,
    lastError: pending.lastError || null,
    lastSyncAttempt: pending.lastSyncAttempt || null,
  };
}

// Mirrors dupKey(tx) in src/lib/parsing.js / src/Transactions.jsx so
// server-side dedupe matches the app.
function dupKey(tx) {
  const tk = String(tx.ticker || '').trim().toUpperCase();
  return `${tk}|${tx.side}|${Number(tx.qty)}|${tx.date}`;
}

function bondKey(ev) {
  const tk = String(ev.ticker || '').trim().toUpperCase();
  return `${ev.date}|${tk}|${Number(ev.amount)}|${ev.kind || ''}`;
}

async function handleStatus(req, res, auth) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
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
  const pending = normalizePending(readBlob(await redis.get(pendingKey)));
  const nextSyncAt = pending.lastSyncAttempt
    ? new Date(new Date(pending.lastSyncAttempt).getTime() + SYNC_THROTTLE_MS).toISOString()
    : null;
  return res.status(200).json({
    ok: true,
    connected: !!process.env.SIMPLEFIN_ACCESS_URL,
    lastSync: pending.lastSync,
    lastError: pending.lastError,
    nextSyncAt,
  });
}

async function handleSync(req, res, auth) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!auth.admin) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const pendingKey = pendingKeyFromAuth(auth);
  const txKey = txKeyFromAuth(auth);
  if (!pendingKey || !txKey) {
    return res.status(500).json({ error: 'No storage key derived' });
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    return res.status(503).json({ error: `Storage unavailable: ${err.message}` });
  }

  const pending = normalizePending(readBlob(await redis.get(pendingKey)));

  // Throttle: at most one real SimpleFin fetch per SYNC_THROTTLE_MS. Calls
  // inside the window return the current staging state without re-fetching —
  // polite to the Bridge, and the "Sync Fidelity" button can be safely mashed.
  if (pending.lastSyncAttempt) {
    const elapsed = Date.now() - new Date(pending.lastSyncAttempt).getTime();
    if (elapsed < SYNC_THROTTLE_MS) {
      return res.status(200).json({
        ok: true,
        synced: false,
        throttled: true,
        added: 0,
        addedBond: 0,
        addedBalance: 0,
        addedUnmapped: 0,
        lastSync: pending.lastSync,
        lastError: pending.lastError,
        nextSyncAt: new Date(new Date(pending.lastSyncAttempt).getTime() + SYNC_THROTTLE_MS).toISOString(),
        totalPending: pending.transactions.length,
      });
    }
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

  const startDate = Math.floor((Date.now() - SIMPLEFIN_WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000);
  const accountsUrl = `${url.replace(/\/+$/, '')}/accounts?start-date=${startDate}`;

  const attemptAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIMPLEFIN_TIMEOUT_MS);

  let payload;
  let fetchError = null;
  try {
    const upstream = await fetch(accountsUrl, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      fetchError = `SimpleFin returned HTTP ${upstream.status}`;
    } else {
      payload = await upstream.json();
    }
  } catch (err) {
    fetchError = err.name === 'AbortError' ? 'SimpleFin request timed out' : `SimpleFin fetch failed: ${err.message}`;
  } finally {
    clearTimeout(timeout);
  }

  if (fetchError) {
    // Persist the attempt + error so the throttle applies even to failures
    // (never hammer a slow/down Bridge) and ?resource=status can surface it.
    await redis.set(
      pendingKey,
      JSON.stringify({ ...pending, lastError: fetchError, lastSyncAttempt: attemptAt })
    );
    return res.status(502).json({ error: fetchError });
  }

  const simplefinErrors = Array.isArray(payload?.errors) ? payload.errors : [];
  const mapped = mapSimplefinPayload(payload);

  // Live transactions/bondIncome are read ONLY to skip rows already imported
  // (or already approved from a previous sync). Never written here.
  const live = readBlob(await redis.get(txKey));
  const liveTx = Array.isArray(live.transactions) ? live.transactions : [];
  const liveBond = Array.isArray(live.bondIncome) ? live.bondIncome : [];
  const liveTxKeys = new Set(liveTx.map(dupKey));
  const liveTxSimplefinIds = new Set(liveTx.filter((t) => t.simplefinId).map((t) => t.simplefinId));
  const liveBondKeys = new Set(liveBond.map(bondKey));
  const liveBondSimplefinIds = new Set(liveBond.filter((e) => e.simplefinId).map((e) => e.simplefinId));

  const pendingTx = [...pending.transactions];
  const pendingTxKeys = new Set(pendingTx.map(dupKey));
  const pendingTxSimplefinIds = new Set(pendingTx.filter((t) => t.simplefinId).map((t) => t.simplefinId));
  let added = 0;
  for (const tx of mapped.transactions) {
    if (tx.simplefinId && (liveTxSimplefinIds.has(tx.simplefinId) || pendingTxSimplefinIds.has(tx.simplefinId))) continue;
    const k = dupKey(tx);
    if (liveTxKeys.has(k) || pendingTxKeys.has(k)) continue;
    pendingTxKeys.add(k);
    if (tx.simplefinId) pendingTxSimplefinIds.add(tx.simplefinId);
    pendingTx.push(tx);
    added++;
  }

  const pendingBond = [...pending.bondIncome];
  const pendingBondKeys = new Set(pendingBond.map(bondKey));
  const pendingBondSimplefinIds = new Set(pendingBond.filter((e) => e.simplefinId).map((e) => e.simplefinId));
  let addedBond = 0;
  for (const ev of mapped.bondIncome) {
    if (ev.simplefinId && (liveBondSimplefinIds.has(ev.simplefinId) || pendingBondSimplefinIds.has(ev.simplefinId))) continue;
    const k = bondKey(ev);
    if (liveBondKeys.has(k) || pendingBondKeys.has(k)) continue;
    pendingBondKeys.add(k);
    if (ev.simplefinId) pendingBondSimplefinIds.add(ev.simplefinId);
    pendingBond.push(ev);
    addedBond++;
  }

  // Balance candidates are a snapshot, not a growing log — upsert by id
  // (one per account + kind) so a re-sync refreshes the proposed value
  // instead of accumulating stale duplicates.
  const balanceById = new Map(pending.balanceCandidates.map((c) => [c.id, c]));
  let addedBalance = 0;
  for (const c of mapped.balanceCandidates) {
    if (!balanceById.has(c.id)) addedBalance++;
    balanceById.set(c.id, c);
  }
  const pendingBalance = [...balanceById.values()];

  // Unmapped items are deduped by simplefinId so a re-sync doesn't pile up
  // the same unresolved row every 6h; never silently dropped, just not
  // repeated once already visible.
  const pendingUnmappedIds = new Set(pending.unmapped.filter((u) => u.simplefinId).map((u) => u.simplefinId));
  const pendingUnmapped = [...pending.unmapped];
  let addedUnmapped = 0;
  for (const u of mapped.unmapped) {
    if (u.simplefinId && pendingUnmappedIds.has(u.simplefinId)) continue;
    if (u.simplefinId) pendingUnmappedIds.add(u.simplefinId);
    pendingUnmapped.push(u);
    addedUnmapped++;
  }

  const updatedAt = new Date().toISOString();
  const next = {
    transactions: pendingTx,
    bondIncome: pendingBond,
    balanceCandidates: pendingBalance,
    unmapped: pendingUnmapped,
    updatedAt,
    lastSync: updatedAt,
    lastError: simplefinErrors.length ? simplefinErrors.join('; ') : null,
    lastSyncAttempt: attemptAt,
  };
  await redis.set(pendingKey, JSON.stringify(next));

  return res.status(200).json({
    ok: true,
    synced: true,
    throttled: false,
    added,
    addedBond,
    addedBalance,
    addedUnmapped,
    lastSync: next.lastSync,
    lastError: next.lastError,
    nextSyncAt: new Date(new Date(attemptAt).getTime() + SYNC_THROTTLE_MS).toISOString(),
    totalPending: pendingTx.length,
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
  if (req.query?.resource === 'status') {
    return handleStatus(req, res, auth);
  }
  if (req.query?.resource === 'sync') {
    return handleSync(req, res, auth);
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
      const pending = normalizePending(readBlob(await redis.get(pendingKey)));
      return res.status(200).json({ ok: true, ...pending });
    }

    if (req.method === 'PUT') {
      // Partial update: only the arrays present in the body are replaced.
      // Sync metadata (lastSync/lastError/lastSyncAttempt) is always
      // preserved — this endpoint is how the client removes approved/
      // dismissed rows after an approve/dismiss action without wiping
      // everything else staged.
      const body = req.body || {};
      const current = normalizePending(readBlob(await redis.get(pendingKey)));
      const next = {
        ...current,
        ...(Array.isArray(body.transactions) && { transactions: body.transactions }),
        ...(Array.isArray(body.bondIncome) && { bondIncome: body.bondIncome }),
        ...(Array.isArray(body.balanceCandidates) && { balanceCandidates: body.balanceCandidates }),
        ...(Array.isArray(body.unmapped) && { unmapped: body.unmapped }),
        updatedAt: new Date().toISOString(),
      };
      await redis.set(pendingKey, JSON.stringify(next));
      return res.status(200).json({ ok: true, ...next });
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
