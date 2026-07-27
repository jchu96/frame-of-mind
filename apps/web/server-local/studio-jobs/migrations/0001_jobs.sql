PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS studio_job_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS studio_analysis_jobs (
  id TEXT PRIMARY KEY,
  root_job_id TEXT NOT NULL REFERENCES studio_analysis_jobs(id),
  retry_of_job_id TEXT REFERENCES studio_analysis_jobs(id),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
  idempotency_key TEXT NOT NULL UNIQUE,
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64
    AND input_digest NOT GLOB '*[^a-f0-9]*'
  ),
  stage TEXT NOT NULL CHECK (stage IN (
    'queued',
    'fetching_context',
    'uploading_to_gemini',
    'indexing',
    'interrogating',
    'rendering',
    'cleaning_up',
    'succeeded',
    'failed',
    'canceled',
    'interrupted'
  )),
  cancellation_requested_at TEXT,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  terminal_outcome TEXT CHECK (terminal_outcome IN (
    'succeeded',
    'failed',
    'canceled',
    'interrupted'
  )),
  terminal_at TEXT,
  terminal_code TEXT,
  terminal_message TEXT,
  run_id TEXT UNIQUE,
  projection_warning TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (attempt = 1 AND root_job_id = id AND retry_of_job_id IS NULL)
    OR
    (
      attempt > 1
      AND root_job_id != id
      AND retry_of_job_id IS NOT NULL
      AND retry_of_job_id != id
    )
  ),
  CHECK (
    (
      stage IN ('succeeded', 'failed', 'canceled', 'interrupted')
      AND terminal_outcome = stage
      AND terminal_at IS NOT NULL
    )
    OR
    (
      stage NOT IN ('succeeded', 'failed', 'canceled', 'interrupted')
      AND terminal_outcome IS NULL
      AND terminal_at IS NULL
      AND terminal_code IS NULL
      AND terminal_message IS NULL
    )
  ),
  CHECK (
    (stage = 'succeeded' AND run_id IS NOT NULL)
    OR
    (stage = 'cleaning_up')
    OR
    (stage != 'succeeded' AND run_id IS NULL)
  ),
  CHECK (
    projection_warning IS NULL
    OR (
      stage IN ('cleaning_up', 'succeeded')
      AND run_id IS NOT NULL
    )
  ),
  UNIQUE (root_job_id, attempt),
  UNIQUE (id, attempt)
) STRICT;

CREATE INDEX IF NOT EXISTS studio_analysis_jobs_created_idx
  ON studio_analysis_jobs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS studio_analysis_jobs_stage_idx
  ON studio_analysis_jobs (stage, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS studio_analysis_jobs_retry_idx
  ON studio_analysis_jobs (retry_of_job_id);

CREATE TABLE IF NOT EXISTS studio_analysis_job_events (
  job_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
  kind TEXT NOT NULL CHECK (kind IN (
    'transition',
    'progress',
    'cancellation_requested',
    'warning',
    'cleanup'
  )),
  stage TEXT NOT NULL CHECK (stage IN (
    'queued',
    'fetching_context',
    'uploading_to_gemini',
    'indexing',
    'interrogating',
    'rendering',
    'cleaning_up',
    'succeeded',
    'failed',
    'canceled',
    'interrupted'
  )),
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  PRIMARY KEY (job_id, sequence),
  FOREIGN KEY (job_id, attempt)
    REFERENCES studio_analysis_jobs(id, attempt) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS studio_analysis_job_events_time_idx
  ON studio_analysis_job_events (job_id, occurred_at, sequence);

INSERT OR IGNORE INTO studio_job_schema_migrations (
  version,
  name,
  applied_at
)
VALUES (
  1,
  'studio-analysis-jobs',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
