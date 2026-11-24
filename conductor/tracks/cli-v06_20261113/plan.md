# Implementation Plan: Command-Line Tool v0.6.0

**Track ID:** `cli-v06_20261113`
**Status:** Active. Waves 0 through 2 have merged. The plan was independently reviewed on 2026-11-24.

## Overview

Lanes that run in parallel never change the same code file. `src/services/analyze.ts`
is the most contended file and has exactly one owner per wave. The [specification](./spec.md) describes the lanes.
[Remaining work](#remaining-work) gives their current order.

## Waves

| Wave | Lanes | Status |
| ---- | ----- | ------ |
| 0 | Groundwork, serial in one branch: command and transcription seams, upload retention (lane 3 Part A, ADR 0024), small fixes, parallel detail pass | `[x]` PR #147, merge commit `41766a0` |
| 1 | Declared clocks (with the issue #120 guard), in parallel with transcribe and its formats | `[x]` PR #151, merge commit `95ae242`; PR #152, merge commit `4b95a14` |
| 2 | Speech-edge proposals and local media commands (part 1) | `[x]` PR #180 (`979016c`) proposes speech edges. PR #181 (`d01caba`) adds `probe`, `verify`, `proxy`, `slice` and `frame`. PR #182 (`a897141`) fixes build-cache pruning. |
| 3 | Ask again without uploading again (lane 3 Part B) | `[ ]` Whole-file questions first. |
| 4 | Local MCP server | `[ ]` Needs the ADR named in the specification. The read tools and first two actions precede wave 3. The `ask` action follows it. |

Wave 2 built on the exact frame-based time module (PR #154, `1cb263a`, ADR 0027),
precision-aware outputs (PR #156, `9ae8d93`) and frame entry for decimal
seconds and subtitle milliseconds (PR #160, `519f402`).

## Remaining work

1. Prune the real-tool tests added in wave 2.
2. Have `doctor` report media capabilities for each command and list what a killed run left behind, with an option to remove it.
3. Teach `exact-time` to read timeline-interchange times, release the library, then pin that release here.
4. Read the timeline file exported with a sequence to look up the source file and frame at a given sequence time.
5. Pin and cache ffmpeg in CI.
6. Ship the local MCP server's four read tools, then its `analyze` and `transcribe` actions, enabled by launch flags.
7. In wave 3, reuse the upload to ask another question about the whole file. Asking about a time range is a follow-up.
8. Add the MCP `ask` action after wave 3.

The ffmpeg joiner that builds one reel from several clips is on hold until someone needs it.

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
| Local database emulator upgrade to fix the hosted sign-in workflow test (issues #96, #113) | `[!]` tried 2026-11-13 on a local branch and reported still failing at Wrangler 4.148.0; no pull request, so no CI record of that trial |
| Hosted steps that fail on an unchanged tree leave the default pull-request gate and run nightly and before every deploy instead | `[x]` PR #149; replaces the item above; `docs/HOSTED_GATE_QUARANTINE.md` |
| Transcription in the original language: every transcription request asks for the languages actually spoken, keeps mid-sentence switches and never translates; transcription has its own system instruction without the analysis guard's full-transcript line (PR #158, `cf07529`); optional `--transcript-language <BCP-47>` hint on `transcribe` and `analyze`, recorded as `requestedLanguage` (PR #159, `12c4456`) | `[x]` live fidelity on real non-English speech is not tested; one owner-run synthetic smoke is proposed in each pull request |
| Update consumers that pin a source commit to use the release bundle | `[ ]` |
| Full serial `check`, not the pull-request gate: the hosted Better Auth workflow spend-cap assertion (`test:hosted-workflows-http:better-auth`) expected HTTP 429 and got 201 | `[ ]` seen 2026-11-18 in a builder's local run at `a61dd29`; cause unverified; outside that change; the pull-request gate and CI passed |
| Adopt the pinned `exact-time` release | `[x]` PR #174, merge commit `c018782` |
| Publish the standalone CLI bundle with fingerprints on version tags | `[x]` PR #173, merge commit `0f83dcf` |
| Silent `frameofmind` command fixed; upload retention stated truthfully (PR #161, `b3a2869`) | `[x]` |
| Teaching-points recipe, contact sheet, run `--label`, settled screenshots for that recipe only, ADR 0029 proposed (PR #162, `06f2e32`) | `[x]` one live run reported by the requester; ADR 0029 is still a proposal |
| Screenshot seek is forward-only: at very low frame rates a cited time can get the next frame instead of the one on screen, or no screenshot when the last frame has passed | `[ ]` reported 2026-11-23 by the review of PR #162 on synthetic low-frame-rate clips; the seek code is the same on `main` |
| Flaky in the pull-request gate (local lane): `test:studio-http` "same composer idempotency key replays the same job" got HTTP 500, not 200 (`scripts/test-local-studio-http.ts:66`) | `[ ]` seen 2026-11-18 on PR #158, CI run 44311269021 attempt 1; passed on rerun with no change to the tree; cause not established |
| Flaky in the pull-request gate (fast lane): `test/hosted-gate.test.ts` "MISS deploy-needs-hosted" failed with `HOSTED_DEPLOY status=FAIL reason=source_changed_during_check` | `[ ]` seen 2026-11-18 on PR #158, CI run 44311269021 attempt 2; passed on rerun with no change to the tree; cause not established |

## Verification

Run the applicable automatic checks for every change. Prose alone needs only those
checks. Code, agent instruction files and data files such as JSON also need one
independent review at the exact head that will merge. Check any later commit on
its own. Changes to a merge gate, secret handling or code that deletes or uploads
a user's recording also need a written list of faults, each shown failing.
Required CI at the exact head is the receipt. No lane raises a timeout, adds a retry or skips a test to pass.
