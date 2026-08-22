-- Phase 5a keeps the Phase 3 attempt contract intact while adding the
-- provider-duration and usage receipts needed to settle token reservations.
-- Existing synthetic Phase 3 media rows remain nullable, but job creation
-- rejects them until a trusted duration is present.
ALTER TABLE hosted_media_receipts ADD COLUMN duration_seconds REAL;

ALTER TABLE hosted_spend_reservations ADD COLUMN actual_units INTEGER;
ALTER TABLE hosted_spend_reservations ADD COLUMN reconciliation_code TEXT;

CREATE TABLE hosted_provider_usage (
  principal_sub TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  prompt_units INTEGER NOT NULL CHECK (prompt_units >= 0),
  output_units INTEGER NOT NULL CHECK (output_units >= 0),
  total_units INTEGER NOT NULL CHECK (total_units > 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, attempt_id, step_name),
  FOREIGN KEY (principal_sub, attempt_id)
    REFERENCES hosted_analysis_attempts (principal_sub, attempt_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX hosted_provider_usage_attempt_idx
  ON hosted_provider_usage (principal_sub, attempt_id, step_name);
