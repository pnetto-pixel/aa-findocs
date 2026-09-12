import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandler } from '../api/portfolio-summary.js';
import { emailStorageKey } from '../lib/auth.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function rpc(handler, method, params = {}, authorization = 'Bearer mcp-only-secret') {
  const req = {
    method: 'POST',
    headers: authorization ? { authorization } : {},
    body: { jsonrpc: '2.0', id: 1, method, params },
  };
  const res = response();
  await handler(req, res);
  return res;
}

function fixtureRedis() {
  const ownerKey = emailStorageKey('owner@example.com');
  const calls = [];
  const values = new Map([
    [ownerKey, JSON.stringify({ holdings: [
      { type: 'manual', manualMode: 'value', ticker: 'CASH', assetClass: 'Cash', manualValue: 250, target: 10 },
    ] })],
    [ownerKey.replace(/:holdings$/, ':contributions-history'), '{}'],
  ]);
  return {
    calls,
    async get(key) { calls.push(['get', key]); return values.get(key) ?? null; },
    async set() { calls.push(['set']); throw new Error('must not write'); },
    async del() { calls.push(['del']); throw new Error('must not write'); },
  };
}

const originalEnv = { ...process.env };
function configure() {
  process.env.CHATGPT_MCP_ACCESS_TOKEN = 'mcp-only-secret';
  process.env.CHATGPT_PORTFOLIO_READ_TOKEN = 'internal-portfolio-secret';
  process.env.CHATGPT_PORTFOLIO_OWNER_EMAIL = 'owner@example.com';
  process.env.ADMIN_EMAILS = 'owner@example.com';
  process.env.APP_PASSWORD = 'unrelated-app-password';
}
test.afterEach(() => { process.env = { ...originalEnv }; });

test('MCP rejects missing and incorrect bearer credentials before storage access', async () => {
  configure();
  const handler = createMcpHandler({ redisFactory: () => { throw new Error('must not reach storage'); } });
  assert.equal((await rpc(handler, 'tools/list', {}, null)).statusCode, 401);
  assert.equal((await rpc(handler, 'tools/list', {}, 'Bearer wrong')).statusCode, 401);
});

test('tools/list exposes exactly one parameterless read-only tool', async () => {
  configure();
  const res = await rpc(createMcpHandler(), 'tools/list');
  assert.equal(res.statusCode, 200);
  const tools = res.body.result.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'get_portfolio_summary');
  assert.deepEqual(tools[0].inputSchema.properties, {});
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[0].annotations.destructiveHint, false);
});

test('tool refuses selectors and unknown/write tools', async () => {
  configure();
  const handler = createMcpHandler({ redisFactory: () => { throw new Error('must not reach storage'); } });
  for (const args of [
    { email: 'other@example.com' },
    { userId: 'another-user' },
    { storageKey: 'portfolio:other' },
    { ticker: 'AAPL' },
  ]) {
    const res = await rpc(handler, 'tools/call', { name: 'get_portfolio_summary', arguments: args });
    assert.equal(res.body.error.code, -32602);
  }
  const unknown = await rpc(handler, 'tools/call', { name: 'update_portfolio', arguments: {} });
  assert.equal(unknown.body.error.code, -32602);
});

test('tool returns the safe summary, only reads owner keys, and leaks no secret', async () => {
  configure();
  const redis = fixtureRedis();
  const res = await rpc(
    createMcpHandler({ redisFactory: () => redis }),
    'tools/call',
    { name: 'get_portfolio_summary', arguments: {} },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.structuredContent.portfolio.totalValueUSD, 250);
  assert.deepEqual(
    JSON.parse(res.body.result.content[0].text),
    res.body.result.structuredContent,
  );
  assert.deepEqual(redis.calls.map(([method]) => method), ['get', 'get']);

  const serialized = JSON.stringify(res.body);
  for (const forbidden of [
    process.env.CHATGPT_MCP_ACCESS_TOKEN,
    process.env.CHATGPT_PORTFOLIO_READ_TOKEN,
    process.env.APP_PASSWORD,
    process.env.CHATGPT_PORTFOLIO_OWNER_EMAIL,
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

