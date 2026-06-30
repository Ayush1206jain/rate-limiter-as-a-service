-- src/db/schema.sql
-- PostgreSQL schema — Implemented on d6
-- Run this file against your local Postgres instance:
--   psql -U postgres -d rate_limiter_db -f src/db/schema.sql

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------
-- rules table
-- Stores per-user per-endpoint rate limit configurations
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rules (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     VARCHAR(255) NOT NULL,
  endpoint    VARCHAR(255) NOT NULL,
  algorithm   VARCHAR(50)  NOT NULL CHECK (algorithm IN ('FIXED_WINDOW', 'TOKEN_BUCKET', 'SLIDING_WINDOW')),
  "limit"     INTEGER      NOT NULL CHECK ("limit" > 0),
  window_secs INTEGER      NOT NULL CHECK (window_secs > 0),
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, endpoint)
);

-- ----------------------------------------------------------------
-- request_logs table
-- Audit trail of every rate limit decision
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_logs (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     VARCHAR(255) NOT NULL,
  endpoint    VARCHAR(255) NOT NULL,
  status      VARCHAR(10)  NOT NULL CHECK (status IN ('ALLOWED', 'BLOCKED')),
  algorithm   VARCHAR(50)  NOT NULL,
  timestamp   TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Index for fast analytics queries per user
CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs (timestamp);
