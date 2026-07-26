# Implementation Plan: Local Studio - Drag-and-Drop Analysis

**Track ID:** `local-studio_20260726`
**Spec:** [spec.md](./spec.md)
**Status:** [ ] Not Started

## Overview

Build the local Studio as nine independently verifiable phases. Each phase
preserves CLI compatibility and leaves the Cloudflare review-only target green.
Hosted execution is represented only through contracts and roadmap
documentation.

## Phase 1: Contracts And Architecture

### Tasks

- [ ] Task 1.1: Add failing domain tests for legal job stages, terminal states,
      progress events, attempts, idempotency, and forbidden transitions.
- [ ] Task 1.2: Define strict shared Zod schemas and TypeScript types for job,
      job-event, media-session, configuration-status, and composer payloads.
- [ ] Task 1.3: Define `MediaStagingAdapter`, `AnalysisJobExecutor`,
      `JobRepository`, `SecretStore`, and progress-reporter interfaces without
      Nuxt, SQLite, or provider types leaking into domain contracts.
- [ ] Task 1.4: Write ADRs for local secret storage, media ownership/retention,
      durable jobs, and the Phase A-to-B adapter boundary.
- [ ] Task 1.5: Document the final state machine and map every terminal and
      interrupted condition to an operator action.

### Verification

- [ ] Domain transition tests pass, ADRs agree with `docs/ARCHITECTURE.md`, and
      no existing v2 contract changes.

## Phase 2: Local Configuration And Connection Health

### Tasks

- [ ] Task 2.1: Add failing tests for environment precedence, private
      filesystem permissions, redaction, disconnect, and secret-nonreturn.
- [ ] Task 2.2: Implement an OS-scoped local configuration and secret store;
      keep environment variables supported and document precedence.
- [ ] Task 2.3: Add loopback-only validated configuration status, connect,
      verify, and disconnect routes with bounded bodies and same-origin checks.
- [ ] Task 2.4: Expose Bluedot and Granola OAuth initiation/status through
      Studio without changing exact-resource token isolation.
- [ ] Task 2.5: Build the Nuxt UI Connections settings page with status,
      last-verified time, source, rotate, and disconnect actions but no secret
      echo.

### Verification

- [ ] A fresh private config directory passes permission checks; hostile Host,
      cross-site, oversized, and secret-reflection tests fail closed.

## Phase 3: Resumable Local Media Staging

### Tasks

- [ ] Task 3.1: Add failing adapter tests for create, ordered/out-of-order
      parts, resume, complete, digest mismatch, abort, expiry, and idempotency.
- [ ] Task 3.2: Implement private local staging outside the checkout with
      opaque IDs, streamed part writes, byte limits, MIME validation, and
      atomic sealing.
- [ ] Task 3.3: Add bounded create, upload-part, status, complete, and abort
      routes; never accept or return arbitrary filesystem paths.
- [ ] Task 3.4: Implement expiry and startup reconciliation for abandoned,
      partially written, sealed, and cleanup-failed sessions.
- [ ] Task 3.5: Build the accessible Nuxt drop zone with resumable progress,
      validation, abort, retry, and explicit storage/remote-transfer disclosure.
- [ ] Task 3.6: Evaluate native chunking versus a resumable upload library and
      record the protocol decision without exposing it above the adapter.

### Verification

- [ ] Stream a synthetic large fixture without full-body buffering; interrupt,
      restart, resume, seal, and clean it while preserving source ownership.

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

- [ ] Task 5.1: Add SQLite migrations and parity tests for jobs, events, staged
      media receipts, and review notes without storing media or transcripts.
- [ ] Task 5.2: Implement the SQLite `JobRepository` with atomic transitions,
      idempotent creation, bounded listing, and event ordering.
- [ ] Task 5.3: Implement the local Bun executor with documented concurrency,
      startup reconciliation, structured progress persistence, and no CLI log
      scraping.
- [ ] Task 5.4: Implement durable cancellation and linked retry attempts,
      including safe staged-media reuse checks.
- [ ] Task 5.5: Add job list/detail/create/cancel/retry routes with strict
      schemas, bounded output, and sanitized failures.
- [ ] Task 5.6: Define interrupted restart behavior and require explicit retry
      for indeterminate Gemini operations.

### Verification

- [ ] Restart the server during queued, running, cancellation, and terminal
      states; prove no duplicate execution and correct recovery actions.

## Phase 6: Studio Shell And Analysis Composer

### Tasks

- [ ] Task 6.1: Convert the authenticated application routes to the Nuxt UI
      dashboard shell while preserving public/SSR route behavior.
- [ ] Task 6.2: Add Studio Home with recent runs, active jobs, connection
      health, empty state, and one primary New Analysis action.
- [ ] Task 6.3: Build the Recording step over the Phase 3 staging composable.
- [ ] Task 6.4: Build the Context step with explicit provider/transport
      selection, meeting search/preview, local context, and advanced alignment.
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

- [ ] Task 8.1: Add a secure opaque-ID byte-range media route with traversal,
      expiry, content-type, and hostile-request tests.
- [ ] Task 8.2: Build the responsive finding/video/detail workspace with
      accepted/rejected filters and candidate markers.
- [ ] Task 8.3: Seek the player from canonical evidence timestamps and display
      aligned transcript excerpts without rendering untrusted HTML.
- [ ] Task 8.4: Add local reviewer notes and dispositions as rebuildable
      projection data.
- [ ] Task 8.5: Add copy Markdown and download bundle actions; keep GitHub,
      Asana, and other external publishing out of scope.

### Verification

- [ ] Browser tests prove timestamp seeking, byte ranges, keyboard access,
      mobile layout, untrusted-content escaping, and no arbitrary path access.

## Phase 9: Public Release Hardening And Phase B Roadmap

### Tasks

- [ ] Task 9.1: Update README, architecture, credentials, privacy, Studio,
      troubleshooting, backup, and operations runbooks.
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
| 2 | Add private local configuration and connection health | 1 |
| 3 | Add resumable local recording staging | 1 |
| 4 | Extract reusable analysis orchestration from the CLI | 1 |
| 5 | Implement the durable Bun job executor | 2, 3, 4 |
| 6 | Build the Studio shell and analysis composer | 2, 3, 5 |
| 7 | Build activity, cancellation, retry, and recovery UX | 5, 6 |
| 8 | Build timestamp-linked video review | 5, 6 |
| 9 | Harden, document, and define the hosted roadmap | 1-8 |

## Final Verification

- [ ] All specification acceptance criteria are met.
- [ ] All phase verifications pass.
- [ ] Existing CLI workflows remain compatible.
- [ ] Local and Cloudflare review builds pass.
- [ ] Public documentation and `.gitignore` match actual runtime behavior.
- [ ] No sensitive test or runtime material is tracked.
- [ ] Phase B remains an explicit roadmap, not a partially secured deployment.
