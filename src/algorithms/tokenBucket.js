// src/algorithms/tokenBucket.js
// Token Bucket Rate Limiter
//
// Algorithm:
//   1. Redis key: rl:tb:{userId}:{endpoint}  → JSON string { tokens, lastRefill }
//   2. On each request (atomically via Lua):
//      a. Fetch current state (or initialise with maxTokens)
//      b. Calculate tokens earned since lastRefill:
//           earned = (nowMs - lastRefill) / 1000 * refillRate
//      c. Cap total tokens at maxTokens
//      d. If tokens >= 1: deduct 1, allow; else: reject
//      e. Write back { tokens, lastRefill: nowMs }
//   3. Atomicity is CRITICAL — without it, concurrent requests read the same
//      token count and both pass a check only one should pass.
//      Solution: single Lua script evaluated via EVAL on the Redis server.
//
// Key format:  rl:tb:{userId}:{endpoint}
// Value:       JSON string  { tokens: number, lastRefill: number (ms) }
//
// Interview talking point:
//   "I use a Lua script instead of a multi-step pipeline because Lua scripts
//    execute atomically on the Redis server — no interleaving from other clients.
//    This is the canonical pattern for any read-modify-write in Redis."

const redis = require('../redis');

// ---------------------------------------------------------------------------
// Lua script — runs atomically on the Redis server
// KEYS[1] = the token bucket key
// ARGV[1] = nowMs         (current timestamp in milliseconds, as string)
// ARGV[2] = maxTokens     (bucket capacity)
// ARGV[3] = refillRate    (tokens per second, fractional OK)
// ARGV[4] = ttlSecs       (key TTL in seconds — cleanup idle keys)
//
// Returns a table: { allowed (0|1), tokensAfter, nextRefillAtMs }
// ---------------------------------------------------------------------------
const TOKEN_BUCKET_LUA = `
local key         = KEYS[1]
local nowMs       = tonumber(ARGV[1])
local maxTokens   = tonumber(ARGV[2])
local refillRate  = tonumber(ARGV[3])
local ttlSecs     = tonumber(ARGV[4])

-- Fetch existing state or initialise
local raw = redis.call('GET', key)
local tokens, lastRefill

if raw then
  local state  = cjson.decode(raw)
  tokens       = state['tokens']
  lastRefill   = state['lastRefill']
else
  -- First request — start with a full bucket
  tokens     = maxTokens
  lastRefill = nowMs
end

-- Calculate tokens earned since last refill
local elapsedSecs = (nowMs - lastRefill) / 1000
local earned      = elapsedSecs * refillRate
tokens = math.min(maxTokens, tokens + earned)

-- Determine outcome
local allowed = 0
if tokens >= 1 then
  tokens  = tokens - 1
  allowed = 1
end

-- Persist updated state
local newState = cjson.encode({ tokens = tokens, lastRefill = nowMs })
redis.call('SET', key, newState, 'EX', ttlSecs)

-- Calculate when the next token will be available (ms from now)
local nextTokenInMs = 0
if allowed == 0 then
  -- Time to earn 1 token at current refill rate
  nextTokenInMs = math.ceil((1 / refillRate) * 1000)
end

return { allowed, tostring(tokens), tostring(nextTokenInMs) }
`;

/**
 * Token Bucket rate limiter.
 *
 * @param {string} userId       - Unique identifier for the caller
 * @param {string} endpoint     - The API endpoint being checked (e.g. "/api/login")
 * @param {number} maxTokens    - Bucket capacity (also: initial token count)
 * @param {number} refillRate   - Tokens added per second (fractional values OK, e.g. 0.5 = 1 per 2 sec)
 * @returns {Promise<{
 *   allowed: boolean,
 *   tokensRemaining: number,
 *   maxTokens: number,
 *   nextRefillAt: number   // Unix timestamp (sec) when at least 1 token will be available
 * }>}
 */
async function isAllowed(userId, endpoint, maxTokens, refillRate) {
  const key    = `rl:tb:${userId}:${endpoint}`;
  const nowMs  = Date.now();

  // TTL: keep the key alive for one full refill cycle beyond current time
  // so an idle key eventually expires automatically.
  // Minimum 60 s, or however long it takes to fill the whole bucket from zero.
  const ttlSecs = Math.max(60, Math.ceil(maxTokens / refillRate) + 10);

  try {
    const result = await redis.eval(
      TOKEN_BUCKET_LUA,
      1,          // number of KEYS
      key,        // KEYS[1]
      String(nowMs),          // ARGV[1]
      String(maxTokens),      // ARGV[2]
      String(refillRate),     // ARGV[3]
      String(ttlSecs)         // ARGV[4]
    );

    const allowed          = result[0] === 1;
    const tokensRemaining  = parseFloat(result[1]);
    const nextTokenInMs    = parseInt(result[2], 10);

    // nextRefillAt: when will at least 1 token be available?
    const nextRefillAt = allowed
      ? Math.floor(nowMs / 1000)                               // already allowed — now
      : Math.floor((nowMs + nextTokenInMs) / 1000);            // blocked — future

    return {
      allowed,
      tokensRemaining: Math.floor(tokensRemaining * 100) / 100, // 2 decimal places
      maxTokens,
      refillRate,
      nextRefillAt,
    };
  } catch (err) {
    // Redis is down — fail open (allow request).
    // D7 adds a global fail-open/fail-closed config toggle.
    console.error('[tokenBucket] Redis error — failing open:', err.message);
    return {
      allowed: true,
      tokensRemaining: maxTokens,
      maxTokens,
      refillRate,
      nextRefillAt: Math.floor(Date.now() / 1000),
    };
  }
}

module.exports = { isAllowed };
