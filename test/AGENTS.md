# Test Agent Instructions

## Scope

- Keep unit tests deterministic and offline.
- Test URL selection, timestamp math, transcript slicing, schemas, and artifact rendering.
- Mock MCP, Gemini, downloads, OAuth callbacks, browsers, and ffmpeg in workflow tests.
- Never use production meetings, transcripts, credentials, or signed URLs as fixtures.

## Commands

| Task | Command |
|------|---------|
| One file | `bunx vitest run test/object.test.ts` |
| All tests | `bun run test` |
| Watch | `bun run test:watch` |
