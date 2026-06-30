// src/routes/check.js
// POST /check — Rate limit check endpoint
// d2: supports Fixed Window (default) via ?strategy=fixed_window
// d3: will add token_bucket
// d4: will add sliding_window

const express = require('express');
const router = express.Router();
const fixedWindow = require('../algorithms/fixedWindow');

/**
 * POST /check
 *
 * Body: { userId: string, endpoint: string, limit?: number, windowSecs?: number }
 * Query: ?strategy=fixed_window (default)
 *
 * Response 200 (allowed):
 *   { allowed: true, remaining: N, resetAt: unixTimestamp, limit: N }
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
  const limit = parseInt(req.body.limit) || 10;
  const windowSecs = parseInt(req.body.windowSecs) || 60;

  try {
    let result;

    switch (strategy) {
      case 'fixed_window':
        result = await fixedWindow.isAllowed(userId, endpoint, limit, windowSecs);
        break;

      // stubs — will be filled in
      case 'token_bucket':
        return res.status(501).json({ error: 'Token Bucket not implemented yet — coming d3' });

      case 'sliding_window':
        return res.status(501).json({ error: 'Sliding Window not implemented yet — coming d4' });

      default:
        return res.status(400).json({ error: `Unknown strategy: ${strategy}` });
    }

    // Set standard rate limit response headers (RFC 6585 / RFC 7231)
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetAt);

    if (!result.allowed) {
      const retryAfter = result.resetAt - Math.floor(Date.now() / 1000);
      res.setHeader('Retry-After', retryAfter > 0 ? retryAfter : 1);
      return res.status(429).json({
        allowed: false,
        remaining: 0,
        resetAt: result.resetAt,
        retryAfter,
        message: 'Too Many Requests — rate limit exceeded',
      });
    }

    return res.status(200).json({
      allowed: true,
      remaining: result.remaining,
      resetAt: result.resetAt,
      limit: result.limit,
      strategy,
    });
  } catch (err) {
    console.error('[/check] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
