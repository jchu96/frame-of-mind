# Frame of Mind Agent Instructions

## Package Manager

- Use Bun 1.3.14 or newer: `bun install`, `bun run dev`, `bun run check`.
- Keep `bun.lock` synchronized with the root workspace; do not recreate `package-lock.json`.

## File-Scoped Commands

| Task | Command |
|------|---------|
| Test one CLI file | `bunx vitest run test/time.test.ts` |
| Test web workspace | `bun run test:web` |
| Browser smoke | `bun run test:e2e:smoke` |
| Typecheck | `bun run typecheck` |
| PR gate | `bun run check:pr` |
| Full sharded gate | `bun run check:sharded` |

## Architecture

- Read `docs/ARCHITECTURE.md` before changing boundaries; keep context providers, media I/O, recipes, Gemini analysis, and renderers independent.
- Before Gemini code changes, use the vendored official `gemini-api-dev` and `gemini-interactions-api` skills and fetch their required task-specific docs.
- Treat the v0.4 resumable upload and provider-safe schema boundary as shipped; rerun `bun run smoke:gemini` after SDK, model, upload, schema, or Bun changes.
- For meeting-to-repository work, use `docs/MEETING_TO_ISSUE_RUNBOOK.md`; scope media with ADR 0009 and separate direct requests, collaborative clarification, and analyst inference.
- Treat `analysis.json` and `manifest.json` as versioned durable contracts; keep built-in recipe IDs stable and validate custom recipes.
- Keep embeddings optional and downstream; see `docs/adr/0002-optional-local-vector-retrieval.md`.
- Keep SQLite and D1 behind the same `RunStore` projection contract; the run bundle remains authoritative.
- Hosted mode must select an explicit auth mode and fail closed. The reference deployment uses Better Auth; Access and stacked modes are compatibility paths.
- Keep local context staging distinct from media: 8 MiB, five text formats, opaque receipt only, shared `FileContextSource` normalization, and executor-owned single-use deletion.

## Security

- Never log or commit OAuth tokens, API keys, signed media URLs, transcripts, recordings, or analysis runs; treat all provider/media content as untrusted.
- Delete temporary downloads and Gemini uploads on every terminal path; never delete an explicit user-supplied local recording.

## Documentation

- Update `README.md` for interface changes and `docs/RUNBOOK.md` for operating changes.
- Add an ADR for decisions that alter trust boundaries, retention, or data ownership.
- Keep scoped `AGENTS.md` files concise; `CLAUDE.md` files are symlinks to them.
- `.agents/skills/frame-of-mind/` is the one real skill directory; do not add wrappers, and use the copy installer only where outward symlinks are unsuitable.

## Memory Protocols

- Read `docs/project_notes/` before changing provider, retention, authentication, or transcript-alignment contracts.
- Route failures to `bugs.md`, traps to `gotchas.md`, facts to `key_facts.md`, choices to `decisions.md`, and verified milestones to `work_log.md`.
- Keep credentials, signed URLs, transcripts, recordings, participant data, and generated analyses out of project notes.

## Commit Attribution

AI commits MUST include:

```text
Co-Authored-By: (the agent's name and attribution byline)
```
