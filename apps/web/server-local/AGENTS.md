# Local Studio Server Instructions

## Package Manager

Use **Bun 1.3.14+**: `bun install --frozen-lockfile`, `bun test`, `bun run typecheck:web`.

## Boundary

- Keep this tree local-only and register it only when `FRAME_OF_MIND_STUDIO=1`.
- Keep imports out of `apps/web/server/`, shared client code, and Cloudflare builds.
- Extend `scripts/check-cloudflare-boundary.ts` for every new local-control-plane marker.
- Require loopback Host/peer validation everywhere. Permit only the inert
  `/__studio/launch` page and bounded bootstrap mutation before authentication;
  require the Studio session for every data-bearing page, run API, and
  `/api/studio/*`.
- Require same-origin JSON semantics and bounded request bodies for mutations.

## Credentials And Media

- Resolve API keys from environment first, then process memory.
- Never return, log, persist, or place API keys in SQLite.
- Preserve exact-resource private OAuth token-file isolation.
- Stream recording bytes to private staging outside the checkout; never buffer whole videos.
- Never put recording bytes, paths, transcripts, provider payloads, or signed URLs in logs.

## File-Scoped Commands

| Task | Command |
|---|---|
| Local server tests | `bun test apps/web/test/<name>.test.ts` |
| Web typecheck | `bun run typecheck:web` |
| Local Studio build | `FRAME_OF_MIND_STUDIO=1 FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN=synthetic-build-token-1234567890 bun run build:web` |
| Hosted exclusion | `bun run build:web:cloudflare` |

## Commit Attribution

AI commits MUST include:

```text
Co-Authored-By: (the agent's name and attribution byline)
```
