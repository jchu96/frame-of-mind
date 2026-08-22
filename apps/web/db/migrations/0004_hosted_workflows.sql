-- Phase 3 may not make legacy projection rows visible by adding a creation
-- path. Keep the same named fail-closed posture as migration 0003.
CREATE TABLE hosted_workflow_migration_guard (
  legacy_row_count INTEGER NOT NULL,
  CONSTRAINT hosted_workflows_require_scoped_projection
    CHECK (legacy_row_count = 0)
) STRICT;

INSERT INTO hosted_workflow_migration_guard (legacy_row_count)
SELECT 1 FROM analysis_runs WHERE principal_sub = '__legacy_unclaimed__' LIMIT 1;
INSERT INTO hosted_workflow_migration_guard (legacy_row_count)
SELECT 1 FROM analysis_items WHERE principal_sub = '__legacy_unclaimed__' LIMIT 1;
INSERT INTO hosted_workflow_migration_guard (legacy_row_count)
SELECT 1 FROM analysis_run_registry WHERE principal_sub = '__legacy_unclaimed__' LIMIT 1;
INSERT INTO hosted_workflow_migration_guard (legacy_row_count)
SELECT 1 FROM video_analysis_runs WHERE principal_sub = '__legacy_unclaimed__' LIMIT 1;
INSERT INTO hosted_workflow_migration_guard (legacy_row_count)
SELECT 1 FROM video_analysis_items WHERE principal_sub = '__legacy_unclaimed__' LIMIT 1;

DROP TABLE hosted_workflow_migration_guard;

-- Phase 2 will produce this contract. Phase 3 owns only the consumer table and
-- synthetic fixtures; it does not implement upload or sealing.
CREATE TABLE hosted_media_receipts (
  principal_sub TEXT NOT NULL,
  media_id TEXT NOT NULL,
  gemini_file_name TEXT NOT NULL,
  gemini_file_uri TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('video/mp4', 'video/quicktime', 'video/webm')),
  retention TEXT NOT NULL CHECK (retention IN ('ephemeral', 'retained')),
  sealed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, media_id)
) STRICT;

CREATE TABLE hosted_analysis_jobs (
  principal_sub TEXT NOT NULL,
  job_id TEXT NOT NULL,
  principal_email TEXT,
  media_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, job_id),
  FOREIGN KEY (principal_sub, media_id)
    REFERENCES hosted_media_receipts (principal_sub, media_id)
) STRICT;

CREATE TABLE hosted_analysis_attempts (
  principal_sub TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  retry_of_attempt_id TEXT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 1000),
  idempotency_key TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL,
  immutable_input_json TEXT NOT NULL CHECK (json_valid(immutable_input_json)),
  stage TEXT NOT NULL CHECK (stage IN (
    'queued', 'fetch_context', 'ensure_gemini_file', 'transcribe', 'index',
    'interrogate', 'publish', 'cleanup', 'succeeded', 'failed', 'canceled',
    'indeterminate'
  )),
  spend_reserved_units INTEGER NOT NULL CHECK (spend_reserved_units > 0),
  cancellation_requested_at TEXT,
  run_id TEXT,
  error_code TEXT,
  cleanup_completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, attempt_id),
  UNIQUE (principal_sub, idempotency_key),
  UNIQUE (principal_sub, workflow_instance_id),
  UNIQUE (principal_sub, job_id, attempt_number),
  FOREIGN KEY (principal_sub, job_id)
    REFERENCES hosted_analysis_jobs (principal_sub, job_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_sub, retry_of_attempt_id)
    REFERENCES hosted_analysis_attempts (principal_sub, attempt_id)
) STRICT;

CREATE TABLE hosted_analysis_receipts (
  principal_sub TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL CHECK (length(receipt_sha256) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, attempt_id, step_name),
  FOREIGN KEY (principal_sub, attempt_id)
    REFERENCES hosted_analysis_attempts (principal_sub, attempt_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE hosted_analysis_events (
  principal_sub TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  code TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, attempt_id, sequence),
  FOREIGN KEY (principal_sub, attempt_id)
    REFERENCES hosted_analysis_attempts (principal_sub, attempt_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE hosted_principal_spend (
  principal_sub TEXT PRIMARY KEY,
  principal_email TEXT,
  cap_units INTEGER NOT NULL CHECK (cap_units >= 0),
  committed_units INTEGER NOT NULL CHECK (committed_units >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE hosted_spend_reservations (
  principal_sub TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  reserved_units INTEGER NOT NULL CHECK (reserved_units > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, attempt_id),
  FOREIGN KEY (principal_sub, attempt_id)
    REFERENCES hosted_analysis_attempts (principal_sub, attempt_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX hosted_media_expiry_idx
  ON hosted_media_receipts (principal_sub, expires_at);
CREATE INDEX hosted_jobs_created_idx
  ON hosted_analysis_jobs (principal_sub, created_at DESC, job_id DESC);
CREATE INDEX hosted_attempts_job_idx
  ON hosted_analysis_attempts (principal_sub, job_id, attempt_number DESC);
CREATE INDEX hosted_attempts_stage_idx
  ON hosted_analysis_attempts (principal_sub, stage, updated_at);
CREATE INDEX hosted_receipts_attempt_idx
  ON hosted_analysis_receipts (principal_sub, attempt_id, step_name);
CREATE INDEX hosted_events_attempt_idx
  ON hosted_analysis_events (principal_sub, attempt_id, sequence);
CREATE INDEX hosted_spend_active_idx
  ON hosted_spend_reservations (principal_sub, state, updated_at);
