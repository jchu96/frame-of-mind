# Specification: Local Studio - Drag-and-Drop Analysis

**Track ID:** `local-studio_20260726`
**Type:** feature
**Created:** 2026-07-26
**Status:** Approved and in progress; Phases 1-5 complete

## Summary

Transform the existing Nuxt review workspace into Frame of Mind Studio: a
local-first application that accepts a dropped recording, optionally enriches
it with Bluedot, Granola, or local context, configures analysis intent, runs
the pipeline through a durable local Bun job, and presents a timestamp-linked
review workspace.

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
- SQLite job/event records are operational authority until terminal
  publication;
- completed-run SQLite rows and Studio views remain rebuildable projections;
- Phase B replaces adapters, not product contracts.

## User Story

As a user with an authorized recording, I want to begin with my question,
available context, or the video, complete an explicit analysis brief, and watch
a recoverable run so that I can review grounded findings without constructing
CLI commands or pretending that unavailable meeting context exists.

## Primary Experience

### Studio Home

- Recent runs and active jobs
- One primary "New analysis" action
- Connection health without displaying credentials
- Empty state that lets the user define intent, add optional context, or drop a
  recording

### New Analysis Composer

The composer is a readiness model, not a locked wizard. A user may enter through
Intent, Context, or Recording and move among them without discarding valid
work. Recording and Intent are required to run; Context is an optional,
explicit enrichment. Missing, expired, or failed context is never silently
treated as an intentional video-only choice.

1. **Intent**
   - human-readable cards for built-in recipes;
   - optional focus;
   - strict custom-recipe import;
   - model and sampling details under advanced controls. Sampling controls are deferred to Task 6.8 (2026-08-22).
2. **Context (optional)**
   - explicit video-only or context-enriched choice;
   - Bluedot, Granola MCP/API, or local file when enriched;
   - recent-meeting search where the provider supports it;
   - selected-meeting preview;
   - transcript alignment override in advanced controls.
3. **Recording**
   - drag and drop or file picker;
   - supported-type and size validation;
   - name, size, advisory browser-derived duration, and local-staging
     disclosure.
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
- Copy/download actions that do not publish externally

## Functional Requirements

### FR-01 - Local Runtime

The production local Studio must start through Bun, bind to loopback, validate
the peer and Host, and require a high-entropy per-launch Studio session. The
local Bun application runs one analysis at a time. Closing the browser does not
stop a job while the Bun process remains alive. No Cloudflare account is
required.

### FR-02 - Configuration

The Studio must configure:

- Gemini credential presence;
- Bluedot OAuth status;
- Granola OAuth or explicit API transport status;
- default recipe;
- default output and retention behavior.

API secret values are accepted only by a local-session-authenticated route,
kept in Bun process memory, redacted from logs, and never returned after
submission. Environment-provided secrets take precedence and remain the
persistent setup path. Session-provided values disappear on process restart.
Existing provider OAuth state continues through exact-resource private token
files. Phase A adds no plaintext API-key store.

### FR-03 - Media Staging

The browser must upload a selected recording to a private local staging
directory outside the repository:

- supported media type and 2 GB maximum are enforced;
- the server does not buffer the complete file in memory;
- per-session/part concurrency, chunk order, byte count, disk reservation, and
  final streamed digest are validated;
- interrupted uploads can resume or abort;
- every staged copy has a server-owned expiry independent of browser state;
- refresh-resume binds and verifies the complete reselected file using
  bounded-memory part digests before accepting missing parts;
- user-owned source files are never deleted;
- ephemeral staged copies are deleted after terminal job cleanup, with expiry
  as the no-job/no-browser backstop;
- retained-for-review copies require an explicit time-bounded choice;
- deleted media can be reattached only after its streamed SHA-256 matches the
  run manifest.

### FR-04 - Context Selection

Context enrichment is optional. The user must explicitly select video-only or
commit one context source; an unavailable, expired, or failed source must block
or ask for correction rather than silently downgrade the run. Video-only runs
record the absence of external context directly and do not manufacture an
empty meeting, transcript, provider, or alignment receipt.

