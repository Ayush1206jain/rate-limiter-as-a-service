// src/routes/check.js
// POST /check — Rate limit check endpoint
// d2: Fixed Window Counter
// d3: Token Bucket (Lua-script atomic)
// d4: Sliding Window Log (Lua-script atomic)
// d5: JWT auth + DB rule auto-fetch (config no longer hardcoded in body)

const express = require('express');
const router  = express.Router();

const fixedWindow   = require('../algorithms/fixedWindow');
const tokenBucket   = require('../algorithms/tokenBucket');
const slidingWindow = require('../algorithms/slidingWindow');
const auth          = require('../middleware/auth');
const db            = require('../db');

// Map DB algorithm enum → strategy string used internally
const ALGO_MAP = {
  FIXED_WINDOW:   'fixed_window',
  TOKEN_BUCKET:   'token_bucket',
  SLIDING_WINDOW: 'sliding_window',
};

/**
 * Fetch the rate limit rule for a userId + endpoint from PostgreSQL.
 * Falls back to a sensible default if no rule is found.
 *
 * @returns {{ algorithm, limit, windowSecs, isDefault: boolean }}
 */
async function getRuleForUser(userId, endpoint) {
  try {
    // Exact match first, then wildcard '*' rule for the user
    const sql = `
      SELECT algorithm, "limit", window_secs
      FROM rules
      WHERE user_id = $1 AND (endpoint = $2 OR endpoint = '*')
      ORDER BY (endpoint = $2) DESC   -- exact match wins over wildcard
      LIMIT 1
    `;
    const { rows } = await db.query(sql, [userId, endpoint]);

    if (rows.length > 0) {
      const r = rows[0];
      return {
        algorithm:  ALGO_MAP[r.algorithm] || 'fixed_window',
        limit:      r.limit,
        windowSecs: r.window_secs,
        isDefault:  false,
      };
    }
  } catch (err) {
    // DB unreachable — fall through to global default (fail-open for rule lookup)
    console.warn('[/check] DB unavailable for rule lookup — using global default:', err.message);
  }

  // Global default rule: 100 requests per 60 seconds, Fixed Window
  // (matches behaviour before D5; can be tuned via RATE_LIMIT_DEFAULT_* env vars)
  return {
    algorithm:  process.env.DEFAULT_ALGORITHM  || 'fixed_window',
    limit:      parseInt(process.env.DEFAULT_LIMIT)       || 100,
    windowSecs: parseInt(process.env.DEFAULT_WINDOW_SECS) || 60,
    isDefault:  true,
  };
}

/**
 * POST /check
 *
 * Headers: Authorization: Bearer <JWT>   (required — auth middleware validates)
 *
 * Body:  { endpoint: string }
 *   userId is now taken from req.userId (JWT payload) — NOT from body.
 *   The rule (algorithm, limit, windowSecs) is loaded from PostgreSQL.
 *   Body overrides are accepted ONLY if no DB rule exists (for quick testing
 *   without setting up a DB rule):
 *     { limit?, windowSecs?, maxTokens?, refillRate? }
 *
 * Query: ?strategy=  (optional override — ignored if a DB rule exists)
 *
 * Response 200: { allowed, strategy, resetAt, remaining/tokensRemaining, ... }
 * Response 401: missing/invalid JWT
 * Response 429: rate limit exceeded
 */
router.post('/', auth, async (req, res) => {
  const userId   = req.userId;           // from JWT payload (set by auth middleware)
  const endpoint = req.body?.endpoint;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing required field: endpoint' });
  }

  // --- Load rule from DB (auto-fetch) ---
  const rule = await getRuleForUser(userId, endpoint);

  // If a DB rule exists, use its config; otherwise accept body params as fallback
  const strategy   = rule.isDefault
    ? (req.query.strategy || rule.algorithm)
    : rule.algorithm;

  const limit      = rule.isDefault
    ? (parseInt(req.body.limit)        || rule.limit)
    : rule.limit;

  const windowSecs = rule.isDefault
    ? (parseInt(req.body.windowSecs)   || rule.windowSecs)
    : rule.windowSecs;

  // Token Bucket extras — only meaningful when strategy = token_bucket
  const maxTokens  = parseInt(req.body.maxTokens)  || limit;
  const refillRate = parseFloat(req.body.refillRate) || 1;

  try {
    let result;

    switch (strategy) {
      case 'fixed_window':
        result = await fixedWindow.isAllowed(userId, endpoint, limit, windowSecs);
        break;

      case 'token_bucket':
        result = await tokenBucket.isAllowed(userId, endpoint, maxTokens, refillRate);
        break;

      case 'sliding_window':
        result = await slidingWindow.isAllowed(userId, endpoint, limit, windowSecs);
        break;

      default:
        return res.status(400).json({ error: `Unknown strategy: ${strategy}` });
    }

    // Normalise field names so header logic works for all strategies
    const effectiveLimit     = result.limit      ?? result.maxTokens;
    const effectiveRemaining = result.remaining  ?? Math.floor(result.tokensRemaining ?? 0);
    const effectiveResetAt   = result.resetAt    ?? result.nextRefillAt;

    // Standard rate limit response headers (RFC 6585 / RFC 7231)
    res.setHeader('X-RateLimit-Limit',     effectiveLimit);
    res.setHeader('X-RateLimit-Remaining', effectiveRemaining);
    res.setHeader('X-RateLimit-Reset',     effectiveResetAt);

    if (!result.allowed) {
      const retryAfter = effectiveResetAt - Math.floor(Date.now() / 1000);
      res.setHeader('Retry-After', retryAfter > 0 ? retryAfter : 1);
      return res.status(429).json({
        allowed:    false,
        remaining:  0,
        resetAt:    effectiveResetAt,
        retryAfter: retryAfter > 0 ? retryAfter : 1,
        message:    'Too Many Requests — rate limit exceeded',
        strategy,
        ruleSource: rule.isDefault ? 'global_default' : 'db',
      });
    }

    // Build strategy-specific response body
    const responseBody = {
      allowed:    true,
      strategy,
      resetAt:    effectiveResetAt,
      ruleSource: rule.isDefault ? 'global_default' : 'db',
    };

    if (strategy === 'token_bucket') {
      responseBody.tokensRemaining = result.tokensRemaining;
      responseBody.maxTokens       = result.maxTokens;
      responseBody.refillRate      = result.refillRate;
      responseBody.nextRefillAt    = result.nextRefillAt;
    } else if (strategy === 'sliding_window') {
      responseBody.remaining    = result.remaining;
      responseBody.limit        = result.limit;
      responseBody.currentCount = result.currentCount;
      responseBody.windowMs     = result.windowMs;
    } else {
      responseBody.remaining = result.remaining;
      responseBody.limit     = result.limit;
    }

    return res.status(200).json(responseBody);
  } catch (err) {
    console.error('[/check] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
