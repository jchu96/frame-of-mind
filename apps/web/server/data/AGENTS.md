# RunStore Agent Instructions

- Keep local SQLite and D1 behavior contract-compatible.
- Keep `db/migrations/` and local bootstrap schema synchronized.
- Store JSON contracts plus normalized query columns; no media bytes.
- D1 uses the exact `DB` binding and never falls back to local storage.
- Add parity tests for every query or mutation.
