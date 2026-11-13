# Track: Command-Line Tool v0.6.0 - Times an Editor Can Cut On

**ID:** `cli-v06_20261113`
**Status:** Active - wave 0 open as draft PR #147

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- Adversarial plan review: not yet recorded

## Progress

- Waves: 0/5 merged
- Current focus: wave 0 (groundwork) in draft PR #147; its checks are on the
  pull request. The advisory `hosted-contracts` job is tracked in issues #96
  and #113.

## Origin

Field use by a video editor running a private copy of the command-line tool.
The priority order was set by the owner on 2026-11-12: declared clocks first,
then word-accurate times, then asking again without uploading again.

## Rules for every lane

- The tool never modifies or deletes a local recording the user supplied.
- No lane edits files under `apps/web`. The website imports shared code that
  lanes do change, including `src/services/analyze.ts`, `src/domain/schemas.ts`
  and `src/adapters/gemini.ts`, so website checks still run on those changes.
- Upload retention: on `main`, `analyze` deletes its upload when the run ends.
  PR #147 proposes ADR 0024, under which a plain `analyze` keeps its upload
  until the provider expires it and `--delete-upload` deletes it.

## Quick Links

- [Back to Tracks](../../tracks.md)
- [Product Context](../../product.md)
- [Tech Stack](../../tech-stack.md)
- [Workflow](../../workflow.md)
