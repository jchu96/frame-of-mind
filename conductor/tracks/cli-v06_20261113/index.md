# Track: Command-Line Tool v0.6.0 - Times an Editor Can Cut On

**ID:** `cli-v06_20261113`
**Status:** Active - wave 0 merged (PR #147); wave 1 next

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- Adversarial plan review: not yet recorded

## Progress

- Waves: 1/5 merged
- Wave 0 (groundwork) merged in PR #147, merge commit `41766a0`.
- Current focus: wave 1, declared clocks in parallel with transcribe and its
  formats; not yet started.
- The advisory `hosted-contracts` job is tracked in issues #96 and #113.

## Origin

Field use by a video editor running a private copy of the command-line tool.
The priority order was set by the owner on 2026-11-12: declared clocks first,
then word-accurate times, then asking again without uploading again.

## Rules for every lane

- The tool never modifies or deletes a local recording the user supplied.
- No lane edits files under `apps/web`. The website imports shared code that
  lanes do change, including `src/services/analyze.ts`, `src/domain/schemas.ts`
  and `src/adapters/gemini.ts`, so website checks still run on those changes.
- Upload retention is an operator setting (ADR 0024): a plain `analyze`
  keeps its upload until the provider expires it; `--retention run` or
  `--delete-upload` deletes it when the run ends.
- One clock: every time the tool computes or stores is seconds to the
  millisecond, labelled with its clock. Exact timecode at a declared frame
  rate is an opt-in output rendering only.

## Quick Links

- [Back to Tracks](../../tracks.md)
- [Product Context](../../product.md)
- [Tech Stack](../../tech-stack.md)
- [Workflow](../../workflow.md)
