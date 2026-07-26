# Specification: Local Studio - Drag-and-Drop Analysis

**Track ID:** `local-studio_20260726`
**Type:** feature
**Created:** 2026-07-26
**Status:** Draft for review; local-first direction confirmed

## Summary

Transform the existing Nuxt review workspace into Frame of Mind Studio: a
local-first application that accepts a dropped recording, pairs it with
Bluedot, Granola, or local context, configures analysis intent, runs the
existing pipeline through a durable local Bun job, and presents a
timestamp-linked review workspace.

This track implements local execution only. It must establish media-staging and
job-execution seams that can support a later Cloudflare-hosted implementation
without changing browser-facing contracts or durable run outputs.

## Context

Frame of Mind v0.2 has:

- a TypeScript CLI and reusable provider/Gemini services;
- Bluedot MCP, Granola MCP/API, and local context adapters;
- schema-v2 portable run bundles;
- a Nuxt 4 and Nuxt UI review workspace;
- SQLite and D1 run projections;
- Cloudflare Access-protected hosted review deployment.

The web workspace currently imports completed run contracts. A user must leave
the browser, construct CLI arguments, observe terminal output, and return to the
web app to review the result. This interrupts the product experience and makes
configuration, progress, recovery, and cleanup difficult for non-CLI users.

## Architectural Invariant

> A sensitive, long-running analysis must survive browser navigation and remain
> inspectable without making the browser, database projection, or cloud
> deployment its only durable authority.

Implications:

- the Bun server owns local jobs;
- the browser observes and controls jobs through validated APIs;
- job state is persisted before execution begins;
- media staging has explicit ownership and cleanup;
- the resulting run bundle remains authoritative;
- SQLite job records and Studio views remain rebuildable projections;
- Phase B replaces adapters, not product contracts.

## User Story

As a user with an authorized meeting recording, I want to drop the video into
Frame of Mind, attach available context, choose what I want to understand, and
watch a recoverable analysis run so that I can review grounded findings without
constructing CLI commands or exposing the recording to an unplanned service.

## Primary Experience

### Studio Home

- Recent runs and active jobs
- One primary "New analysis" action
- Connection health without displaying credentials
- Empty state that directs the user to drop a recording

### New Analysis Composer

1. **Recording**
   - drag and drop or file picker;
   - supported-type and size validation;
   - name, size, duration, and local-staging disclosure;
   - optional bounded analysis range.
2. **Context**
   - Bluedot, Granola MCP/API, local file, or intentionally minimal local
     context;
   - recent-meeting search where the provider supports it;
   - selected-meeting preview;
   - transcript alignment override in advanced controls.
3. **Intent**
   - human-readable cards for built-in recipes;
   - optional focus;
   - strict custom-recipe import;
   - model and sampling details under advanced controls.
4. **Run**
   - final receipt showing recording, context, intent, local storage, remote
     Gemini transfer, and cleanup policy;
   - explicit "Start analysis" action.

### Job Activity

- Durable stage timeline
- Elapsed time and last activity
- Cancel and safe retry
- Sanitized operator message and collapsible technical detail
- Cleanup outcome
- Link to the completed run

### Review Workspace

- Finding list
- Video player and candidate markers
- Transcript excerpt aligned to the selected moment
- Evidence, inference, recommendation, and uncertainty sections
- Accepted/rejected filters
- Local reviewer notes as projection data
- Copy/download actions that do not publish externally

## Functional Requirements

### FR-01 - Local Runtime

The production local Studio must start through Bun, bind to loopback, and use
the existing hostile-Host guard. No Cloudflare account is required.

### FR-02 - Configuration

The Studio must configure:

- Gemini credential presence;
- Bluedot OAuth status;
- Granola OAuth or explicit API transport status;
- default recipe;
- default output and retention behavior.

Secret values are accepted only by a loopback server route, stored with
user-only permissions through an explicit secret store, redacted from logs,
and never returned after submission. Environment-provided secrets remain
supported and take precedence according to a documented rule.

### FR-03 - Media Staging

The browser must upload a selected recording to a private local staging
directory outside the repository:

- supported media type and 2 GB maximum are enforced;
- the server does not buffer the complete file in memory;
- chunk order, byte count, and final digest are validated;
- interrupted uploads can resume or abort;
- abandoned staging entries expire;
- user-owned source files are never deleted;
- staged copies are deleted according to an explicit cleanup receipt.

### FR-04 - Context Selection

The Studio exposes the same provider/transport boundaries as the CLI. It must
not silently fall back between OAuth identities, API credentials, providers, or
meeting IDs. Provider payload and error content are private untrusted input.

### FR-05 - Recipe Selection

Built-in recipe IDs remain stable. Custom recipe content passes the existing
strict schema and records its exact revision and SHA-256 in the manifest.
Recipe and focus inputs cannot alter immutable evidence or data-minimization
instructions.

### FR-06 - Durable Job State

