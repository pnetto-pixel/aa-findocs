// Invoke with --experimental-test-module-mocks, like contribution-dell.test.mjs.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const db = new Map([["u:holdings", JSON.stringify([{ id: "hold-a", target: 99 }])]]);
let fail = false;
mock.module("../lib/auth.js", { namedExports: { authenticate: async req => req.headers["x-test-user"]
  ? { ok: true, storageKey: `${req.headers["x-test-user"]}:holdings` } : { ok: false, status: 401, error: "Unauthorized" } } });
mock.module("../lib/redis.js", { namedExports: { getRedis: () => ({
  async get(key) { return db.get(key) ?? null; },
  async eval(script, count, key, expected, value) {
    assert.match(script, /redis.call\('GET'/);
    assert.equal(count, 1);
    if (fail) throw new Error("Simulated Redis failure");
    if ((db.get(key) ?? "") !== expected) return 0;
    db.set(key, value);
    return 1;
  },
}) } });
const { default: handler } = await import("../api/holdings.js");
async function call(user, method = "GET", body, resource = "preferences") {
  const out = {};
  await handler({ method, query: { resource }, body, headers: { "x-test-user": user } }, {
    status(code) { out.code = code; return this; }, json(value) { out.value = value; return this; },
    setHeader(name, value) { if (name === "Cache-Control") out.cache = value; },
  });
  return out;
}

test("authenticated devices share preferences without writing holdings or exposing another account", async () => {
  assert.equal((await call(null)).code, 401);
  const a = await call("u");
  assert.equal(a.cache, "private, no-store");
  assert.equal(a.value.preferences.strategy, "standard");
  assert.equal(a.value.preferences.allocationView, "total");
  assert.equal(a.value.preferences.grouping, "class");
  assert.equal(a.value.preferences.fundingSource, "cash");
  assert.equal(a.value.preferences.washProtection, true);
  const patch = { strategy: "dynamic", allocationView: "ex-dell", grouping: "holding", budgetMode: "custom",
    cashAccountId: "cash-real", fundingSource: "new", customBudget: 432198, washProtection: false,
    excludeTickers: [" ivv ", "IVV"], excludeClasses: ["BRA Stocks"] };
  const saved = await call("u", "PUT", { patch, expectedRevision: a.value.revision });
  assert.equal(saved.code, 200);
  assert.deepEqual(saved.value.preferences.excludeTickers, ["IVV"]);
  assert.deepEqual(saved.value.preferences.excludeClasses, ["bra stocks"]);
  assert.deepEqual((await call("u")).value, saved.value);
  assert.equal((await call("v")).value.revision, null);
  assert.deepEqual((await call("u", "GET", undefined, null)).value.holdings, [{ id: "hold-a", target: 99 }]);
});

test("atomic first-writer wins, stale member and invalid modes are rejected", async () => {
  const initial = await call("race");
  const [a, b] = await Promise.all([call("race", "PUT", { patch: { budgetMode: "cash" }, expectedRevision: initial.value.revision }),
    call("race", "PUT", { patch: { grouping: "holding" }, expectedRevision: initial.value.revision })]);
  assert.deepEqual([a.code, b.code].sort(), [200, 409]);
  assert.deepEqual((await call("race")).value.preferences, (a.code === 200 ? a : b).value.preferences);
  assert.equal((await call("race", "PUT", { patch: { holdings: [] }, expectedRevision: null })).code, 400);
  assert.equal((await call("mixed", "PUT", { patch: { budgetMode: "cash", fundingSource: "new" }, expectedRevision: null })).code, 400);
});

test("an unconfirmed persistence failure leaves the last confirmed state intact", async () => {
  const before = (await call("u")).value;
  fail = true;
  assert.equal((await call("u", "PUT", { patch: { grouping: "class" }, expectedRevision: before.revision })).code, 500);
  fail = false;
  assert.deepEqual((await call("u")).value, before);
});
