# Implementation Plan: Local Studio - Drag-and-Drop Analysis

**Track ID:** `local-studio_20260726`
**Spec:** [spec.md](./spec.md)
**Status:** [~] In Progress

## Overview

Build the local Studio as nine independently verifiable phases. Each phase
preserves CLI compatibility and leaves the Cloudflare review-only target green.
Hosted execution is represented only through contracts and roadmap
documentation.

This track is an umbrella delivery program, not one pull request. Each phase is
an independently reviewable PR/issue with an approval gate. The existing CLI
and import-only workspace remain usable until the Studio beta gate passes.

## Delivery Slices

### Slice 1 - Safe Foundation

Phases 1-5 establish contracts, local session security, staging, shared
orchestration, and durable jobs. Studio creation routes remain disabled by
default. Exit only when restart, cancellation, cleanup, and Cloudflare bundle
isolation are proven.

### Slice 2 - Local Studio Beta

Phases 6-7 expose the composer and activity surfaces to local-session users.
The existing run detail page remains the completion surface. Exit only when a
fresh clone can complete one synthetic end-to-end run and recover from the
documented failures.

### Slice 3 - Studio v1

Phases 8-9 add retained/reattached video review, public documentation, platform
installation evidence, and release hardening. Hosted execution remains a
separate proposed track.

## Phase 1: Contracts And Architecture

### Tasks

- [x] Task 1.1: Add failing domain tests for legal job stages, terminal states,
      progress events, attempts, idempotency, and forbidden transitions.
- [x] Task 1.2: Define strict shared Zod schemas and TypeScript types for job,
      job-event, media-session, configuration-status, and composer payloads.
- [x] Task 1.3: Define `MediaStagingAdapter`, `AnalysisJobExecutor`,
      `JobRepository`, runtime secret resolver, optional
      `MeetingCatalogSource`, context-file staging, and progress-reporter
      interfaces without Nuxt, SQLite, or provider shapes leaking into domain
      contracts.
- [x] Task 1.4: Ratify ADRs 0006-0008 and write a threat model covering local
      session bootstrap, DNS rebinding, local-process access, disk exhaustion,
      deletion, and hosted bundle exclusion.
- [x] Task 1.5: Spike Nitro/H3 request streaming under Bun, bounded `FileSink`
      writes, atomic seal/rename, byte-range playback, and build-time exclusion
      from the Cloudflare artifact; document the verified state machines and
      operator actions before freezing API contracts.

### Verification

- [x] Domain transition tests pass, ADRs agree with `docs/ARCHITECTURE.md`,
      streaming/runtime spikes have recorded outcomes, the Cloudflare artifact
      excludes local-only modules/routes, and no existing v2 contract changes.

## Phase 2: Local Configuration And Connection Health

### Tasks

- [x] Task 2.1: Add failing tests for per-launch bootstrap exchange, cookie
      scope, environment/session precedence, redaction, disconnect,
      secret-nonreturn, and hosted-route absence.
- [x] Task 2.2: Implement the local Studio session bootstrap and middleware on
      top of peer/Host validation, including immediate clean-URL redirect and
      log redaction.
- [x] Task 2.3: Implement the environment-first, process-memory-second runtime
      secret resolver with no new plaintext filesystem or SQLite persistence.
- [x] Task 2.4: Add authenticated bounded configuration status/session-secret,
      Bluedot/Granola OAuth status/initiation, and optional paginated provider
      catalog routes without changing exact-resource isolation.
- [x] Task 2.5: Build the Nuxt UI Connections settings page with status,
      source/lifetime, last verification, session set/clear, OAuth reconnect,
      and persistent-environment guidance but no secret echo.
- [x] Task 2.6: Add a production-build Playwright baseline for fragment
      exchange, unauthenticated denial, replay rejection, session-key
      lifecycle, synthetic run import/review, console cleanliness, and mobile
      overflow. Sanitize the complete runner/browser/server environment, make
      retries idempotent and fail CI on flakes, and clean external temp state
      after passing and failing runs on every supported OS.

### Verification

