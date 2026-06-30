# Rate Limiter as a Service

> A pluggable rate limiting service supporting **Token Bucket**, **Sliding Window Log**, and **Fixed Window Counter** algorithms — backed by Redis for distributed counters with TTL, configurable per-user per-endpoint rules stored in PostgreSQL, and Express middleware any upstream service can drop in.

**Tech Stack:** Node.js · Express · Redis (ioredis) · PostgreSQL · JWT · Docker

---

## Features

| Feature | Status |
|---|---|
| Fixed Window Counter algorithm | ✅ Day 2 |
| Token Bucket algorithm | 🔄 Day 3 |
| Sliding Window Log algorithm | 🔄 Day 4 |
| JWT authentication | 🔄 Day 5 |
| Per-user per-endpoint rules (PostgreSQL) | 🔄 Day 5 |
| Audit logging + analytics endpoint | 🔄 Day 6 |
| Edge case handling + structured logging | 🔄 Day 7 |
| Jest unit tests + Postman collection | 🔄 Day 8 |
| Docker + docker-compose | 🔄 Day 9 |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Client / Upstream Service               │
└────────────────────────┬────────────────────────────────┘
                         │  POST /check
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    Express API Server                    │
│                                                         │
│  ┌─────────────┐    ┌──────────────────────────────┐   │
│  │ JWT Auth    │    │   /check Route               │   │
│  │ Middleware  │───▶│   Selects algorithm by        │   │
│  └─────────────┘    │   ?strategy= query param     │   │
│                     └──────────┬───────────────────┘   │
│                                │                        │
│            ┌───────────────────┼──────────────────┐    │
│            ▼                   ▼                  ▼    │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────┐│
│  │Fixed Window  │  │  Token Bucket    │  │  Sliding   ││
│  │  fixedWin.js │  │ tokenBucket.js   │  │  Window    ││
│  └──────┬───────┘  └────────┬─────────┘  └─────┬──────┘│
└─────────┼───────────────────┼─────────────────┼────────┘
          │    All algorithms use Redis          │
          ▼                   ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│                        Redis                            │
│  rl:fw:{userId}:{endpoint}:{bucket}  → Integer counter  │
│  rl:tb:{userId}:{endpoint}           → JSON {tokens,..} │
│  rl:sw:{userId}:{endpoint}           → Sorted Set       │
└─────────────────────────────────────────────────────────┘
          │
          │ Rule config + audit logs
          ▼
┌─────────────────────────────────────────────────────────┐
│                      PostgreSQL                         │
│   rules table  │  request_logs table                    │
└─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites
- Node.js 18+
- Redis (or Docker)
- PostgreSQL (for Day 6+)

### 1. Clone & install

```bash
git clone https://github.com/<your-username>/rate-limiter-as-a-service.git
cd rate-limiter-as-a-service
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Redis/PostgreSQL credentials
```

### 3. Start Redis (via Docker)

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

### 4. Run the server

```bash
npm run dev      # Development (file watch, auto-restart)
npm start        # Production
```

Server starts on `http://localhost:3000`

---

## API Reference

### `POST /check`

Check whether a request should be allowed or rate-limited.

**Request Body:**
```json
{
  "userId": "ayush",
  "endpoint": "/api/login",
  "limit": 10,
  "windowSecs": 60
}
```

**Query Params:**
| Param | Values | Default |
|---|---|---|
| `strategy` | `fixed_window` \| `token_bucket` \| `sliding_window` | `fixed_window` |

**Response — Allowed (200):**
```json
{
  "allowed": true,
  "remaining": 7,
  "resetAt": 1719744000,
  "limit": 10,
  "strategy": "fixed_window"
}
```

**Response — Blocked (429):**
```json
{
  "allowed": false,
  "remaining": 0,
  "resetAt": 1719744000,
  "retryAfter": 42,
  "message": "Too Many Requests — rate limit exceeded"
}
```

