import { randomUUID } from "node:crypto";
import { PREFERENCE_DEFAULTS, validatePreferencePatch } from "../src/lib/rebalanceBudget.js";

import { compareAndSet } from "./redis-compare-and-set.js";

export async function handleHoldingsPreferences(req, res, auth, redis) {
  const key = auth.storageKey.replace(/:holdings$/, ":holdings-preferences:v1");
  if (key === auth.storageKey) throw new Error("Invalid preferences scope");
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET" && req.method !== "PUT") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const patch = req.method === "PUT" ? validatePreferencePatch(req.body?.patch) : null;
  const expected = req.body?.expectedRevision;
  if (req.method === "PUT" && (!patch || (expected !== null && (typeof expected !== "string" || !expected || expected.length > 64)))) {
    return res.status(400).json({ error: "A valid preference patch and revision are required." });
  }
  const read = raw => {
    if (!raw) return { preferences: PREFERENCE_DEFAULTS, revision: null };
    const stored = JSON.parse(raw);
    if (!stored.revision || !stored.preferences) throw new Error("Invalid stored preferences");
    return { revision: stored.revision, preferences: { ...PREFERENCE_DEFAULTS, ...validatePreferencePatch(stored.preferences) } };
  };
  const raw = await redis.get(key);
  const current = read(raw);
  if (req.method === "GET") return res.status(200).json(current);
  const conflict = value => res.status(409).json({ ...value, error: "Preferences changed on another device." });
  if (expected !== current.revision) return conflict(current);
  const next = { revision: randomUUID(), preferences: { ...current.preferences, ...patch } };
  if (next.preferences.budgetMode === "cash" && next.preferences.fundingSource !== "cash") {
    return res.status(400).json({ error: "Available Cash requires Existing Cash." });
  }
  if (!await compareAndSet(redis, key, raw, JSON.stringify(next))) {
    return conflict(read(await redis.get(key)));
  }
  return res.status(200).json(next);
}
