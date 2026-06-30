// src/algorithms/fixedWindow.js
// Fixed Window Counter — 
//
// Algorithm:
//   1. Build a Redis key scoped to userId + endpoint + current window bucket
//   2. INCR the key (returns new count after increment)
//   3. If this is the FIRST increment, set EXPIRE to windowSecs
//      (EXPIRE is set only once — at key creation — so the window ends at a fixed boundary)
//   4. Compare count against limit:
//      - count <= limit  →  allowed: true
//      - count >  limit  →  allowed: false  (return 429 caller-side)
//
// Key format:  rl:fw:{userId}:{endpoint}:{windowBucket}
//   windowBucket = Math.floor(Date.now() / 1000 / windowSecs)
//   This groups all requests within the same window into one key.
//
// Boundary-spike tradeoff (interview answer):
//   A user can send `limit` requests just before the window ends and `limit` more
//   right after — effectively 2× the limit in a short burst. Sliding Window fixes this.

const redis = require('../redis');

/**
 * Fixed Window Counter rate limiter.
 *
 * @param {string} userId      - Unique identifier for the caller
 * @param {string} endpoint    - The API endpoint being checked (e.g. "/api/login")
 * @param {number} limit       - Max requests allowed per window
 * @param {number} windowSecs  - Window size in seconds
 * @returns {Promise<{ allowed: boolean, remaining: number, resetAt: number, limit: number }>}
 */
async function isAllowed(userId, endpoint, limit, windowSecs) {
  // Calculate which window bucket we're in
  const windowBucket = Math.floor(Date.now() / 1000 / windowSecs);
  const key = `rl:fw:${userId}:${endpoint}:${windowBucket}`;

  try {
    // Atomically increment and return the new value
    const count = await redis.incr(key);

    // Set TTL only on first request in this window
    // (EXPIRE is idempotent-safe here: if count > 1 the key already has a TTL)
    if (count === 1) {
      await redis.expire(key, windowSecs);
    }

    // TTL of the key = seconds until window resets
    const ttl = await redis.ttl(key);
    const resetAt = Math.floor(Date.now() / 1000) + (ttl > 0 ? ttl : windowSecs);

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);

    return { allowed, remaining, resetAt, limit, count };
  } catch (err) {
    // Redis is down — fail open (allow request). Day 7 handles this properly.
    console.error('[fixedWindow] Redis error — failing open:', err.message);
    return { allowed: true, remaining: limit, resetAt: 0, limit, count: 0 };
  }
}

module.exports = { isAllowed };