Creating a run first persists a job with a stable ID and immutable input
receipt. Allowed stages are explicit:

```text
draft
staging
queued
fetching_context
uploading_to_gemini
indexing
interrogating
rendering
cleaning_up
succeeded
failed
canceled
```

Every transition records UTC time, progress metadata, and a sanitized message.
Invalid transitions fail closed. Starting the same idempotency key cannot
create duplicate analysis jobs.

### FR-07 - Process Execution

The local `AnalysisJobExecutor` runs one analysis per job, captures structured
progress events, supports `AbortSignal`, and limits concurrency to a documented
default. It must reuse domain services rather than scrape CLI output.

### FR-08 - Cancellation And Retry

- Cancellation marks intent durably before signaling the process.
- Cleanup still runs after cancellation.
- A terminal job cannot return to a nonterminal stage.
- Retry creates a new attempt linked to the original job.
- Retry reuses a validated staged recording only when its retention receipt
  proves that the bytes still exist and match.

### FR-09 - Completion

A job succeeds only after:

- the v2 analysis/manifest pair validates;
- atomic publication completes;
- the run projection imports successfully or records a recoverable projection
  warning;
- remote Gemini cleanup state is frozen in the manifest;
- local staging cleanup follows the chosen retention policy.

Projection failure cannot destroy a valid run bundle.

### FR-10 - Review

The Studio can seek an authorized local video to an accepted or rejected
finding's canonical timestamp. Local media delivery must:

- require loopback access;
- use an opaque job/run-scoped identifier rather than an arbitrary path;
- support byte-range requests;
- set a restrictive content type and content-disposition policy;
- reject traversal and expired staging references.

### FR-11 - Accessibility And Responsiveness

- All composer steps are keyboard operable.
- Upload progress has text equivalents and does not rely on color.
- Focus is restored after dialogs.
- Errors are associated with fields.
- The review workspace collapses into a usable single-column/mobile flow.
- Reduced-motion preferences are honored.

### FR-12 - Observability

Logs may contain job ID, stage, timing, byte counts, status, and sanitized error
codes. Logs must not contain credentials, signed URLs, transcript content,
provider payloads, model output, recording names when configured as private,
or analysis bodies.

## API Surface