When context is enabled, Studio exposes the same provider/transport boundaries
as the CLI. It must not silently fall back between OAuth identities, API
credentials, providers, or meeting IDs. Provider payload and error content are
private untrusted input. Providers may optionally implement a bounded,
paginated `MeetingCatalogSource`. When unavailable, the UI requests an exact
meeting ID. Local context files use a distinct bounded private upload (JSON,
text, Markdown, SRT, or VTT), are normalized through the existing adapter, and
are deleted after context normalization/job cleanup.

### FR-05 - Recipe Selection

Built-in recipe IDs remain stable. Custom recipe content passes the existing
strict schema and records its exact revision and SHA-256 in the manifest.
Recipe and focus inputs cannot alter immutable evidence or data-minimization
instructions.

### FR-06 - Durable Job State

Media sessions and analysis jobs have separate state machines. A job can be
created only from sealed media plus a validated immutable input receipt.
That receipt records either explicit video-only provenance or one exact context
source. Context-enriched execution retrieves and normalizes context before the
Gemini media upload; video-only execution records that the context stage was
intentionally skipped. Provider failure never authorizes a downgrade.
Allowed job stages are:

```text
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
interrupted
```

Every transition records UTC time, progress metadata, and a sanitized message.
Invalid transitions fail closed. Starting the same idempotency key cannot
create duplicate analysis jobs. Cancellation intent is stored separately before
the executor is signaled. `created`, `uploading`, `sealed`, `in_use`, `aborted`,
`retained`, `expired`, `deleting`, `cleanup_failed`, `deleted`, and `failed`
belong to the media lifecycle, not the job. `cleanup_failed` is recoverable
through another `deleting` attempt; `failed` is terminal corruption or
inconsistency and is never used for a retryable filesystem cleanup error.

### FR-07 - Process Execution

The local `AnalysisJobExecutor` captures structured progress events, supports
`AbortSignal`, and runs with concurrency one. It must reuse domain services
rather than scrape CLI output.

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

The Studio can seek an accepted or rejected finding's canonical timestamp when
the private recording is still retained. For ephemeral or expired media, it
offers reattachment and verifies the recording SHA-256 against the manifest
before playback. Local media delivery must:

- require the local Studio session in addition to loopback/Host validation;
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
| `GET` | `/api/studio/configuration` | Return non-secret connection and storage status |
| `PUT` | `/api/studio/configuration/secrets/:name` | Validate/set a process-memory API secret |
| `DELETE` | `/api/studio/configuration/secrets/:name` | Clear a process-memory API secret |
| `GET` | `/api/providers/:provider/meetings` | Search authorized recent meetings |
| `POST` | `/api/context-files` | Ingest one bounded private local context file |
| `DELETE` | `/api/context-files/:id` | Delete staged local context |
| `POST` | `/api/studio/media` | Create an idempotent upload session |
| `GET` | `/api/studio/media/:id` | Read the authoritative resumable receipt |
| `PUT` | `/api/studio/media/:id/parts/:part` | Stream one exact part with `Upload-Offset` |
| `POST` | `/api/studio/media/:id/complete` | Verify MIME/digest and atomically seal staged media |
| `DELETE` | `/api/studio/media/:id` | Abort and clean staged media idempotently |
| `POST` | `/api/studio/jobs` | Validate a draft and create an analysis job |
| `GET` | `/api/studio/jobs` | List bounded job summaries |
| `GET` | `/api/studio/jobs/:id` | Read one job and stage history |
| `POST` | `/api/studio/jobs/:id/cancel` | Request durable cancellation |
| `POST` | `/api/studio/jobs/:id/retry` | Create a linked retry attempt |
| `GET` | `/api/runs/:id/media` | Stream authorized retained local media by opaque ID |
| `POST` | `/api/runs/:id/media/reattach` | Bind matching reattached media by manifest digest |

Exact schemas are part of Phase 1 and may refine route names. No endpoint accepts
an arbitrary filesystem path. Local control-plane routes do not exist in the
Cloudflare review build.

## Data Model

New local runtime concepts:

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
- `staged_context`
  - opaque ID, bounded byte count, declared/validated format, private path;
  - expiry and deletion receipt, but no transcript body in SQLite.

Private paths never cross the API boundary. Recording and transcript bytes do
not enter SQLite. Jobs/events are operational state while work is active;
completed `analysis_runs` and `analysis_items` remain rebuildable projections.
Reviewer notes and dispositions are deferred until they have a separately
versioned durable annotation contract.

## Failure And Recovery Requirements

