# Database Agent Instructions

- Migrations are append-only after release.
- Use SQLite/D1-compatible SQL and STRICT tables.
- Back up remote D1 before schema changes.
- Never commit `.sqlite`, D1 exports, or production-derived fixtures.