Provisional local endpoints:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/config/status` | Return non-secret connection and storage status |
| `PUT` | `/api/config/:provider` | Validate and store or disconnect local credentials |
| `GET` | `/api/providers/:provider/meetings` | Search authorized recent meetings |
| `POST` | `/api/media` | Create an upload session |
| `PUT` | `/api/media/:id/parts/:part` | Stream one validated local part |
| `POST` | `/api/media/:id/complete` | Verify and seal staged media |
| `DELETE` | `/api/media/:id` | Abort and clean staged media |
| `POST` | `/api/jobs` | Validate a draft and create an analysis job |
| `GET` | `/api/jobs` | List bounded job summaries |
| `GET` | `/api/jobs/:id` | Read one job and stage history |
| `POST` | `/api/jobs/:id/cancel` | Request durable cancellation |
| `POST` | `/api/jobs/:id/retry` | Create a linked retry attempt |
| `GET` | `/api/runs/:id/media` | Stream authorized retained local media by opaque ID |

Exact schemas are part of Phase 1 and may refine route names. No endpoint accepts
an arbitrary filesystem path.

## Data Model

New local projection concepts:

- `analysis_jobs`
  - ID, attempt, idempotency key, stage, terminal outcome;
  - immutable input receipt;
  - staged-media opaque ID and digest;
  - provider/transport/meeting and recipe identity;
  - timestamps and sanitized error code/message;
  - resulting run ID and projection warning.
- `analysis_job_events`
  - ordered transition sequence;
  - stage, event kind, UTC time, progress, sanitized message.
- `staged_media`
  - opaque ID, expected/received bytes, digest, MIME type;
  - lifecycle status, private server-side path, expiry, cleanup receipt.
- `review_notes`
  - run and item identity, local note text, review disposition, timestamps.

Private paths never cross the API boundary. Recording and transcript bytes do
not enter SQLite.

## Failure And Recovery Requirements

| Failure | Required behavior |
|---|---|
| Browser refresh | Job continues; page rehydrates from persisted state |
| Browser closes during upload | Session remains resumable until expiry |
| Local server restarts during upload | Sealed parts and receipt are recovered |
| Local server restarts during analysis | Job becomes interrupted, not silently failed or duplicated |
| Provider authorization expires | Job fails with reconnect action; no transport fallback |
| Gemini quota/billing failure | Surface distinct nonretryable guidance |
| Gemini request timeout | Preserve cleanup and offer a linked retry |
| User cancellation | Persist intent, abort work, run cleanup, reach canceled |
| Run publication succeeds but projection fails | Preserve run; expose re-import action |
| Cleanup fails | Preserve exact cleanup receipt and remediation |

Automatic restart of an interrupted Gemini analysis is out of scope unless the
pipeline can prove idempotent remote state. The first release may require an
explicit retry.

## Security And Privacy

- Keep all local routes behind loopback and Host validation.
- Require JSON content type, same-origin browser semantics, and bounded bodies.
- Use opaque IDs and server-owned path resolution.
- Store configuration and staging outside the checkout.
- Create private files and directories with user-only permissions where POSIX
  supports them.
- Redact query strings, fragments, credentials, tokens, signed URLs, transcript
  text, and provider/model bodies from diagnostics.
- Delete staged copies after success/failure/cancellation by default.
- Allow retention only through an explicit user choice with visible location.
- Use synthetic fixtures in tests and documentation.

## Public Repository Policy

Track:

- `conductor/**`;
- ADRs, architecture, and runbooks;
- Zod schemas and migrations;
- provider-independent fixtures with invented content;
- UI screenshots containing only synthetic data;
- `.env.example` with placeholder names only.

Ignore:

- `.env` and `.dev.vars`;
- OAuth registrations/tokens and provider configuration;
- recordings, audio, raw transcripts, screenshots, and generated runs;
- SQLite databases, WAL/SHM files, staging parts, and temporary downloads;
- account-specific Wrangler configuration;
- logs, coverage, build outputs, and dependency trees.

Do not add broad ignores for JSON, Markdown, SRT/VTT, or images because they
would hide legitimate contracts, documentation, and synthetic fixtures. Runtime
data should live outside the checkout first; `.gitignore` is defense in depth.

## Phase B Compatibility Requirements

Phase A must not implement hosted execution, but it must make these replacements
possible:

| Phase A | Phase B |
|---|---|
| Local filesystem `MediaStagingAdapter` | Private R2 multipart adapter |
| Bun `AnalysisJobExecutor` | Durable hosted executor |
| SQLite job projection | D1 job projection |
| Loopback guard | Cloudflare Access plus in-app JWT |
| OS secret store/config | Worker secrets or approved secret manager |
| Local media byte-range route | Authenticated R2 retrieval or signed bounded media route |

Workers will authorize and coordinate multipart uploads; recording bytes must
flow directly between the browser and private R2. Phase B needs its own threat
model, retention ADR, cost model, and operational runbook.

## Acceptance Criteria

- [ ] A fresh clone can start Studio locally with Bun and no cloud account.
- [ ] A user can drop a supported video, observe bounded resumable staging, and
      see an exact privacy/retention disclosure.
- [ ] A user can configure Gemini and provider authorization without a secret
      ever being returned to browser state or logs.
- [ ] A user can select context and a recipe, start a durable job, navigate
      away, return, and observe the same job.
- [ ] The UI reports structured analysis stages, cancellation, retry, cleanup,
      and distinct actionable failure classes.
- [ ] Completing a job publishes a valid v2 run bundle and imports its
      rebuildable SQLite projection.
- [ ] Selecting a finding seeks retained local video to its canonical evidence
      timestamp.
- [ ] The local app remains inaccessible through hostile Host or nonloopback
      requests.
- [ ] Upload interruption, server restart, cancellation, projection failure,
      and cleanup failure have regression coverage.
- [ ] The full existing CLI behavior remains supported and shares the same
      orchestration services.
- [ ] The Cloudflare review-only build remains green; hosted execution is not
      accidentally enabled.
- [ ] No credential, recording, transcript, generated analysis, or database is
      tracked by Git.
- [ ] Architecture, setup, privacy, troubleshooting, and Phase B roadmap docs
      are complete.

## Dependencies

- Existing v2 analysis and manifest contracts
- Existing Nuxt UI workspace and `RunStore`
- Existing provider and Gemini adapters
- Bun runtime and SQLite support
- Browser support for streamed or chunked file upload and video playback
- `ffprobe` or a tested browser/server metadata alternative for duration

## Out Of Scope

- Hosted recording ingestion or analysis execution
- R2 implementation
- Multi-user roles or collaborative editing
- Automatic external issue/task publication
- Mobile-native recording capture
- Audio-only analysis
- Local model execution
- Automatic restart of an indeterminate remote Gemini operation
- Persisting complete transcripts or provider payloads
- Treating SQLite as the only copy of completed analysis

## Technical Notes

- Extract a provider-independent orchestration API from the CLI before wiring
  Nuxt routes; do not invoke the CLI and parse terminal text.
- Prefer explicit job events over polling log files.
- A simple bounded polling API is acceptable for the first release; Server-Sent
  Events may be added only if reconnect semantics remain straightforward.
- Do not add Pinia unless the composer and job surfaces demonstrate state that
  cannot be expressed cleanly through route data, `useState`, and composables.
- Evaluate a dedicated resumable upload library during Phase 3, but keep its
  protocol behind `MediaStagingAdapter`.
- Add ADRs for secret storage, media staging/retention, and the local-to-hosted
  executor boundary.
