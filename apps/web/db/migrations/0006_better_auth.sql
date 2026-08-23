-- Better Auth 1.7.1 core schema for the request-scoped Cloudflare D1 adapter.
-- Dates are ISO-8601 text because Better Auth's D1 adapter declares
-- supportsDates=false and serializes Date inputs before writing.
CREATE TABLE better_auth_user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  image TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  access_sub TEXT
) STRICT;

CREATE TABLE better_auth_session (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES better_auth_user(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE better_auth_account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES better_auth_user(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (issuer, account_id)
) STRICT;

CREATE TABLE better_auth_verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE better_auth_rate_limit (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL CHECK (count >= 0),
  last_request INTEGER NOT NULL
) STRICT;

CREATE TABLE hosted_auth_invites (
  email TEXT PRIMARY KEY CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  claimed_user_id TEXT REFERENCES better_auth_user(id) ON DELETE SET NULL,
  invited_at TEXT NOT NULL,
  claimed_at TEXT
) STRICT;

CREATE INDEX better_auth_session_user_idx
  ON better_auth_session (user_id, expires_at);
CREATE INDEX better_auth_account_user_idx
  ON better_auth_account (user_id, provider_id);
CREATE INDEX better_auth_verification_identifier_idx
  ON better_auth_verification (identifier, expires_at);
CREATE UNIQUE INDEX better_auth_user_access_sub_idx
  ON better_auth_user (access_sub) WHERE access_sub IS NOT NULL;
CREATE INDEX hosted_auth_invites_claimed_user_idx
  ON hosted_auth_invites (claimed_user_id);
