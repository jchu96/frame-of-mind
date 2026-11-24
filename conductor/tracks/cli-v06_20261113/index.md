# Track: Command-Line Tool v0.6.0 - Times an Editor Can Cut On

**ID:** `cli-v06_20261113`
**Status:** Active. Waves 0 through 2 have merged.

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- Independent plan review completed on 2026-11-24.

## Progress

- Waves merged: 3 of 5
- Wave 0 (groundwork) merged in PR #147, merge commit `41766a0`.
- Wave 1 merged: declared clocks (PR #151, `95ae242`) and transcribe
  (PR #152, `4b95a14`).
- Wave 2 merged in PR #180 (speech-edge proposals, `979016c`), PR #181
  (local media commands, part 1, `d01caba`) and PR #182 (build-cache prune
  fix, `a897141`).
- The release bundle (PR #173, `0f83dcf`) and adoption of the pinned
  `exact-time` library (PR #174, `c018782`) have merged.
- Current focus: prune the real-tool tests added in wave 2. See the [remaining work in order](./plan.md#remaining-work).
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
