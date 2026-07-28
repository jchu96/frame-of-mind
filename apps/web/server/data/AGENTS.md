# RunStore Agent Instructions

- Keep local SQLite and D1 behavior contract-compatible.
- Keep `db/migrations/` and local bootstrap schema synchronized.
- Store JSON contracts plus normalized query columns; no media bytes.
- D1 uses the exact `DB` binding and never falls back to local storage.
- Add parity tests for every query or mutation.
- Keep schema-v2 meeting runs in `analysis_runs` and schema-v3 video-only runs
  in `video_analysis_runs`; never synthesize meeting/provider values for v3.
- Register every projected run ID and schema version in
  `analysis_run_registry` before upsert so cross-version collisions fail
  closed in both SQLite and D1.
