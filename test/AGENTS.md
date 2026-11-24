# Test Agent Instructions

## Scope

- Keep unit tests deterministic and offline.
- Test URL selection, timestamp math, transcript slicing, schemas, and artifact rendering.
- Mock MCP, Gemini, downloads, OAuth callbacks, browsers, and ffmpeg in workflow tests.
- Never use production meetings, transcripts, credentials, or signed URLs as fixtures.

## Tests that start a real tool

- Use ffmpeg, ffprobe, a browser or the built CLI for at most one path per user-facing command and one path per harm named in a class 1 fault list. Use a stand-in process or pure functions for other paths.
- Each real-tool test must finish within a quarter of the default test timeout on a 2-core machine. Split a slower test or shrink its fixture. Never raise the timeout, add a retry or skip the test to pass.
- Generate fixtures once per file and share them. Each test checks one thing.
- When adding a test, name the test it replaces in the pull request or explain why none can go.
- Briefs and reviews name the harm a test must catch. They never ask for a test count.

On 2026-11-24, a wave 2 test that repeatedly started real media tools was reported to have timed out on a 2-core CI runner. Review by: 2026-12-24 (protects: tooling)

## Commands

| Task | Command |
|------|---------|
| One file | `bunx vitest run test/object.test.ts` |
| All tests | `bun run test` |
| Watch | `bun run test:watch` |
