# Shared Web Contract Instructions

## Boundary

- Keep shared contracts portable across the Nuxt client and Nitro server.
- Do not import Vue, Nitro, Bun, Node, database, or provider SDK APIs here.
- Reuse canonical `src/domain/` contracts instead of copying durable schemas.
- Keep DTOs bounded, JSON-serializable, and explicit about optional fields.
- Use opaque IDs; never expose filesystem paths, credentials, transcripts,
  provider payloads, signed URLs, or recording bytes.
- Keep binary upload bodies outside JSON DTOs.
- Update route producers, UI consumers, and contract tests in the same change.

## File-Scoped Commands

| Task | Command |
|------|---------|
| Typecheck web contracts | `bun run typecheck:web` |
| Test web consumers | `bun run test:web` |
| Verify hosted portability | `bun run build:web:cloudflare` |

## Commit Attribution

AI commits MUST include:

```text
Co-Authored-By: (the agent's name and attribution byline)
```
