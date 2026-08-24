-- Carry the sanitized analysis outcome (coverage + validation status) beside
-- the durable pair so hosted views and exports can render truncation honestly.
-- Nullable: rows projected before this migration simply have no outcome until
-- their run is re-projected. The run bundle remains authoritative.
ALTER TABLE analysis_runs ADD COLUMN outcome_json TEXT;
ALTER TABLE video_analysis_runs ADD COLUMN outcome_json TEXT;
