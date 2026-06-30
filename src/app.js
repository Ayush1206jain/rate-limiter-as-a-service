// src/app.js
// Express application setup

require('dotenv').config();
const express = require('express');

const checkRouter = require('./routes/check');

const app = express();

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger (lightweight — replaced by winston/pino on d7)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// --- Routes ---
app.use('/check', checkRouter);

// Health check endpoint — useful for Docker and load-balancer readiness probes
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[App Error]', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
