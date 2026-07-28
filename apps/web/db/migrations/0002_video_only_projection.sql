CREATE TABLE IF NOT EXISTS analysis_run_registry (
  run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (2, 3))
) STRICT;

INSERT OR IGNORE INTO analysis_run_registry (run_id, schema_version)
SELECT run_id, 2 FROM analysis_runs;

CREATE TABLE IF NOT EXISTS video_analysis_runs (
  run_id TEXT PRIMARY KEY,
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
  imported_by TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS video_analysis_runs_completed_at_idx
  ON video_analysis_runs (completed_at DESC);

CREATE TABLE IF NOT EXISTS video_analysis_items (
  run_id TEXT NOT NULL REFERENCES video_analysis_runs(run_id) ON DELETE CASCADE,
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
  PRIMARY KEY (run_id, item_index)
) STRICT;

CREATE INDEX IF NOT EXISTS video_analysis_items_kind_idx
  ON video_analysis_items (kind);
CREATE INDEX IF NOT EXISTS video_analysis_items_accepted_idx
  ON video_analysis_items (accepted);
