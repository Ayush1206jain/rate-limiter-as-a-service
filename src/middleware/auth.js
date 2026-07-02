// src/middleware/auth.js
// JWT Authentication Middleware — D5
//
// Usage:  router.post('/rules', auth, handler)
//
// What it does:
//   1. Reads the Authorization header: "Bearer <token>"
//   2. Verifies the token with jsonwebtoken using JWT_SECRET from .env
//   3. Attaches req.userId (from the token payload) for downstream handlers
//   4. Returns 401 with a clear message if the token is missing or invalid
//
// Interview talking point:
//   "I deliberately kept JWT auth simple for this demo — the /auth/token endpoint
//    accepts a userId and signs a token, no password needed. In production you'd
//    integrate with an identity provider. The important part is that every
//    privileged route (rule creation) requires a verified token, demonstrating
//    the auth layer separation from the business logic."

require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_fallback';

/**
 * Express middleware — verifies JWT and attaches req.userId.
 * Apply to any route that should be protected.
 */
function auth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorised — missing or malformed Authorization header',
      hint: 'Expected: Authorization: Bearer <token>',
    });
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;   // attach for downstream use
    next();
  } catch (err) {
    const isExpired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: isExpired ? 'Unauthorised — token has expired' : 'Unauthorised — invalid token',
      detail: err.message,
    });
  }
}

module.exports = auth;
