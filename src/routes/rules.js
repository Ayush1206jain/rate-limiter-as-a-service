// src/routes/rules.js
// POST /rules   — Create or update a rate limit rule for a user+endpoint
// GET  /rules/:userId — Return all rules for a specific user
//
// Both routes are JWT-protected (auth middleware applied in app.js).
//
// Rules are stored in PostgreSQL: rules table
//   (id, user_id, endpoint, algorithm, limit, window_secs, created_at)
//
// The UNIQUE (user_id, endpoint) constraint means POST /rules is an "upsert":
//   if a rule already exists for that user+endpoint, it is updated.
//
// Interview talking point:
//   "Rules live in PostgreSQL so they survive restarts and are queryable for
//    auditing. On every /check call we fetch the rule from DB — in Day 7 I'll
//    add an in-process cache with a short TTL so the DB isn't hit on every
//    single request at high traffic."

const express = require('express');
const router  = express.Router();
const db      = require('../db');

const VALID_ALGORITHMS = ['FIXED_WINDOW', 'TOKEN_BUCKET', 'SLIDING_WINDOW'];

// Map from algorithm enum → strategy query param (used in response hint)
const ALGO_TO_STRATEGY = {
  FIXED_WINDOW:   'fixed_window',
  TOKEN_BUCKET:   'token_bucket',
  SLIDING_WINDOW: 'sliding_window',
};

// ---------------------------------------------------------------------------
// POST /rules
// Body: { userId, endpoint, algorithm, limit, windowSecs }
// Creates or updates the rule for userId+endpoint (upsert on conflict).
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { userId, endpoint, algorithm, limit, windowSecs } = req.body;

  // --- Validation ---
  const missing = ['userId', 'endpoint', 'algorithm', 'limit', 'windowSecs']
    .filter(f => req.body[f] === undefined || req.body[f] === null || req.body[f] === '');
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  const algo = String(algorithm).toUpperCase();
  if (!VALID_ALGORITHMS.includes(algo)) {
    return res.status(400).json({
      error: `Invalid algorithm: ${algorithm}`,
      valid: VALID_ALGORITHMS,
    });
  }

  const parsedLimit = parseInt(limit);
  const parsedWindow = parseInt(windowSecs);
  if (isNaN(parsedLimit) || parsedLimit <= 0) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  if (isNaN(parsedWindow) || parsedWindow <= 0) {
    return res.status(400).json({ error: 'windowSecs must be a positive integer' });
  }

  try {
    // Upsert: insert new rule, or update existing one if user_id+endpoint already exists
    const sql = `
      INSERT INTO rules (user_id, endpoint, algorithm, "limit", window_secs)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, endpoint)
      DO UPDATE SET
        algorithm   = EXCLUDED.algorithm,
        "limit"     = EXCLUDED."limit",
        window_secs = EXCLUDED.window_secs
      RETURNING *
    `;
    const { rows } = await db.query(sql, [userId, endpoint, algo, parsedLimit, parsedWindow]);
    const rule = rows[0];

    return res.status(201).json({
      message: 'Rule saved successfully',
      rule: {
        id:          rule.id,
        userId:      rule.user_id,
        endpoint:    rule.endpoint,
        algorithm:   rule.algorithm,
        limit:       rule.limit,
        windowSecs:  rule.window_secs,
        createdAt:   rule.created_at,
      },
      hint: `Use POST /check?strategy=${ALGO_TO_STRATEGY[algo]} to test this rule`,
    });
  } catch (err) {
    console.error('[POST /rules] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to save rule', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /rules/:userId
// Returns all rules configured for the given userId.
// ---------------------------------------------------------------------------
router.get('/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const sql = `
      SELECT id, user_id, endpoint, algorithm, "limit", window_secs, created_at
      FROM rules
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const { rows } = await db.query(sql, [userId]);

    const rules = rows.map(r => ({
      id:         r.id,
      userId:     r.user_id,
      endpoint:   r.endpoint,
      algorithm:  r.algorithm,
      limit:      r.limit,
      windowSecs: r.window_secs,
      createdAt:  r.created_at,
    }));

    return res.status(200).json({ userId, count: rules.length, rules });
  } catch (err) {
    console.error('[GET /rules] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch rules', detail: err.message });
  }
});

module.exports = router;
