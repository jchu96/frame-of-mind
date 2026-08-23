-- Pending provider upload capabilities are operational state, not sealed media
-- receipts. Keeping them separate makes it impossible for an unfinished upload
-- to satisfy the hosted job foreign key.
CREATE TABLE hosted_media_upload_sessions (
  principal_sub TEXT NOT NULL,
  media_id TEXT NOT NULL,
  declared_size_bytes INTEGER NOT NULL CHECK (
    declared_size_bytes > 0 AND declared_size_bytes <= 2147483648
  ),
  declared_sha256 TEXT NOT NULL CHECK (length(declared_sha256) = 64),
  mime_type TEXT NOT NULL CHECK (
    mime_type IN ('video/mp4', 'video/quicktime', 'video/webm')
  ),
  duration_seconds REAL NOT NULL CHECK (
    duration_seconds > 0 AND duration_seconds <= 86400
  ),
  retention TEXT NOT NULL CHECK (retention IN ('ephemeral', 'retained')),
  upload_url_ciphertext TEXT,
  upload_url_iv TEXT,
  gemini_file_name TEXT,
  provider_part_bytes INTEGER CHECK (provider_part_bytes >= 262144),
  state TEXT NOT NULL CHECK (
    state IN (
      'creating', 'open', 'sealing', 'cleaning', 'sealed', 'abandoned',
      'cleanup_failed'
    )
  ),
  created_at TEXT NOT NULL,
  session_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, media_id)
) STRICT;

CREATE INDEX hosted_media_upload_open_idx
  ON hosted_media_upload_sessions (principal_sub, state, session_expires_at);
