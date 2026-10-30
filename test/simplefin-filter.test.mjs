// Run: node --experimental-test-module-mocks test/simplefin-filter.test.mjs
import { strict as assert } from 'node:assert';
import { mock, test, after } from 'node:test';
import { fidelityOnlyPayload, simplefinLastError } from '../lib/simplefin-filter.js';
import { mapSimplefinPayload } from '../lib/simplefin-map.js';

const otherWarnings = [
  'Connection to Advancial Federal Credit Union may need attention. Auth required',
  'Connection to Apple Card (Updated Monthly) may need attention. Auth required',
];
const fidelityWarning = 'Connection to Fidelity Investments may need attention. Auth required';
const globalWarning = 'Requested date range exceeds limit of 90 days and was capped';

test('screenshot warnings disappear in fresh and legacy error formats', () => {
  assert.equal(simplefinLastError(otherWarnings), null);
  assert.equal(simplefinLastError(otherWarnings.join('; ')), null);
});

test('mixed warnings keep Fidelity, global and unknown failures', () => {
  const messages = [...otherWarnings, fidelityWarning, globalWarning, 'Unknown upstream warning'];
  const expected = [fidelityWarning, globalWarning, 'Unknown upstream warning'].join('; ');
  assert.equal(simplefinLastError(messages), expected);
  assert.equal(simplefinLastError(messages.join('; ')), expected);
  assert.equal(simplefinLastError('SimpleFin returned HTTP 401'), 'SimpleFin returned HTTP 401');
  assert.equal(simplefinLastError('SimpleFin request timed out'), 'SimpleFin request timed out');
  assert.equal(simplefinLastError('Connection to Apple Card failed unexpectedly'), 'Connection to Apple Card failed unexpectedly');
});

test('missing errors and accounts are safe', () => {
  assert.equal(simplefinLastError(null), null);
  assert.deepEqual(fidelityOnlyPayload(null), { accounts: [], errors: [] });
});

test('non-Fidelity accounts are dropped before any financial fields are read', () => {
  const other = {
    org: { name: 'Apple Card', domain: 'apple.com' },
    name: 'Fidelity named account at an unrelated institution',
    get holdings() { throw new Error('unrelated holdings accessed'); },
    get transactions() { throw new Error('unrelated transactions accessed'); },
  };
  const fidelity = { id: 'fidelity', org: { domain: 'fidelity.com' }, 'available-balance': '100', holdings: [], transactions: [] };
  const payload = fidelityOnlyPayload({ accounts: [other, null, { name: 'Fidelity' }, fidelity], errors: otherWarnings });
  assert.deepEqual(payload.accounts, [fidelity]);
  const mapped = mapSimplefinPayload(payload);
  assert.equal(mapped.balanceCandidates.length, 1);
  for (const key of ['transactions', 'bondIncome', 'unmapped', 'bondHoldings']) assert.deepEqual(mapped[key], []);
  assert.deepEqual(mapped.seenTradeSourceIds, []);
});

// Exercise the real endpoint with synthetic auth, storage and upstream data.
let stored;
const redis = {
  async get(key) { return key.endsWith(':fidelity-pending') ? stored : null; },
  async set(key, value) { stored = value; },
};
mock.module('../lib/auth.js', { exports: { authenticate: async () => ({ ok: true, admin: true, storageKey: 'test:holdings' }) } });
mock.module('../lib/redis.js', { exports: { getRedis: () => redis } });
const { default: handler } = await import('../api/fidelity-pending.js');
const originalFetch = globalThis.fetch;
const originalUrl = process.env.SIMPLEFIN_ACCESS_URL;
after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SIMPLEFIN_ACCESS_URL;
  else process.env.SIMPLEFIN_ACCESS_URL = originalUrl;
});

async function request(method, query = {}) {
  let status;
  let body;
  await handler({ method, query }, {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  });
  assert.equal(status, 200);
  return body;
}

test('GET, status and throttled sync remove old warnings without fetching', async () => {
  globalThis.fetch = async () => { throw new Error('must not fetch'); };
  stored = JSON.stringify({ lastError: otherWarnings.join('; '), lastSyncAttempt: new Date().toISOString() });
  for (const [method, query] of [['GET', {}], ['GET', { resource: 'status' }], ['POST', { resource: 'sync' }]]) {
    const response = await request(method, query);
    assert.equal(response.lastError, null);
  }
});

test('status preserves Fidelity and transport errors in old stored metadata', async () => {
  for (const error of [fidelityWarning, 'SimpleFin returned HTTP 401', 'SimpleFin request timed out']) {
    stored = JSON.stringify({ lastError: [...otherWarnings, error].join('; ') });
    assert.equal((await request('GET', { resource: 'status' })).lastError, error);
  }
});

test('fresh sync stores only Fidelity data and relevant errors', async () => {
  process.env.SIMPLEFIN_ACCESS_URL = 'https://test:synthetic@example.com/simplefin';
  for (const errors of [otherWarnings, [...otherWarnings, fidelityWarning, globalWarning]]) {
    stored = null;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ errors, accounts: [
      { id: 'other', org: { name: 'Apple Card' }, 'available-balance': '9999', holdings: [{ symbol: '', description: 'PERSONAL BOND', market_value: '9999' }], transactions: [{ id: 'personal', posted: 1752900000, amount: '15', description: 'DIVIDEND RECEIVED EXAMPLE (AAPL) (Cash)' }] },
      { id: 'fidelity', org: { name: 'Fidelity Investments' }, 'available-balance': '100', holdings: [], transactions: [] },
    ] }) });
    const response = await request('POST', { resource: 'sync', force: '1' });
    const pending = JSON.parse(stored);
    assert.equal(response.lastError, simplefinLastError(errors));
    assert.equal(pending.lastError, response.lastError);
    assert.equal(pending.balanceCandidates.length, 1);
    assert.equal(pending.balanceCandidates[0].accountId, 'fidelity');
    for (const key of ['transactions', 'bondIncome', 'unmapped', 'bondHoldings']) assert.deepEqual(pending[key], []);
    assert.equal(stored.includes('PERSONAL'), false);
  }
});
