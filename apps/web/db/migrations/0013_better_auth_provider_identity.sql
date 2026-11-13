-- Better Auth 1.7.3+ identifies accounts by provider_id and account_id.
-- Keep legacy issuer values, but new accounts no longer write that field.
-- Duplicate provider identities fail the copy; never merge user ownership.
-- Wrangler supplies the migration transaction.
CREATE TABLE better_auth_account_next (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  issuer TEXT,
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
  UNIQUE (provider_id, account_id)
) STRICT;

INSERT INTO better_auth_account_next (id, account_id, provider_id, issuer, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)
SELECT id, account_id, provider_id, issuer, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at FROM better_auth_account;

DROP TABLE better_auth_account;
ALTER TABLE better_auth_account_next RENAME TO better_auth_account;
CREATE INDEX better_auth_account_user_idx
  ON better_auth_account (user_id, provider_id);