| Failure | Required behavior |
|---|---|
| Browser refresh | Job continues; page rehydrates from persisted state |
| Browser closes during upload | Session remains resumable until expiry |
| Local server restarts during upload | Sealed parts and receipt are recovered |
| Local server restarts during analysis | Job becomes interrupted, not silently failed or duplicated |
| Ephemeral media was deleted | Require digest-verified recording reattachment for playback or retry |
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

- Keep all local routes behind loopback, Host, and per-launch Studio-session
  validation.
- Require JSON content type, same-origin browser semantics, and bounded bodies.
- Use opaque IDs and server-owned path resolution.
- Store non-secret configuration and staging outside the checkout. Keep new API
  keys in environment input or process memory only.
- Create private files and directories with user-only permissions where POSIX
  supports them.
- Redact query strings, fragments, credentials, tokens, signed URLs, transcript
  text, and provider/model bodies from diagnostics.
- Delete ephemeral staged copies after success/failure/cancellation by default.
- Allow only explicit, time-bounded review retention with visible location,
  expiry, and manual deletion.
- Exclude local credential, staging, executor, and media-serving code from the
  Cloudflare artifact; hosted requests to local-only routes return 404.
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
| Operational SQLite job store | Durable hosted job store |
| Loopback plus local session | Cloudflare Access plus in-app JWT |
| Environment/session-only API secrets | Worker secrets or approved secret manager |
| Local media byte-range route | Authenticated R2 retrieval or signed bounded media route |

Workers will authorize and coordinate multipart uploads; recording bytes must
flow directly between the browser and private R2. Phase B needs its own threat
model, retention ADR, cost model, and operational runbook.

## Acceptance Criteria

- [ ] A fresh clone can start Studio locally with Bun and no cloud account.
- [ ] A user can drop a supported video, observe bounded resumable staging, and
      see an exact privacy/retention disclosure.
- [ ] A user can configure Gemini and provider authorization without a secret
      ever being persisted in Studio storage, returned to browser state, or
      written to logs.
- [ ] A user can begin with Intent, optional Context, or Recording, complete
      those sections in any order, and retain valid draft state while moving
      among them.
- [ ] A user can explicitly choose video-only or one exact context source,
      select a recipe, start a durable job, navigate away, return, and observe
      the same job.
- [ ] Video-only run artifacts record that no external context was supplied;
      context failures never masquerade as that intentional choice, and
      existing v2 run imports remain supported.
- [ ] The UI reports structured analysis stages, cancellation, retry, cleanup,
      and distinct actionable failure classes.
- [ ] Completing a job publishes a valid current-version run bundle and imports
      its rebuildable SQLite projection; existing v2 bundles remain importable.
- [ ] Selecting a finding seeks retained local video to its canonical evidence
      timestamp; deleted media requires digest-verified reattachment.
- [ ] The local app remains inaccessible through hostile Host, nonloopback, or
      missing/invalid local-session requests.
- [ ] Upload interruption, server restart, cancellation, projection failure,
      and cleanup failure have regression coverage.
- [ ] The full existing CLI behavior remains supported and shares the same
      orchestration services.
- [ ] The Cloudflare review-only build contains no local secret, staging,
      execution, media-serving, or `bun:` implementation and exposes no
      local-only routes.
- [ ] Operational job/context/media tables are local-only and do not alter the
      existing D1 run-projection schema.
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
- Browser video metadata for advisory display; server validation never trusts
  duration reported by the browser

## Out Of Scope

- Hosted recording ingestion or analysis execution
- R2 implementation
- Multi-user roles or collaborative editing
- Automatic external issue/task publication
- Mobile-native recording capture
- In-browser trimming or bounded-range extraction
- Audio-only analysis
- Local model execution
- Automatic restart of an indeterminate remote Gemini operation
- Persisting complete transcripts or provider payloads
- Treating SQLite as the only copy of completed analysis
- Reviewer notes or dispositions without a durable annotation contract

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
- The accepted Studio boundaries are recorded in
  [`docs/adr/0006`](../../../docs/adr/0006-local-studio-execution-and-session-boundary.md),
  [`docs/adr/0007`](../../../docs/adr/0007-separate-media-job-and-run-lifecycles.md),
  and
  [`docs/adr/0008`](../../../docs/adr/0008-local-secret-resolution.md).
