// src/redis.js
// ioredis client — single shared connection for the whole app
// d2: Project Setup

require('dotenv').config();
const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  // reconnect strategy: retry up to 10 times
  retryStrategy(times) {
    if (times > 10) {
      console.error('[Redis] Max reconnection attempts reached. Giving up.');
      return null; // stop retrying
    }
    const delay = Math.min(times * 100, 3000);
    console.warn(`[Redis] Reconnecting in ${delay}ms... (attempt ${times})`);
    return delay;
  },
  lazyConnect: false,
});

redis.on('connect', () => {
  console.log('[Redis] Connected successfully on port', process.env.REDIS_PORT || 6379);
});

redis.on('error', (err) => {
  // Log but don't crash — allows fail-open behaviour in d7
  console.error('[Redis] Connection error:', err.message);
});

module.exports = redis;
