# Web Workspace Agent Instructions

- Use Bun and keep `bun.lock` synchronized from the repository root.
- Read `docs/WEB_WORKSPACE.md`, `docs/CLOUDFLARE_DEPLOYMENT.md`, and ADR 0005
  before changing storage, imports, authentication, or deployment.
- Build both targets after server changes: `bun run build:web` and
  `bun run build:web:cloudflare`.
- SQLite/D1 are projections. Never make the database the sole run source.
- Do not add automatic cloud sync, media storage, or public routes.
- Hosted mode must fail closed and validate the Cloudflare Access JWT.
