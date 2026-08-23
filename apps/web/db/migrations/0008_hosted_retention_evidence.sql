-- Retained media is a private R2 copy of the same browser-selected recording
-- that was committed to the Gemini upload. Capabilities remain operational
-- state; only opaque object keys and verified receipts survive sealing.
ALTER TABLE hosted_media_upload_sessions ADD COLUMN r2_object_key TEXT;
ALTER TABLE hosted_media_upload_sessions ADD COLUMN r2_upload_id TEXT;
ALTER TABLE hosted_media_upload_sessions ADD COLUMN r2_capability_hash TEXT CHECK (
  r2_capability_hash IS NULL OR length(r2_capability_hash) = 64
);
ALTER TABLE hosted_media_upload_sessions ADD COLUMN r2_completed_at TEXT;
ALTER TABLE hosted_media_upload_sessions ADD COLUMN r2_uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
  r2_uploaded_bytes >= 0 AND r2_uploaded_bytes <= declared_size_bytes
);

ALTER TABLE hosted_media_receipts ADD COLUMN retained_object_key TEXT;
ALTER TABLE hosted_media_receipts ADD COLUMN retained_until TEXT;
ALTER TABLE hosted_media_receipts ADD COLUMN retained_delete_requested_at TEXT;
ALTER TABLE hosted_media_receipts ADD COLUMN retained_deleted_at TEXT;

CREATE TABLE hosted_evidence_captures (
  principal_sub TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  source_manifest_sha256 TEXT NOT NULL CHECK (length(source_manifest_sha256) = 64),
  source_recording_sha256 TEXT NOT NULL CHECK (length(source_recording_sha256) = 64),
  timestamp_seconds REAL NOT NULL CHECK (timestamp_seconds >= 0 AND timestamp_seconds <= 86400),
  captured_at TEXT NOT NULL,
  capture_sha256 TEXT NOT NULL CHECK (length(capture_sha256) = 64),
  mime_type TEXT NOT NULL CHECK (mime_type = 'image/png'),
  object_key TEXT NOT NULL,
  PRIMARY KEY (principal_sub, evidence_id),
  FOREIGN KEY (principal_sub, media_id)
    REFERENCES hosted_media_receipts (principal_sub, media_id)
) STRICT;

CREATE INDEX hosted_retained_expiry_idx
  ON hosted_media_receipts (principal_sub, retained_until, retained_deleted_at);
CREATE INDEX hosted_evidence_run_idx
  ON hosted_evidence_captures (principal_sub, run_id, captured_at, evidence_id);