- [x] A built-Nitro loopback contract probe verifies hostile Host,
      missing/invalid local session, query-bearing protected pages,
      bootstrap replay, cross-site mutation, oversized bodies, and no secret
      reflection. Playwright verifies the browser exchange/hydration and
      critical synthetic UI journeys. The Cloudflare artifact gate verifies no
      local bootstrap/config mutation route or runtime secret implementation.

## Phase 3: Resumable Local Media Staging

### Tasks

- [x] Task 3.1: Add failing adapter tests for create, ordered/out-of-order
      parts, concurrent writers, resume, disk exhaustion, complete, digest
      mismatch, retention, reattachment, abort, expiry, and idempotency.
- [x] Task 3.2: Implement private local staging outside the checkout with
      opaque IDs, streamed part writes, byte/part limits, free-space
      reservation, MIME validation, streamed final SHA-256, and atomic sealing.
- [x] Task 3.3: Add bounded create, upload-part, status, complete, and abort
      routes; never accept or return arbitrary filesystem paths.
- [x] Task 3.4: Implement startup reconciliation and lifecycle-owned periodic
      expiry for abandoned, partially written, sealed, retained, and
      cleanup-failed sessions.
- [x] Task 3.5: Build the accessible Nuxt drop zone with resumable progress,
      validation, abort, retry, ephemeral/retained selection, and explicit
      storage/remote-transfer disclosure.
- [ ] Task 3.6: Add a distinct bounded context-file ingestion path for JSON,
      text, Markdown, SRT, and VTT; normalize through the existing adapter and
      delete private context staging after use.

### Nuxt UI Delivery Approach

