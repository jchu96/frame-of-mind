-- Separate authentication from hosted access approval. Existing invitations
-- remain approved so the migration does not interrupt current members.
ALTER TABLE hosted_auth_invites ADD COLUMN state TEXT NOT NULL DEFAULT 'approved'
  CHECK (state IN ('requested', 'approved', 'revoked'));
ALTER TABLE hosted_auth_invites ADD COLUMN requested_at TEXT;
ALTER TABLE hosted_auth_invites ADD COLUMN approved_at TEXT;
ALTER TABLE hosted_auth_invites ADD COLUMN decided_by TEXT;

UPDATE hosted_auth_invites
SET approved_at = COALESCE(approved_at, invited_at)
WHERE state = 'approved';

CREATE INDEX hosted_auth_invites_state_idx
  ON hosted_auth_invites (state, requested_at);

CREATE TABLE hosted_access_request_rate_limit (
  key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1)
) STRICT;

CREATE INDEX hosted_access_request_rate_limit_window_idx
  ON hosted_access_request_rate_limit (window_started_at);
