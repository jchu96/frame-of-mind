-- Reserve one magic-link send per invited email for each 60-second window.
-- The nullable column preserves every existing invite and Wrangler migration
-- tracking makes a replay after successful application an idempotent no-op.
ALTER TABLE hosted_auth_invites ADD COLUMN last_magic_link_at TEXT;
