# Track: Command-Line Tool v0.6.0 - Times an Editor Can Cut On

**ID:** `cli-v06_20261113`
**Status:** Active - waves 0 and 1 merged; wave 2 groundwork merged

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- Adversarial plan review: not yet recorded

## Progress

- Waves: 2/5 merged
- Wave 0 (groundwork) merged in PR #147, merge commit `41766a0`.
- Wave 1 merged: declared clocks (PR #151, `95ae242`) and transcribe
  (PR #152, `4b95a14`).
- Current focus: wave 2. Its exact-time groundwork merged (PRs #154, #156,
  #160); word-accurate times and ffmpeg helpers are not started. The time
  library moves to its own `exact-time` package first (plan, supporting work).
- The hosted lane runs nightly, on manual dispatch and before deploy, not in
  the pull-request gate (PR #149). Its known failures are tracked in issues
  #96 and #113.

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
- Exact times are whole frames at a rational rate, labelled with their
  clock; ticks, timecode with its stated drop-frame mode, and seconds are
  derived from them (ADR 0027, which supersedes the earlier
  seconds-to-the-millisecond rule). Times a model reports stay approximate
  and carry no frame or timecode.

## Quick Links

- [Back to Tracks](../../tracks.md)
- [Product Context](../../product.md)
- [Tech Stack](../../tech-stack.md)
- [Workflow](../../workflow.md)
