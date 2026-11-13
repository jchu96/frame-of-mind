# Implementation Plan: Command-Line Tool v0.6.0

**Track ID:** `cli-v06_20261113`
**Status:** Active - wave 0 open as draft PR #147

## Overview

Each wave merges before the next starts. Lanes inside a wave run in parallel,
and no code file has two owners in the same wave. `src/services/analyze.ts`
is the most contended file and has exactly one owner per wave. Lane order and
scope are in the [specification](./spec.md).

## Waves

| Wave | Lanes | Status |
| ---- | ----- | ------ |
| 0 | Groundwork, serial in one branch: command and transcription seams, upload retention (lane 3 Part A, ADR 0024), small fixes, parallel detail pass | `[~]` draft PR #147, in review |
| 1 | Declared clocks, in parallel with transcribe and its formats | `[ ]` |
| 2 | Word-accurate times, in parallel with ffmpeg helpers | `[ ]` |
| 3 | Ask again without uploading again (lane 3 Part B) | `[ ]` |
| 4 | Local MCP server | `[ ]` needs the ADR named in the specification |

## Wave 0 contents (PR #147)

- `[~]` Seams: command registration, output and app-data roots, transcription
  constants moved; `doctor` reports ffprobe.
- `[~]` Upload retention is an operator setting: flag, then
  `FRAME_OF_MIND_UPLOAD_RETENTION`, then `provider`.
- `[~]` Small fixes: `--version` through a linked install, `key set` with
  hidden input, best-N candidate selection, per-run notes, ffmpeg in the CI
  `check` job.
- `[~]` Parallel detail pass: `--detail-concurrency`, default 1, maximum 8.

## Supporting work

| Item | Status |
| ---- | ------ |
| Production dependency advisories cleared (PR #145) | `[x]` |
| Cached builds portable across checkouts; Bun pinned to 1.4.4 (PR #146) | `[x]` |
| Hosted sign-in workflow test made deterministic by upgrading the local database emulator (issues #96, #113) | `[~]` started 2026-11-13; no pull request yet |
| Website-only CI jobs scoped to changes that can affect the website, with required checks still reporting on every pull request | `[ ]` after the item above |

## Verification

For every lane: a catalogue of planted violations written before the build,
each shown failing; the pull-request gate at the pushed head; one independent
review at the exact head. No lane raises a timeout, adds a retry or skips a
test to pass.
