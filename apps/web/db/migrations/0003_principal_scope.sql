-- Wrangler applies each D1 migration as one implicit transaction. D1 forbids
-- explicit BEGIN/COMMIT, so defer foreign-key checks through the table rebuild.
PRAGMA defer_foreign_keys = true;

ALTER TABLE analysis_items RENAME TO analysis_items_legacy;
ALTER TABLE analysis_runs RENAME TO analysis_runs_legacy;
ALTER TABLE analysis_run_registry RENAME TO analysis_run_registry_legacy;
ALTER TABLE video_analysis_items RENAME TO video_analysis_items_legacy;
ALTER TABLE video_analysis_runs RENAME TO video_analysis_runs_legacy;

CREATE TABLE analysis_runs (
  principal_sub TEXT NOT NULL,
  run_id TEXT NOT NULL,
  principal_email TEXT,
  meeting_id TEXT NOT NULL,
  meeting_title TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('bluedot', 'granola', 'file')),
  transport TEXT NOT NULL CHECK (transport IN ('mcp', 'api', 'file')),
  recipe_id TEXT NOT NULL,
  recipe_label TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  match_notes TEXT NOT NULL,
  accepted_count INTEGER NOT NULL,
  rejected_count INTEGER NOT NULL,
  analysis_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  imported_by TEXT,
  PRIMARY KEY (principal_sub, run_id)
) STRICT;

CREATE TABLE analysis_items (
  principal_sub TEXT NOT NULL,
  run_id TEXT NOT NULL,
  principal_email TEXT,
  item_index INTEGER NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance TEXT CHECK (importance IN ('high', 'medium', 'low')),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  screenshot TEXT,
  candidate_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (principal_sub, run_id, item_index),
  FOREIGN KEY (principal_sub, run_id)
    REFERENCES analysis_runs(principal_sub, run_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE analysis_run_registry (
  principal_sub TEXT NOT NULL,
  run_id TEXT NOT NULL,
  principal_email TEXT,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (2, 3)),
  PRIMARY KEY (principal_sub, run_id)
) STRICT;

CREATE TABLE video_analysis_runs (
  principal_sub TEXT NOT NULL,
  run_id TEXT NOT NULL,
  principal_email TEXT,
  recipe_id TEXT NOT NULL,
  recipe_label TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  match_notes TEXT NOT NULL,
  accepted_count INTEGER NOT NULL,
  rejected_count INTEGER NOT NULL,
  analysis_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  imported_by TEXT,
  PRIMARY KEY (principal_sub, run_id)
) STRICT;

CREATE TABLE video_analysis_items (
  principal_sub TEXT NOT NULL,
  run_id TEXT NOT NULL,
  principal_email TEXT,
  item_index INTEGER NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance TEXT CHECK (importance IN ('high', 'medium', 'low')),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  screenshot TEXT,
  candidate_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (principal_sub, run_id, item_index),
  FOREIGN KEY (principal_sub, run_id)
    REFERENCES video_analysis_runs(principal_sub, run_id) ON DELETE CASCADE
) STRICT;

INSERT INTO analysis_runs (
  principal_sub, run_id, principal_email, meeting_id, meeting_title,
  provider, transport, recipe_id, recipe_label, model, started_at,
  completed_at, match_notes, accepted_count, rejected_count, analysis_json,
  manifest_json, imported_at, imported_by
)
SELECT
  '__legacy_unclaimed__', run_id, NULL, meeting_id, meeting_title,
  provider, transport, recipe_id, recipe_label, model, started_at,
  completed_at, match_notes, accepted_count, rejected_count, analysis_json,
  manifest_json, imported_at, imported_by
FROM analysis_runs_legacy;

INSERT INTO analysis_items (
  principal_sub, run_id, principal_email, item_index, accepted, kind, title,
  summary, importance, start_time, end_time, screenshot, candidate_json,
  result_json
)
SELECT
  '__legacy_unclaimed__', run_id, NULL, item_index, accepted, kind, title,
  summary, importance, start_time, end_time, screenshot, candidate_json,
  result_json
FROM analysis_items_legacy;

INSERT INTO analysis_run_registry (
  principal_sub, run_id, principal_email, schema_version
)
SELECT '__legacy_unclaimed__', run_id, NULL, schema_version
FROM analysis_run_registry_legacy;

INSERT INTO video_analysis_runs (
  principal_sub, run_id, principal_email, recipe_id, recipe_label, model,
  started_at, completed_at, match_notes, accepted_count, rejected_count,
  analysis_json, manifest_json, imported_at, imported_by
)
SELECT
  '__legacy_unclaimed__', run_id, NULL, recipe_id, recipe_label, model,
  started_at, completed_at, match_notes, accepted_count, rejected_count,
  analysis_json, manifest_json, imported_at, imported_by
FROM video_analysis_runs_legacy;

INSERT INTO video_analysis_items (
  principal_sub, run_id, principal_email, item_index, accepted, kind, title,
  summary, importance, start_time, end_time, screenshot, candidate_json,
  result_json
)
SELECT
  '__legacy_unclaimed__', run_id, NULL, item_index, accepted, kind, title,
  summary, importance, start_time, end_time, screenshot, candidate_json,
  result_json
FROM video_analysis_items_legacy;

CREATE TABLE principal_scope_migration_guard (
  legacy_row_count INTEGER NOT NULL,
  CONSTRAINT principal_scope_requires_empty_legacy_tables
    CHECK (legacy_row_count = 0)
) STRICT;

INSERT INTO principal_scope_migration_guard (legacy_row_count)
SELECT 1 FROM analysis_runs_legacy LIMIT 1;
INSERT INTO principal_scope_migration_guard (legacy_row_count)
SELECT 1 FROM analysis_items_legacy LIMIT 1;
INSERT INTO principal_scope_migration_guard (legacy_row_count)
SELECT 1 FROM analysis_run_registry_legacy LIMIT 1;
INSERT INTO principal_scope_migration_guard (legacy_row_count)
SELECT 1 FROM video_analysis_runs_legacy LIMIT 1;
INSERT INTO principal_scope_migration_guard (legacy_row_count)
SELECT 1 FROM video_analysis_items_legacy LIMIT 1;

DROP TABLE principal_scope_migration_guard;
DROP TABLE analysis_items_legacy;
DROP TABLE analysis_runs_legacy;
DROP TABLE analysis_run_registry_legacy;
DROP TABLE video_analysis_items_legacy;
DROP TABLE video_analysis_runs_legacy;

CREATE INDEX analysis_runs_completed_at_idx
  ON analysis_runs (principal_sub, completed_at DESC, imported_at DESC, run_id DESC);
CREATE INDEX analysis_runs_meeting_id_idx
  ON analysis_runs (principal_sub, meeting_id);
CREATE INDEX analysis_items_kind_idx
  ON analysis_items (principal_sub, kind);
CREATE INDEX analysis_items_accepted_idx
  ON analysis_items (principal_sub, accepted);
CREATE UNIQUE INDEX analysis_run_registry_run_id_unique_idx
  ON analysis_run_registry (run_id);
CREATE INDEX video_analysis_runs_completed_at_idx
  ON video_analysis_runs (principal_sub, completed_at DESC, imported_at DESC, run_id DESC);
CREATE INDEX video_analysis_items_kind_idx
  ON video_analysis_items (principal_sub, kind);
CREATE INDEX video_analysis_items_accepted_idx
  ON video_analysis_items (principal_sub, accepted);
