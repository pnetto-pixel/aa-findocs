import assert from 'node:assert/strict';
import test from 'node:test';
import { createPortfolioSummaryHandler } from '../api/portfolio-summary.js';
import { emailStorageKey } from '../lib/auth.js';
import { buildPortfolioSummary } from '../lib/portfolio-summary.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; },
  };
}

function fixtureRedis() {
  const ownerKey = emailStorageKey('owner@example.com');
  const values = new Map([
    [ownerKey, JSON.stringify({
      savedAt: '2026-09-12T18:00:00.000Z',
      holdings: [
        { type: 'auto', ticker: 'BND', name: 'Vanguard Bond', assetClass: 'Bonds', qty: 10, price: 80, target: 50 },
        { type: 'manual', manualMode: 'value', ticker: 'CASH', name: 'Cash', assetClass: 'Cash', manualValue: 200, target: 10 },
      ],
    })],
    [ownerKey.replace(/:holdings$/, ':contributions-history'), JSON.stringify({
      '2026-09': { monthlyFixed: 500, dividends: 50, dellSale: 0, extras: [], planTotal: 550, invested: 100, savedAt: '2026-09-10T00:00:00.000Z' },
    })],
  ]);
  const calls = [];
  return {
    calls,
    async get(key) { calls.push(['get', key]); return values.get(key) ?? null; },
    async set() { calls.push(['set']); throw new Error('must not write'); },
    async del() { calls.push(['del']); throw new Error('must not write'); },
  };
}

async function call(handler, authorization) {
  const req = { method: 'GET', headers: authorization ? { authorization } : {} };
  const res = response();
  await handler(req, res);
  return res;
}

const originalEnv = { ...process.env };
function configure() {
  process.env.CHATGPT_PORTFOLIO_READ_TOKEN = 'dedicated-secret';
  process.env.CHATGPT_PORTFOLIO_OWNER_EMAIL = 'owner@example.com';
  process.env.ADMIN_EMAILS = 'owner@example.com';
}
test.afterEach(() => { process.env = { ...originalEnv }; });

test('request without token returns 401', async () => {
  configure();
  const res = await call(createPortfolioSummaryHandler({ redisFactory: () => { throw new Error('Redis must not be reached'); } }));
  assert.equal(res.statusCode, 401);
});

test('request with incorrect token returns 401', async () => {
  configure();
  const res = await call(createPortfolioSummaryHandler({ redisFactory: () => { throw new Error('Redis must not be reached'); } }), 'Bearer wrong');
  assert.equal(res.statusCode, 401);
});

test('correct token returns summary and only reads owner keys', async () => {
  configure();
  const redis = fixtureRedis();
  const res = await call(createPortfolioSummaryHandler({ redisFactory: () => redis }), 'Bearer dedicated-secret');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.portfolio.totalValueUSD, 1000);
  assert.equal(res.body.contributions.currentCapacityUSD, 550);
  assert.deepEqual(redis.calls.map(([method]) => method), ['get', 'get']);
  assert.ok(redis.calls.every(([, key]) => key.includes(emailStorageKey('owner@example.com').replace(/:holdings$/, ''))));
});

test('totals, allocation, drift, and target gap are calculated correctly', () => {
  const summary = buildPortfolioSummary({
    holdings: [
      { type: 'auto', ticker: 'BND', assetClass: 'Bonds', qty: 10, price: 80, target: 50 },
      { type: 'manual', manualMode: 'value', ticker: 'CASH', assetClass: 'Cash', manualValue: 200, target: 10 },
    ],
  });
  const bonds = summary.assetClasses.find((item) => item.name === 'Bonds');
  assert.equal(summary.portfolio.totalValueUSD, 1000);
  assert.equal(summary.portfolio.cashUSD, 200);
  assert.equal(bonds.currentPct, 80);
  assert.equal(bonds.driftPctPoints, 30);
  assert.equal(bonds.targetValueUSD, 500);
  assert.equal(bonds.underOverTargetUSD, -300);
});

test('response contains no sensitive or account-identifying fields', async () => {
  configure();
  const redis = fixtureRedis();
  const res = await call(createPortfolioSummaryHandler({ redisFactory: () => redis }), 'Bearer dedicated-secret');
  const serialized = JSON.stringify(res.body).toLowerCase();
  for (const forbidden of ['password', 'token', 'secret', 'email', 'admin', 'google', 'storagekey']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
