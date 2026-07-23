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
// ?resource=sync / ?resource=status route to SimpleFin feed operations (see
// docs/plans/simplefin-fidelity-feed.md) instead of adding new files under
// api/ — the Vercel Hobby plan caps a deployment at 12 Serverless Functions
// (same rationale as api/contributions-history.js's ?resource routes).
// (?resource=probe, the Fase 0 raw-payload diagnostic, was removed in the
// SimpleFin Fase 3 cleanup once the sync path proved reliable — see §6.)
//
// ?resource=sync (Fase 1): fetches SimpleFin for real, maps the payload via
// lib/simplefin-map.js, and merges the result into the `:fidelity-pending`
// staging blob (deduped against both live transactions/bondIncome and
// whatever's already staged). Admin-only (same access-URL-holder assumption —
// see docs/plans/simplefin-fidelity-feed.md §4.2). Throttled to one real
// SimpleFin fetch per SYNC_THROTTLE_MS; calls inside the window return the
// current staging state without re-fetching.
//   POST -> { ok, synced, throttled, added, addedBond, addedBalance, addedUnmapped, lastSync, lastError, nextSyncAt }
//
// ?resource=status: cheap read of sync metadata, no fetch.
//   GET -> { connected, lastSync, lastError, nextSyncAt }
//
// A SimpleFin connection returns EVERY linked institution, not just Fidelity
// (confirmed jul/2026: 22 accounts, only 1 Fidelity — 21 personal Chase/
// Capital One accounts). The sync mapper (lib/simplefin-map.js) filters to
// Fidelity internally and never touches other accounts' holdings/transactions.
// This filter is load-bearing, not cosmetic — it's the only thing standing
// between this endpoint and leaking unrelated personal banking data.

import { getRedis } from '../lib/redis.js';
import { authenticate } from '../lib/auth.js';
import { mapSimplefinPayload } from '../lib/simplefin-map.js';
import { buildKnownBondsByDescKey } from '../lib/bond-meta.js';

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
    // Bank Bonds reconciliation (item 41, fatia 1): `bondHoldings` is normal
    // sync staging (recomputed/replaced every sync, safe to discard/refresh).
    // `bondBindings` (descKey -> CUSIP) is CONFIRMED data (auto-bound or
    // manually confirmed by the user in the Bond Matching UI) — it must
    // survive DELETE (see the DELETE handler below) and is only ever merged,
    // never wholesale-replaced, by PUT.
    bondHoldings: Array.isArray(pending.bondHoldings) ? pending.bondHoldings : [],
    bondBindings:
      pending.bondBindings && typeof pending.bondBindings === 'object' && !Array.isArray(pending.bondBindings)
        ? pending.bondBindings
        : {},
    updatedAt: pending.updatedAt || null,
    lastSync: pending.lastSync || null,
    lastError: pending.lastError || null,
    lastSyncAttempt: pending.lastSyncAttempt || null,
  };
}

