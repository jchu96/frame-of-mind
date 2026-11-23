# Implementation Plan: Command-Line Tool v0.6.0

**Track ID:** `cli-v06_20261113`
**Status:** Active - waves 0 and 1 merged (PRs #147, #151, #152); exact-time groundwork for wave 2 merged (PRs #154, #156, #160). Landing order: [landing-order.md](./landing-order.md)

## Overview

Each wave merges before the next starts. Lanes inside a wave run in parallel,
and no code file has two owners in the same wave. `src/services/analyze.ts`
is the most contended file and has exactly one owner per wave. Lane order and
scope are in the [specification](./spec.md).

## Waves

| Wave | Lanes | Status |
| ---- | ----- | ------ |
| 0 | Groundwork, serial in one branch: command and transcription seams, upload retention (lane 3 Part A, ADR 0024), small fixes, parallel detail pass | `[x]` PR #147, merge commit `41766a0` |
| 1 | Declared clocks (with the issue #120 guard), in parallel with transcribe and its formats | `[x]` PR #151, merge commit `95ae242`; PR #152, merge commit `4b95a14` |
| 2 | Word-accurate times, in parallel with ffmpeg helpers | `[~]` groundwork merged: the exact frame-based time module (PR #154, `1cb263a`; ADR 0027), precision-aware outputs (PR #156, `9ae8d93`), frame entry for decimal seconds and subtitle milliseconds (PR #160, `519f402`); word-accurate times and ffmpeg helpers not started |
| 3 | Ask again without uploading again (lane 3 Part B) | `[ ]` |
| 4 | Local MCP server | `[ ]` needs the ADR named in the specification |

## Wave 0 contents (PR #147, merged)

- `[x]` Seams: command registration, output and app-data roots, transcription
  constants moved; `doctor` reports ffprobe.
- `[x]` Upload retention is an operator setting: flag, then
  `FRAME_OF_MIND_UPLOAD_RETENTION`, then `provider`.
- `[x]` Small fixes: `--version` through a linked install, `key set` with
  hidden input, best-N candidate selection, per-run notes, ffmpeg in the CI
  `check` job.
- `[x]` Parallel detail pass: `--concurrency` (or
  `FRAME_OF_MIND_DETAIL_CONCURRENCY`), default 1, maximum 8.

## Supporting work

| Item | Status |
| ---- | ------ |
| Production dependency advisories cleared (PR #145) | `[x]` |
| Cached builds portable across checkouts; Bun pinned to 1.4.4 (PR #146) | `[x]` |
| Local database emulator upgrade to fix the hosted sign-in workflow test (issues #96, #113) | `[!]` tried 2026-11-13; still failed at Wrangler 4.148.0; no pull request |
| Hosted steps that fail on an unchanged tree leave the default pull-request gate and run nightly and before every deploy instead | `[ ]` replaces the item above |
| Transcription in the original language: every transcription request asks for the languages actually spoken, keeps mid-sentence switches and never translates; transcription has its own system instruction without the analysis guard's full-transcript line (PR #158, `cf07529`); optional `--transcript-language <BCP-47>` hint on `transcribe` and `analyze`, recorded as `requestedLanguage` (PR #159, `12c4456`) | `[x]` live fidelity on real non-English speech is not tested; one owner-run synthetic smoke is proposed in each pull request |
| Re-pin anything that pins a frame-of-mind commit (for example an agent plugin) to `12c4456` or later, so it gets original-language transcription and the hint; once a release carries the built bundle (landing order, item 8), pin the release instead | `[ ]` |
| Full serial `check`, not the pull-request gate: the hosted Better Auth workflow spend-cap assertion (`test:hosted-workflows-http:better-auth`) expected HTTP 429 and got 201 | `[ ]` seen 2026-11-18 in a builder's local run at `a61dd29`; cause unverified; outside that change; the pull-request gate and CI passed |
| Flaky in the pull-request gate (local lane): `test:studio-http` "same composer idempotency key replays the same job" got HTTP 500, not 200 (`scripts/test-local-studio-http.ts:66`) | `[ ]` seen 2026-11-18 on PR #158, CI run 44311269021 attempt 1; unrelated to the change; passed on rerun |
| Flaky in the pull-request gate (fast lane): `test/hosted-gate.test.ts` "MISS deploy-needs-hosted" failed with `HOSTED_DEPLOY status=FAIL reason=source_changed_during_check` | `[ ]` seen 2026-11-18 on PR #158, CI run 44311269021 attempt 2; unrelated to the change; passed on rerun |

## Verification

For every lane: a catalogue of planted violations written before the build,
each shown failing; the pull-request gate at the pushed head; one independent
review at the exact head. No lane raises a timeout, adds a retry or skips a
test to pass.