- Use Nuxt UI's
  [`UFileUpload`](https://ui.nuxt.com/docs/components/file-upload) as the
  accessible single-recording picker and drop zone. Keep `multiple` disabled
  and present a separate, tightly bounded picker for optional context files.
- Treat the browser `accept` filter as guidance only. Validate extension,
  declared MIME, byte limit, and detected media type again at the local server
  boundary before a session can seal.
- Keep the selected `File` in a component-local `shallowRef`; never serialize a
  `File`, recording name, or path through SSR state, SQLite, or a JSON DTO.
- Put upload behavior in a `useMediaStaging` composable. `UFileUpload` owns
  selection and removal only; the composable owns create/status/part/complete/
  abort calls, `AbortController`, retry policy, and server reconciliation.
- Upload server-advertised fixed-size parts from `Blob.slice()`. Count only
  server-confirmed bytes as progress and render them with `UProgress` plus a
  visible text equivalent.
- Represent `paused` and `reselect-required` as client presentation states, not
  new durable media-session states. The server's media receipt remains
  authoritative after refresh or reconnect.
- Persist only the opaque media-session receipt needed to rediscover an
  unfinished upload. After refresh, require the user to reselect the recording
  and verify completed-part receipts before sending missing parts; mismatches
  offer restart, never silent continuation.
- Compose status with `UBadge`, actionable failures with `UAlert`, and explicit
  `UButton` actions for choose, pause, resume, retry, replace, and abort. Keep
  errors associated through `UFormField`, announce state changes with text, and
  never rely on color or animation alone.
- Show retention, local staging location class, expiry, and the later Gemini
  transfer before staging begins. Dropping a file must not imply an immediate
  third-party upload.

### Verification

- [x] Stream synthetic fixtures without full-body buffering; interrupt,
      restart, resume, reject a concurrent writer, handle disk exhaustion,
      seal, retain/expire, reattach by digest, and clean them while preserving
      source ownership. The Phase 1 32 MiB probe supplies the measured
      large-stream check; adapter and production-built HTTP probes cover the
      durable Phase 3 contract.

## Phase 4: Reusable Analysis Orchestration

### Tasks

- [ ] Task 4.1: Add failing service tests for structured progress, cancellation,
      cleanup, projection warning, and successful durable publication.
- [ ] Task 4.2: Refactor the CLI pipeline into a reusable orchestration service
      that accepts explicit dependencies and emits typed progress events.
- [ ] Task 4.3: Preserve CLI commands and output while routing execution through
      the shared orchestration service.
- [ ] Task 4.4: Add `AbortSignal` propagation and explicit cancellation checks
      around provider, Gemini, clip, render, and cleanup boundaries.
- [ ] Task 4.5: Ensure a valid run bundle survives projection failure and that
      cleanup provenance freezes at publication.

### Verification

- [ ] Existing CLI tests remain green; new orchestration tests prove progress,
      cancellation, cleanup, and projection-failure behavior.

## Phase 5: Durable Bun Job Executor

### Tasks

- [ ] Task 5.1: Add local-only SQLite migrations and migration tests for
      operational jobs, events, and staged-media/context receipts without
      storing media, transcripts, or reviewer-authored state; keep the existing
      SQLite/D1 parity contract limited to completed-run projection tables.
- [ ] Task 5.2: Implement the SQLite `JobRepository` with atomic transitions,
      idempotent creation, bounded listing, and event ordering.
- [ ] Task 5.3: Implement the local Bun executor with concurrency one,
      startup/shutdown reconciliation, signal-aware interruption, structured
      progress persistence, and no CLI log scraping.
- [ ] Task 5.4: Implement durable cancellation and linked retry attempts,
      including safe staged-media reuse checks.
- [ ] Task 5.5: Add job list/detail/create/cancel/retry routes with strict
      schemas, bounded output, and sanitized failures.
- [ ] Task 5.6: Define interrupted restart behavior and require explicit retry
      for indeterminate Gemini operations.

### Verification

- [ ] Restart the server during queued, running, cancellation, and terminal
      states; prove no duplicate execution, correct interruption/retry actions,
      and a Cloudflare artifact free of the executor and `bun:` imports.

## Phase 6: Studio Shell And Analysis Composer

### Tasks

- [ ] Task 6.1: Convert the authenticated application routes to the Nuxt UI
      dashboard shell behind an explicit local-only Studio enablement flag
      while preserving public/SSR and hosted review behavior.
- [ ] Task 6.2: Add Studio Home with recent runs, active jobs, connection
      health, empty state, and one primary New Analysis action.
- [ ] Task 6.3: Build the Recording step over the Phase 3 staging composable.
- [ ] Task 6.4: Build the Context step with explicit provider/transport
      selection, optional paginated meeting catalog or exact-ID fallback,
      bounded local context upload, preview, and advanced alignment.
- [ ] Task 6.5: Build the Intent step with recipe cards, focus, strict custom
      recipe validation, and advanced model details.
- [ ] Task 6.6: Build the Run receipt with privacy, retention, Gemini transfer,
      cleanup, and final validated job creation.

### Verification

- [ ] Component and browser tests cover keyboard navigation, field errors,
      refresh-safe draft state, provider isolation, and the complete composer.

## Phase 7: Activity, Recovery, And Operations

### Tasks

- [ ] Task 7.1: Build the Activity list and job-detail timeline from bounded
      polling with clear active, failed, canceled, interrupted, and succeeded
      states.
- [ ] Task 7.2: Add cancel, retry, reconnect-provider, re-import-projection, and
      cleanup-remediation actions only where the state machine permits them.
- [ ] Task 7.3: Add elapsed-time, last-activity, progress, and accessible text
      equivalents without fabricated completion percentages.
- [ ] Task 7.4: Add sanitized technical details and copyable support receipts
      that exclude private content.
- [ ] Task 7.5: Add startup and scheduled maintenance for expired uploads and
      stale job records with dry-run diagnostics.

### Verification

- [ ] End-to-end tests cover refresh, browser closure, server restart, expired
      auth, quota failure, timeout, cancellation, cleanup failure, and retry.

## Phase 8: Timestamp-Linked Review Workspace

### Tasks

- [ ] Task 8.1: Add a local-session-protected opaque-ID byte-range media route
      with traversal, expiry, content-type, and hostile-request tests.
- [ ] Task 8.2: Build the responsive finding/video/detail workspace with
      accepted/rejected filters and candidate markers.
- [ ] Task 8.3: Seek the player from canonical evidence timestamps and display
      aligned transcript excerpts without rendering untrusted HTML.
- [ ] Task 8.4: Add the expired-media reattachment flow and require a streamed
      digest match against `manifest.json` before playback or retry.
- [ ] Task 8.5: Add copy Markdown and download bundle actions; keep GitHub,
      Asana, and other external publishing out of scope.

### Verification

- [ ] Browser tests prove timestamp seeking, byte ranges, keyboard access,
      mobile layout, untrusted-content escaping, and no arbitrary path access.

## Phase 9: Public Release Hardening And Phase B Roadmap

### Tasks

- [ ] Task 9.1: Reconcile README, ADR log, architecture, credentials, privacy,
      Studio, troubleshooting, backup, and operations runbooks against shipped
      behavior.
- [ ] Task 9.2: Add a public data-classification table and verify `.gitignore`,
      fixtures, screenshots, logs, examples, and repository history contain no
      sensitive runtime data.
- [ ] Task 9.3: Add fresh-clone local installation and upgrade tests for macOS,
      Linux, and documented Windows support.
- [ ] Task 9.4: Run adversarial security, provider, job-state, upload, and
      contract reviews; resolve all grounded blockers.
- [ ] Task 9.5: Write the separate hosted Studio track proposal covering
      Access, direct R2 multipart staging, D1 job state, durable execution,
      secrets, retention, cost, and deletion.

### Verification

- [ ] Full release gate, production audit, clean diff, secret scan, synthetic
      end-to-end run, both Nuxt targets, and CLI compatibility pass.

## Issue-Ready Decomposition

Each phase can become a public GitHub issue after the specification is approved:

| Issue | Title | Depends On |
|---|---|---|
| 1 | Define Studio job, staging, and execution contracts | None |
| 2 | Add local session, runtime secrets, and connection health | 1 |
| 3 | Add resumable local recording staging | 1 |
| 4 | Extract reusable analysis orchestration from the CLI | 1 |
| 5 | Implement the durable Bun job executor | 2, 3, 4 |
| 6 | Build the Studio shell and analysis composer | 2, 3, 5 |
| 7 | Build activity, cancellation, retry, and recovery UX | 5, 6 |
| 8 | Build timestamp-linked video review | 3, 5, 6 |
| 9 | Harden, document, and define the hosted roadmap | 1-8 |

## Risk Register

| Risk | Early evidence or mitigation | Stop condition |
|---|---|---|
| Nitro/H3 buffers upload parts | Phase 1 streaming spike with measured memory | No Phase 3 API until streaming is proven |
| Local credential routes rely only on localhost | Per-launch capability and hostile-request tests | No settings mutation without session gate |
| Upload exhausts disk or races writers | Reservation, one-writer transition, bounded parts | Abort and clean without sealing |
| Process exits during Gemini work | Persist stage/events and mark interrupted | Never auto-resume indeterminate remote state |
| Playback contradicts deletion policy | Explicit ephemeral/retained modes and digest reattachment | No player claim without accessible matching media |
| Job DB is mistaken for a run projection | ADR 0007 authority boundary and schema tests | No active job reconstruction from run rows |
| Local Bun code leaks into Worker | Per-phase artifact inspection and route-absence tests | Cloudflare build fails |
| Local operational tables leak into D1 | Separate local migrations; parity stays scoped to completed-run projections | D1 migration diff fails |
| Track scope hides an unusable middle | Three delivery slices with stop/go gates | Do not expose beta before synthetic end-to-end run |

## Rollback And Compatibility

- Keep existing CLI commands and the import-only workspace operational through
  all phases.
- Add SQLite migrations rather than rewriting prior migrations; back up local
  projections before upgrade testing.
- Keep Studio creation/control routes disabled by default through Slice 1.
- A failed beta can disable Studio routes without invalidating published v2 run
  bundles or the existing viewer.
- Revert implementation by phase through Conductor commit history; never alter
  existing run bundles to roll back the UI.

## Final Verification

- [ ] All specification acceptance criteria are met.
- [ ] All phase verifications pass.
- [ ] Existing CLI workflows remain compatible.
- [ ] Local and Cloudflare review builds pass.
- [ ] Public documentation and `.gitignore` match actual runtime behavior.
- [ ] No sensitive test or runtime material is tracked.
- [ ] Phase B remains an explicit roadmap, not a partially secured deployment.
