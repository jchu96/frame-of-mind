# Implementation Plan: Command-Line Tool v0.6.0

**Track ID:** `cli-v06_20261113`
**Status:** Active - wave 0 merged (PR #147); wave 1 next

## Overview

Each wave merges before the next starts. Lanes inside a wave run in parallel,
and no code file has two owners in the same wave. `src/services/analyze.ts`
is the most contended file and has exactly one owner per wave. Lane order and
scope are in the [specification](./spec.md).

## Waves

| Wave | Lanes | Status |
| ---- | ----- | ------ |
| 0 | Groundwork, serial in one branch: command and transcription seams, upload retention (lane 3 Part A, ADR 0024), small fixes, parallel detail pass | `[x]` PR #147, merge commit `41766a0` |
| 1 | Declared clocks (with the issue #120 guard), in parallel with transcribe and its formats | `[ ]` |
| 2 | Word-accurate times, in parallel with ffmpeg helpers | `[ ]` |
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

## Verification

For every lane: a catalogue of planted violations written before the build,
each shown failing; the pull-request gate at the pushed head; one independent
review at the exact head. No lane raises a timeout, adds a retry or skips a
test to pass.