// Stable key for a staged bond holding: its descKey when the description
// parsed (extractBondMeta), else a normalized-raw-description fallback so
// holdings SimpleFin describes in an unexpected format can still be upserted
// across syncs and manually bound in the UI (rather than silently dropped or
// duplicated every 6h).
function bondHoldingKey(h) {
  if (h.descKey) return h.descKey;
  return `raw:${String(h.description || '').trim().toUpperCase().replace(/\s+/g, ' ')}`;
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
        addedBondBindings: 0,
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

  // Live transactions/bondIncome are read ONLY to skip rows already imported
  // (or already approved from a previous sync) — and, for `liveTx`, to also
  // build `knownBondsByDescKey` below (bond INTEREST auto-resolution needs to
  // know which CUSIPs the user already has a Bank Bonds buy for). Never
  // written here. Read before mapSimplefinPayload so that map can use it.
  const live = readBlob(await redis.get(txKey));
  const liveTx = Array.isArray(live.transactions) ? live.transactions : [];
  const liveBond = Array.isArray(live.bondIncome) ? live.bondIncome : [];
  const knownBondsByDescKey = buildKnownBondsByDescKey(liveTx);
  const mapped = mapSimplefinPayload(payload, { knownBondsByDescKey });
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

  // Bond holdings staging — normal upsert-by-key, same pattern as
  // balanceCandidates (a snapshot, not a growing log): a re-sync refreshes
  // the description/market value instead of accumulating stale duplicates.
  const bondHoldingsByKey = new Map(pending.bondHoldings.map((h) => [bondHoldingKey(h), h]));
  for (const h of mapped.bondHoldings) {
    bondHoldingsByKey.set(bondHoldingKey(h), h);
  }
  const pendingBondHoldings = [...bondHoldingsByKey.values()];

  // Bond bindings auto-bind: for every staged holding whose description
  // parsed to a descKey, check whether the user already has a Bank Bonds buy
  // transaction for that exact issuer+coupon+maturity (knownBondsByDescKey,
  // built above from live transactions). When it does, the binding is
  // unambiguous — auto-confirm it so the "Bond Matching" UI only ever asks
  // the user about the holdings that genuinely lack a resolvable buy (the
  // 7 older, pre-CUSIP-metadata bonds this feature exists for). Never
  // overwrites an existing binding (manual or automatic) already confirmed.
  const bondBindings = { ...pending.bondBindings };
  let addedBondBindings = 0;
  for (const h of mapped.bondHoldings) {
    if (!h.descKey) continue;
    if (bondBindings[h.descKey]) continue;
    const cusip = knownBondsByDescKey.get(h.descKey);
    if (cusip) {
      bondBindings[h.descKey] = cusip;
      addedBondBindings++;
    }
  }

  const updatedAt = new Date().toISOString();
  const next = {
    transactions: pendingTx,
    bondIncome: pendingBond,
    balanceCandidates: pendingBalance,
    unmapped: pendingUnmapped,
    bondHoldings: pendingBondHoldings,
    bondBindings,
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
    addedBondBindings,
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
      // bondBindings is confirmed data (auto or manual) — merged key-by-key,
      // never wholesale-replaced, so a client PATCHing one new manual bind
      // (`{ bondBindings: { [descKey]: cusip } }`) can never accidentally
      // drop a previously confirmed binding it doesn't know about.
      const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
      const next = {
        ...current,
        ...(Array.isArray(body.transactions) && { transactions: body.transactions }),
        ...(Array.isArray(body.bondIncome) && { bondIncome: body.bondIncome }),
        ...(Array.isArray(body.balanceCandidates) && { balanceCandidates: body.balanceCandidates }),
        ...(Array.isArray(body.unmapped) && { unmapped: body.unmapped }),
        ...(Array.isArray(body.bondHoldings) && { bondHoldings: body.bondHoldings }),
        ...(isPlainObject(body.bondBindings) && {
          bondBindings: { ...current.bondBindings, ...body.bondBindings },
        }),
        updatedAt: new Date().toISOString(),
      };
      await redis.set(pendingKey, JSON.stringify(next));
      return res.status(200).json({ ok: true, ...next });
    }

    if (req.method === 'DELETE') {
      // bondBindings is confirmed data (auto-bound or manually confirmed by
      // the user), not disposable staging — it must survive the clear that
      // happens after the client approves/discards everything else. Every
      // other field (transactions, bondIncome, balanceCandidates, unmapped,
      // bondHoldings, sync metadata) is intentionally wiped: they're all
      // recomputed fresh on the next sync.
      const current = normalizePending(readBlob(await redis.get(pendingKey)));
      if (current.bondBindings && Object.keys(current.bondBindings).length > 0) {
        await redis.set(pendingKey, JSON.stringify({ bondBindings: current.bondBindings }));
      } else {
        await redis.del(pendingKey);
      }
      return res.status(200).json({ ok: true, cleared: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('fidelity-pending handler error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
