// Dedicated, owner-bound, strictly read-only portfolio export for ChatGPT.
// This route only performs Redis GETs and accepts no user/storage selector.

import { constantTimeEqual, emailStorageKey, isAdmin } from '../lib/auth.js';
import { getRedis } from '../lib/redis.js';
import { buildPortfolioSummary } from '../lib/portfolio-summary.js';

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

    const ownerEmail = String(process.env.CHATGPT_PORTFOLIO_OWNER_EMAIL || '').trim().toLowerCase();
    if (!ownerEmail || !isAdmin(ownerEmail)) {
      return res.status(503).json({ error: 'Portfolio owner is not configured as an admin' });
    }

    let redis;
    try {
      redis = redisFactory();
    } catch (error) {
      return res.status(503).json({ error: `Storage unavailable: ${error.message}` });
    }

    try {
      const holdingsKey = emailStorageKey(ownerEmail);
      const contributionsKey = holdingsKey.replace(/:holdings$/, ':contributions-history');
      // Deliberately only GET: this endpoint has no write path or Redis mutation.
      const [holdingsRaw, contributionsRaw] = await Promise.all([
        redis.get(holdingsKey),
        redis.get(contributionsKey),
      ]);
      const { holdings, savedAt } = parseHoldings(holdingsRaw);
      const contributionHistory = parseContributionHistory(contributionsRaw);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json(buildPortfolioSummary({ holdings, savedAt, contributionHistory }));
    } catch (error) {
      console.error('portfolio-summary handler error:', error);
      return res.status(500).json({ error: 'Internal error' });
    }
  };
}

export default createPortfolioSummaryHandler();
