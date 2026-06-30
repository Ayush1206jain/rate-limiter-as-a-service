// server.js
// Entry point — starts the HTTP server

const app = require('./src/app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   Rate Limiter as a Service — Day 2          ║
║   Server running on  http://localhost:${PORT}   ║
║   Algorithms: Fixed Window ✓                 ║
║               Token Bucket  [Day 3]          ║
║               Sliding Window [Day 4]         ║
╚══════════════════════════════════════════════╝
  `);
});
