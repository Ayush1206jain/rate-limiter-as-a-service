// src/routes/auth.js
// POST /auth/token — Issue a JWT for testing
//
// This is a SIMPLIFIED auth endpoint for demo/testing purposes.
// In production you would verify credentials against a user table.
// Here we just sign whatever userId the caller provides.
//
// Request body:  { userId: string }
// Response:      { token: string, userId: string, expiresIn: string }
//
// Interview talking point:
//   "In this project I simplified auth so any userId can get a token — the goal
//    is to demonstrate the JWT verification layer, not build a full auth system.
//    The key point is that /check and /rules use req.userId from the verified
//    token, not from the raw request body, so callers cannot impersonate others."

require('dotenv').config();
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');

const JWT_SECRET     = process.env.JWT_SECRET     || 'dev_secret_fallback';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';

/**
 * POST /auth/token
 * Body: { userId: string }
 */
router.post('/token', (req, res) => {
  const { userId } = req.body;

  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(400).json({ error: 'Missing required field: userId' });
  }

  const payload = { userId: userId.trim() };
  const token   = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  return res.status(200).json({
    token,
    userId: userId.trim(),
    expiresIn: JWT_EXPIRES_IN,
    hint: 'Use this token in: Authorization: Bearer <token>',
  });
});

module.exports = router;
