// Dedicated, owner-bound, strictly read-only portfolio export for ChatGPT.
// This route only performs Redis GETs and accepts no user/storage selector.

import { constantTimeEqual, emailStorageKey, isAdmin } from '../lib/auth.js';
import { getRedis } from '../lib/redis.js';
import { buildPortfolioSummary } from '../lib/portfolio-summary.js';

const SERVER_INFO = { name: 'aa-findocs-portfolio', version: '1.21.1' };
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

export const PORTFOLIO_TOOL = Object.freeze({
  name: 'get_portfolio_summary',
  title: 'Get portfolio summary',
  description: 'Returns the current read-only portfolio summary for the server-configured owner.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer ([^\s]+)$/.exec(String(header));
  return match?.[1] || null;
}

function parseHoldings(raw) {
  if (!raw) return { holdings: [], savedAt: null };
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return { holdings: parsed, savedAt: null };
  return {
    holdings: Array.isArray(parsed?.holdings) ? parsed.holdings : [],
    savedAt: typeof parsed?.savedAt === 'string' ? parsed.savedAt : null,
  };
}

function parseContributionHistory(raw) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed.history && typeof parsed.history === 'object' ? parsed.history : parsed;
}

export async function readOwnerPortfolioSummary({ redisFactory = getRedis } = {}) {
  const ownerEmail = String(process.env.CHATGPT_PORTFOLIO_OWNER_EMAIL || '').trim().toLowerCase();
  if (!ownerEmail || !isAdmin(ownerEmail)) {
    const error = new Error('Portfolio owner is not configured as an admin');
    error.status = 503;
    throw error;
  }

  let redis;
  try {
    redis = redisFactory();
  } catch (cause) {
    const error = new Error(`Storage unavailable: ${cause.message}`);
    error.status = 503;
    throw error;
  }

  const holdingsKey = emailStorageKey(ownerEmail);
  const contributionsKey = holdingsKey.replace(/:holdings$/, ':contributions-history');
  // Deliberately only GET: every consumer of this helper is read-only.
  const [holdingsRaw, contributionsRaw] = await Promise.all([
    redis.get(holdingsKey),
    redis.get(contributionsKey),
  ]);
  const { holdings, savedAt } = parseHoldings(holdingsRaw);
  const contributionHistory = parseContributionHistory(contributionsRaw);
  return buildPortfolioSummary({ holdings, savedAt, contributionHistory });
}

export function createPortfolioSummaryHandler({ redisFactory = getRedis } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const expectedToken = process.env.CHATGPT_PORTFOLIO_READ_TOKEN;
    const suppliedToken = bearerToken(req);
    if (!expectedToken || !suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json(await readOwnerPortfolioSummary({ redisFactory }));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error('portfolio-summary handler error:', error);
      return res.status(500).json({ error: 'Internal error' });
    }
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function createMcpHandler({ redisFactory = getRedis } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const expectedToken = process.env.CHATGPT_MCP_ACCESS_TOKEN;
    const suppliedToken = bearerToken(req);
    if (!expectedToken || !suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const request = req.body;
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return res.status(400).json(rpcError(request?.id, -32600, 'Invalid Request'));
    }

    if (request.id === undefined) return res.status(202).end();

    if (request.method === 'initialize') {
      const requested = request.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : '2025-06-18';
      return res.status(200).json(rpcResult(request.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      }));
    }

    if (request.method === 'ping') {
      return res.status(200).json(rpcResult(request.id, {}));
    }

    if (request.method === 'tools/list') {
      return res.status(200).json(rpcResult(request.id, { tools: [PORTFOLIO_TOOL] }));
    }

    if (request.method === 'tools/call') {
      if (request.params?.name !== PORTFOLIO_TOOL.name) {
        return res.status(200).json(rpcError(request.id, -32602, 'Unknown tool'));
      }
      const args = request.params?.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
        return res.status(200).json(rpcError(request.id, -32602, 'This tool accepts no arguments'));
      }

      try {
        const summary = await readOwnerPortfolioSummary({ redisFactory });
        return res.status(200).json(rpcResult(request.id, {
          content: [{ type: 'text', text: JSON.stringify(summary) }],
          structuredContent: summary,
          isError: false,
        }));
      } catch (error) {
        console.error('MCP portfolio tool error:', error);
        return res.status(200).json(rpcError(request.id, -32603, 'Unable to read portfolio summary'));
      }
    }

    return res.status(200).json(rpcError(request.id, -32601, 'Method not found'));
  };
}

export function createPortfolioGatewayHandler(options = {}) {
  const portfolioSummaryHandler = createPortfolioSummaryHandler(options);
  const mcpHandler = createMcpHandler(options);
  return async function handler(req, res) {
    if (req.query?.resource === 'mcp') return mcpHandler(req, res);
    return portfolioSummaryHandler(req, res);
  };
}

export default createPortfolioGatewayHandler();
