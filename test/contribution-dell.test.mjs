// Run: node --experimental-test-module-mocks test/contribution-dell.test.mjs
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { initialDellPlan, validDellAmount } from "../src/lib/contributionDell.js";

test("November transition replaces legacy automatic planning; other months start at zero", () => {
  assert.equal(initialDellPlan("2026-11", { dellSale: 10000 }), 7920);
  assert.equal(initialDellPlan("2026-12"), 0);
  assert.equal(initialDellPlan("2027-01"), 0);
  assert.equal(initialDellPlan("2027-11"), 0);
});

test("manual amount and explicit zero survive reload, overriding the transition default", () => {
  assert.equal(initialDellPlan("2026-11", { dellSaleMode: "manual", dellSale: 0 }), 0);
  assert.equal(initialDellPlan("2026-11", { dellSaleMode: "manual", dellSale: 8040.24 }), 8040.24);
  assert.equal(initialDellPlan("2026-12", { dellSaleMode: "manual", dellSale: 8040.24 }), 8040.24);
  for (const dellSale of [null, -1, NaN, Infinity, "8040"]) {
    assert.equal(initialDellPlan("2026-12", { dellSaleMode: "manual", dellSale }), 0);
  }
});

test("manual input accepts zero/decimals and rejects empty, negative or non-finite amounts", () => {
  for (const value of [0, "0", "7920", "8040.24"]) assert.equal(validDellAmount(value), true);
  for (const value of [null, undefined, false, "", " ", "-1", "Infinity", "NaN", "abc", "1e999"]) assert.equal(validDellAmount(value), false);
});

const past = {
  monthlyFixed: 400, dividends: 50, dellSale: 10000, extras: [],
  planTotal: 10450, invested: 9000, savedAt: "2026-10-31T12:00:00Z",
};
let stored = JSON.stringify({ "2026-10": past });
mock.module("../lib/auth.js", { namedExports: { authenticate: async () => ({ ok: true, storageKey: "test:holdings" }) } });
mock.module("../lib/redis.js", { namedExports: { getRedis: () => ({
  async get() { return stored; },
  async set(key, value) { assert.equal(key, "test:contributions-history"); stored = value; },
  async eval(_script, count, key, expected, next) {
    assert.equal(count, 1);
    assert.equal(key, "test:contributions-history");
    if ((stored || "") !== expected) return 0;
    stored = next;
    return 1;
  },
}) } });
const { default: handler } = await import("../api/contributions-history.js");

async function request(method, body, expectedStatus = 200) {
  let status, response;
  await handler({ method, body }, {
    status(value) { status = value; return this; },
    json(value) { response = value; return this; },
  });
  assert.equal(status, expectedStatus);
  return response;
}

test("real history endpoint round-trips manual zero and keeps historical planning intact", async () => {
  for (const dellSale of [7920, 8040.24, 0]) {
    const snapshot = { monthlyFixed: 400, dividends: 50, dellSale, dellSaleMode: "manual",
      extras: [], planTotal: 450 + dellSale, invested: 200 };
    await request("PUT", { month: "2026-11", snapshot, reconcileInvested: { "2026-10": 9500 } });
    const { history } = await request("GET");
    assert.deepEqual(history["2026-10"], { ...past, invested: 9500 });
    assert.equal(initialDellPlan("2026-11", history["2026-11"]), dellSale);
    assert.equal(history["2026-11"].planTotal, 450 + dellSale);
    assert.equal(initialDellPlan("2026-12", history["2026-12"]), 0);
    assert.equal(history["2026-12"], undefined);
  }
});

test("conditional plan writes protect an edit made on another device", async () => {
  const previous = (await request("GET")).history["2026-11"];
  const { planRevision } = await request("PUT", {
    month: "2026-11", expectedPlanRevision: previous.savedAt,
    snapshot: { ...previous, planTotal: 12345, planComplete: true },
  });
  assert.ok(planRevision);
  await request("PUT", { month: "2026-11", expectedPlanRevision: previous.savedAt,
    snapshot: { ...previous, planTotal: 99999 } }, 409);
  const { history } = await request("GET");
  assert.equal(history["2026-11"].planTotal, 12345);
  assert.equal(history["2026-11"].planRevision, planRevision);
  assert.equal(history["2026-10"].invested, 9500);
});
