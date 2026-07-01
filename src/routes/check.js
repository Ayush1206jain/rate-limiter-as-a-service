// src/routes/check.js
// POST /check — Rate limit check endpoint
// d2: Fixed Window Counter
// d3: Token Bucket (Lua-script atomic)
// d4: Sliding Window Log (Lua-script atomic)

const express = require('express');
const router = express.Router();
const fixedWindow   = require('../algorithms/fixedWindow');
const tokenBucket   = require('../algorithms/tokenBucket');
const slidingWindow = require('../algorithms/slidingWindow');

/**
 * POST /check
 *
 * Body:
 *   { userId, endpoint, limit?, windowSecs?, maxTokens?, refillRate? }
 *
 * Query: ?strategy=fixed_window (default) | token_bucket | sliding_window
 *
 * Strategies:
 *   fixed_window   — uses limit + windowSecs
 *   token_bucket   — uses maxTokens + refillRate (tokens/sec)
 *   sliding_window — uses limit + windowSecs (sorted set, most accurate)
 *
 * Response 200 (allowed):
 *   { allowed: true, remaining: N, resetAt: unixTimestamp, limit: N, strategy }
 *
 * Response 429 (blocked):
 *   { allowed: false, remaining: 0, resetAt: unixTimestamp, retryAfter: N }
 */
router.post('/', async (req, res) => {
  const { userId, endpoint } = req.body;

  // --- Basic validation ---
  if (!userId || !endpoint) {
    return res.status(400).json({
      error: 'Missing required fields: userId and endpoint',
    });
  }

  const strategy = req.query.strategy || 'fixed_window';

  // Config: in d5 these come from DB rules. For now accept from body with defaults.
  const limit       = parseInt(req.body.limit)       || 10;
  const windowSecs  = parseInt(req.body.windowSecs)  || 60;
  const maxTokens   = parseInt(req.body.maxTokens)   || 10;   // token_bucket: bucket capacity
  const refillRate  = parseFloat(req.body.refillRate) || 1;   // token_bucket: tokens per second

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

    // Normalise field names so header logic works for all strategies:
    // fixed_window   → result.limit,     result.remaining, result.resetAt
    // token_bucket   → result.maxTokens, result.tokensRemaining, result.nextRefillAt
    // sliding_window → result.limit,     result.remaining, result.resetAt
    const effectiveLimit     = result.limit      ?? result.maxTokens;
    const effectiveRemaining = result.remaining  ?? Math.floor(result.tokensRemaining ?? 0);
    const effectiveResetAt   = result.resetAt    ?? result.nextRefillAt;

    // Set standard rate limit response headers (RFC 6585 / RFC 7231)
    res.setHeader('X-RateLimit-Limit',     effectiveLimit);
    res.setHeader('X-RateLimit-Remaining', effectiveRemaining);
    res.setHeader('X-RateLimit-Reset',     effectiveResetAt);

    if (!result.allowed) {
      const retryAfter = effectiveResetAt - Math.floor(Date.now() / 1000);
      res.setHeader('Retry-After', retryAfter > 0 ? retryAfter : 1);
      return res.status(429).json({
        allowed: false,
        remaining: 0,
        resetAt: effectiveResetAt,
        retryAfter: retryAfter > 0 ? retryAfter : 1,
        message: 'Too Many Requests — rate limit exceeded',
        strategy,
      });
    }

    // Build strategy-specific response body
    const responseBody = {
      allowed: true,
      strategy,
      resetAt: effectiveResetAt,
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
