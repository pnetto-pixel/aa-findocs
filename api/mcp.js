// Stateless, bearer-protected MCP Streamable HTTP endpoint for ChatGPT.
// It intentionally exposes one parameterless, read-only tool and no resources.

import { constantTimeEqual } from '../lib/auth.js';
import { getRedis } from '../lib/redis.js';
import { readOwnerPortfolioSummary } from './portfolio-summary.js';

const SERVER_INFO = { name: 'aa-findocs-portfolio', version: '1.21.0' };
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
  return /^Bearer ([^\s]+)$/.exec(String(header))?.[1] || null;
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

    // MCP notifications do not receive a JSON-RPC response.
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

export default createMcpHandler();
