// src/algorithms/slidingWindow.js
// Sliding Window Log Rate Limiter
//
// Algorithm:
//   1. Redis data structure: sorted set per user+endpoint
//        Key:    rl:sw:{userId}:{endpoint}
//        Score:  Unix timestamp in milliseconds (enables range queries)
//        Member: unique ID per request (timestamp:random to avoid duplicate scores)
//
//   2. On each request (atomically via Lua script):
//      a. ZREMRANGEBYSCORE — evict all entries older than (now - windowMs)
//      b. ZCARD            — count how many entries remain (= requests in window)
//      c. If count < limit: ZADD the new entry (allow); else: reject
//      d. EXPIRE           — reset TTL so idle keys clean themselves up
//
//   3. Why Lua is CRITICAL here (interview answer):
//      Without atomicity: Thread A reads ZCARD = 9 (limit = 10), Thread B reads
//      ZCARD = 9. Both pass the check and ZADD — real count becomes 11, limit violated.
//      Lua script runs atomically on Redis — no command from any other client
//      can interleave between ZREMRANGEBYSCORE and ZADD.
//
// Key format:  rl:sw:{userId}:{endpoint}
// Value:       sorted set — score = nowMs, member = "{nowMs}:{random}"
//
// Returned: { allowed, currentCount, limit, windowMs, oldestEntryAt, resetAt }
//
// Tradeoff vs Fixed Window (interview answer):
//   Memory: O(requests in window) — for 1000 req/min, that's 1000 sorted set entries.
//   Fixed Window uses just 1 integer.
//   But accuracy: no boundary spike — the window always slides with current time.

const redis = require('../redis');

// ---------------------------------------------------------------------------
// Lua script — runs atomically on the Redis server
//
// KEYS[1] = sorted set key
// ARGV[1] = nowMs           (current timestamp in ms)
// ARGV[2] = windowMs        (window size in ms)
// ARGV[3] = limit           (max requests allowed in window)
// ARGV[4] = member          (unique member ID for this request)
// ARGV[5] = ttlSecs         (key TTL in seconds for idle cleanup)
//
// Returns: { currentCountBefore (int), allowed (0|1), oldestScore (string|"0") }
// ---------------------------------------------------------------------------
const SLIDING_WINDOW_LUA = `
local key       = KEYS[1]
local nowMs     = tonumber(ARGV[1])
local windowMs  = tonumber(ARGV[2])
local limit     = tonumber(ARGV[3])
local member    = ARGV[4]
local ttlSecs   = tonumber(ARGV[5])

-- Step 1: Remove all entries outside the current window
local cutoff = nowMs - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

-- Step 2: Count how many requests are currently in the window
local currentCount = redis.call('ZCARD', key)

-- Step 3: Decide and conditionally add
local allowed = 0
if currentCount < limit then
  redis.call('ZADD', key, nowMs, member)
  allowed = 1
end

-- Step 4: Refresh TTL so idle keys clean themselves up automatically
redis.call('EXPIRE', key, ttlSecs)

-- Step 5: Get the oldest entry's score to calculate when the window clears
-- (useful for Retry-After calculation when blocked)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestScore = '0'
if #oldest > 0 then
  oldestScore = oldest[2]
end

return { currentCount, allowed, oldestScore }
`;

/**
 * Sliding Window Log rate limiter.
 *
 * @param {string} userId      - Unique identifier for the caller
 * @param {string} endpoint    - The API endpoint being checked (e.g. "/api/login")
 * @param {number} limit       - Max requests allowed within the window
 * @param {number} windowSecs  - Window size in seconds
 * @returns {Promise<{
 *   allowed: boolean,
 *   currentCount: number,    // requests in window BEFORE this one (if allowed, after = currentCount+1)
 *   limit: number,
 *   windowMs: number,
 *   remaining: number,       // limit - currentCount - (allowed ? 1 : 0)
 *   resetAt: number,         // Unix timestamp (sec) when oldest entry exits the window
 * }>}
 */
async function isAllowed(userId, endpoint, limit, windowSecs) {
  const key       = `rl:sw:${userId}:${endpoint}`;
  const nowMs     = Date.now();
  const windowMs  = windowSecs * 1000;

  // Unique member: combine timestamp + random suffix to prevent collision
  // if two requests arrive at the exact same millisecond
  const member    = `${nowMs}:${Math.random().toString(36).slice(2, 9)}`;

  // TTL: keep key alive for at least one full window duration after last request
  const ttlSecs   = windowSecs + 10;

  try {
    const result = await redis.eval(
      SLIDING_WINDOW_LUA,
      1,                    // number of KEYS
      key,                  // KEYS[1]
      String(nowMs),        // ARGV[1]
      String(windowMs),     // ARGV[2]
      String(limit),        // ARGV[3]
      member,               // ARGV[4]
      String(ttlSecs)       // ARGV[5]
    );

    const countBefore   = parseInt(result[0], 10);
    const allowed       = result[1] === 1;
    const oldestScoreMs = parseFloat(result[2]);

    // When does the oldest entry leave the window?
    // oldestEntryAt + windowMs = time when the window clears that entry
    const resetAt = oldestScoreMs > 0
      ? Math.ceil((oldestScoreMs + windowMs) / 1000)  // Unix sec
      : Math.floor(nowMs / 1000) + windowSecs;

    // remaining = how many more requests are allowed right now
    const countAfter  = allowed ? countBefore + 1 : countBefore;
    const remaining   = Math.max(0, limit - countAfter);

    return {
      allowed,
      currentCount: countAfter,
      limit,
      windowMs,
      remaining,
      resetAt,
    };
  } catch (err) {
    // Redis is down — fail open (allow request).
    // D7 adds a global fail-open/fail-closed config toggle.
    console.error('[slidingWindow] Redis error — failing open:', err.message);
    return {
      allowed: true,
      currentCount: 0,
      limit,
      windowMs,
      remaining: limit,
      resetAt: Math.floor(Date.now() / 1000) + windowSecs,
    };
  }
}

module.exports = { isAllowed };
