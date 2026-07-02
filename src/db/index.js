// src/db/index.js
// PostgreSQL connection pool — D5/D6
//
// Uses the 'pg' library's Pool for connection reuse across requests.
// All DB config comes from .env via dotenv.
//
// Usage:
//   const db = require('./db');
//   const result = await db.query('SELECT * FROM rules WHERE user_id = $1', [userId]);
//
// Interview talking point:
//   "I use a pg.Pool (not a single Client) so connections are reused across
//    requests. The pool size defaults to 10 — appropriate for a single Node
//    instance. At scale I'd tune max based on Postgres's max_connections limit
//    divided by the number of API instances."

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT) || 5432,
  user:     process.env.PG_USER     || 'postgres',
  password: process.env.PG_PASSWORD || '',
  database: process.env.PG_DATABASE || 'rate_limiter_db',
  max:      10,          // max pool connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  // Log but don't crash — the application can still serve cached/Redis-based decisions
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Run a parameterised query against PostgreSQL.
 * @param {string} text   - SQL query with $1, $2 placeholders
 * @param {Array}  params - Bound parameters
 * @returns {Promise<pg.QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log(`[DB] query (${duration}ms) rows=${result.rowCount}: ${text.slice(0, 80)}`);
    return result;
  } catch (err) {
    console.error('[DB] query error:', err.message, '| sql:', text.slice(0, 80));
    throw err;
  }
}

module.exports = { query, pool };