**Response Headers:**
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1719744000
Retry-After: 42         ← only on 429
```

---

### `GET /health`

```json
{ "status": "ok", "uptime": 120, "timestamp": "2026-06-30T11:00:00.000Z" }
```

---

## Algorithms

### Fixed Window Counter
Divides time into fixed-size windows. Uses Redis `INCR` + `EXPIRE`.

```
Key: rl:fw:{userId}:{endpoint}:{windowBucket}
windowBucket = floor(unixTimestamp / windowSecs)
```

**Tradeoff:** O(1) time + memory. Susceptible to boundary spike (2× burst at window reset).

---

### Token Bucket *(Day 3)*
Tokens refill at a constant rate. Allows short bursts.

```
Key: rl:tb:{userId}:{endpoint}
Value: JSON { tokens, lastRefill }
Update: atomic Lua script (read → compute → write)
```

**Tradeoff:** Burst-friendly. Atomic update is critical (race condition on read-write).

---

### Sliding Window Log *(Day 4)*
Tracks exact request timestamps in a sorted set. Most accurate.

```
Key: rl:sw:{userId}:{endpoint}
Value: Sorted Set  (score = Unix ms, member = request UUID)
Ops:  ZREMRANGEBYSCORE → ZCARD → ZADD  (all atomic via Lua)
```

**Tradeoff:** Most memory-intensive (one entry per request). No boundary spike.

---

## Redis Key Reference

| Algorithm | Key Pattern | Value |
|---|---|---|
| Fixed Window | `rl:fw:{userId}:{endpoint}:{bucket}` | Integer counter |
| Token Bucket | `rl:tb:{userId}:{endpoint}` | JSON `{tokens, lastRefill}` |
| Sliding Window | `rl:sw:{userId}:{endpoint}` | Sorted Set (score = timestamp ms) |

---

## Project Structure

```
rate-limiter-as-a-service/
├── src/
│   ├── algorithms/
│   │   ├── fixedWindow.js      # Fixed Window Counter
│   │   ├── tokenBucket.js      # Token Bucket (Day 3)
│   │   └── slidingWindow.js    # Sliding Window Log (Day 4)
│   ├── middleware/
│   │   ├── auth.js             # JWT verification (Day 5)
│   │   └── rateLimiter.js      # Express middleware wrapper (Day 9)
│   ├── routes/
│   │   ├── check.js            # POST /check
│   │   ├── rules.js            # POST/GET /rules (Day 5)
│   │   ├── analytics.js        # GET /analytics/:userId (Day 6)
│   │   └── auth.js             # POST /auth/token (Day 5)
│   ├── db/
│   │   ├── index.js            # PostgreSQL pool (Day 6)
│   │   └── schema.sql          # Table definitions
│   ├── redis.js                # ioredis client
│   └── app.js                  # Express app setup
├── tests/
│   ├── fixedWindow.test.js     # (Day 8)
│   ├── tokenBucket.test.js     # (Day 8)
│   └── slidingWindow.test.js   # (Day 8)
├── .env.example
├── .gitignore
├── package.json
├── server.js
└── README.md
```

---

## Design Decisions

**Why Redis over PostgreSQL for counters?**
Redis `INCR` is O(1) and adds ~0.1ms. A DB `INSERT + COUNT` adds 10–50ms — unacceptable on the hot path. Redis TTL handles window expiry automatically with no cleanup job.

**Why Lua scripts for Token Bucket and Sliding Window?**
Both require read-modify-write (fetch state → compute → update). Without atomicity, concurrent requests can both read the same state, both pass the limit check, and both be allowed when only one should. Lua scripts run atomically on the Redis server.

**Fail Open on Redis error**
If Redis is unreachable, requests are allowed through (fail open). This prioritises availability for general-purpose APIs. For high-cost operations (payments, AI inference), the system should fail closed (503). The choice is explicit and documented.

---

## License

MIT — built by [Ayush Jain](https://github.com/<your-username>) as an MTech placement project.
