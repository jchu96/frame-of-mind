# Implementation Plan: Hosted Studio - Team And Tenant Execution

**Track ID:** `hosted-studio_20260822`
**Spec:** [spec.md](./spec.md)
**Status:** Proposed — pending adversarial plan review

## Overview

Deliver hosted Studio in two approval-gated tiers. Tier A (Phases 1-6) gives
one allowlisted team a durable Cloudflare-hosted creation path using the single
Worker Gemini key. Tier B (Phases 7-8) adds tenant-safe provider connections
and policy expansion without weakening Tier A ownership, retention, or local
Studio compatibility.

Each phase is an independently reviewable issue/PR slice. Per
`conductor/workflow.md`, every task names the trust-boundary change that
requires focused review. No implementation phase advances merely because its
happy path works.

## Delivery Slices

### Tier A - Team Mode (Phases 1-6)

Establish principal-scoped storage, bounded uploads, durable Workflows,
publication, lifecycle controls, and deployment proof for the existing Access
allowlist. The only Worker secret is `GEMINI_API_KEY`.

### Tier B - Tenant Mode (Phases 7-8)

Add encrypted per-principal provider connections, expanded Access policy, and
tenant-scale operational gates only after the Tier A threat model and
cross-principal tests pass.

## Phase 1: Identity, Schema, And Boundary Contracts

### Tasks

- [ ] Task 1.1: Add failing authorization tests proving user `sub`, display-only
      `email`, normalized service-token principals, and denial of absent or
      malformed Access claims. Trust-boundary review trigger: middleware begins
      creating hosted principals from externally asserted identity.
- [ ] Task 1.2: Add the reviewed D1 migration with `principal_sub TEXT NOT NULL`,
      `principal_email`, composite principal indexes, hosted media/job/event/
      spend tables, and a disabled-route legacy backfill procedure.
      Trust-boundary review trigger: existing single-tenant rows acquire a durable owner.
- [ ] Task 1.3: Refactor D1 repositories so every operation requires an
      immutable principal and every SQL predicate includes `principal_sub`;
      delete or make unreachable every unscoped method.
      Trust-boundary review trigger: repository authorization becomes the row-isolation boundary.
- [ ] Task 1.4: Rewrite the Cloudflare bundle gate as an allow/deny pair for
      hosted route/adapter markers versus local bootstrap, media staging,
      executor, and `bun:sqlite` markers. Trust-boundary review trigger: hosted
      creation code becomes deployable while local authority must stay absent.

### Verification

- [ ] Migration tests, repository cross-principal tests, Access claim fixtures,
      and the allow/deny artifact scan pass; no hosted route is enabled during
      legacy backfill.

### Stop/Go Gate

Stop unless an adversarial reviewer can prove no unscoped D1 access remains,
the first-principal backfill is explicit and reversible, and the bundle holds
only hosted runtime authority.

## Phase 2: Bounded Upload And Media Integrity

### Tasks

- [ ] Task 2.1: Add the browser hashing worker using `hash-wasm`
      `createSHA256().update()/digest()` over bounded `Blob.slice()` chunks,
      with cancellation/progress and small-fixture WebCrypto oracle tests.
      Trust-boundary review trigger: untrusted recording bytes are summarized
      into the digest that gates remote execution.
- [ ] Task 2.2: Implement principal-scoped media session creation and sealed
      Gemini resumable-session receipts without returning provider URLs or
      keys. Trust-boundary review trigger: the Worker creates provider-side
      upload authority on a user's behalf.
- [ ] Task 2.3: Implement `POST /api/hosted/media/:id/parts` with ≤95 MB bodies,
      ordered/resumable offsets, MIME/size limits, replay-safe receipts, and
      direct Worker forwarding to Gemini. Trust-boundary review trigger:
      recording bytes cross browser → Worker → provider without persistence.
- [ ] Task 2.4: Finalize by normalizing and comparing client SHA-256 with
      Gemini `sha256Hash`, fail closed as `media_digest_mismatch`, and delete
      mismatched remote files. Trust-boundary review trigger: provider metadata
      becomes eligible to authorize a Workflow.

### Verification

- [ ] Bounded-memory browser tests, upload resume/replay tests, 95 MB route
      limit tests, provider digest-encoding fixtures, mismatch cleanup, and
      cross-principal media denial all pass.

### Stop/Go Gate

Stop unless the full-file digest is incremental, one-shot WebCrypto is test
only, the Worker never buffers the recording, and no Workflow can start from
an unsealed or mismatched receipt.

## Phase 3: Durable Workflow Execution

### Tasks

- [ ] Task 3.1: Implement a Cloudflare Workflows `AnalysisJobExecutor` adapter
      while leaving the local SQLite executor selection and behavior untouched.
      Trust-boundary review trigger: durable execution authority moves from one
      Bun process to Cloudflare.
- [ ] Task 3.2: Implement one Workflow per job with idempotent `fetch_context`,
      `ensure_gemini_file`, `transcribe`, `index`, `interrogate`, `publish`, and
      `cleanup` steps. Trust-boundary review trigger: retryable step state may
      invoke providers and mutate durable job state.
- [ ] Task 3.3: Apply the existing ten-minute model-operation timeout, bounded
      step receipts, stable idempotency keys, and cancellation-flag checks
      between steps. Trust-boundary review trigger: timeout and cancellation
      must not orphan provider data or duplicate billable calls.
- [ ] Task 3.4: Implement retry as a new linked attempt with immutable prior
      receipts, an atomic spend reservation, and no Workflow-instance reuse.
      Trust-boundary review trigger: a user reauthorizes cost and provider work
      after a terminal attempt.

### Verification

- [ ] Workflow emulator/contract tests cover every step, duplicate delivery,
      timeout, cancellation, restart, linked retry, spend contention, and
      terminal cleanup while local executor tests remain unchanged.

### Stop/Go Gate

Stop unless every external action has a stable idempotency boundary, cleanup
is terminal-path safe, and an interrupted Workflow can resume without widening
principal authority or duplicating publication.

## Phase 4: Hosted Composer, Activity, And Publication

### Tasks

- [ ] Task 4.1: Add hosted composer routes and UI for recording, intent,
      optional context, recipe, retention, and explicit transfer disclosure.
      Trust-boundary review trigger: browser input can initiate remote analysis
      and storage lifecycle choices.
- [ ] Task 4.2: Add principal-scoped activity/detail/cancel/retry endpoints and
      accessible status UI using opaque IDs and sanitized error codes only.
      Trust-boundary review trigger: operational job metadata becomes visible
      across requests and devices.
- [ ] Task 4.3: Publish only a validated analysis/manifest pair, atomically add
      its principal-scoped D1 projection, and preserve immutable job/media/
      provider provenance. Trust-boundary review trigger: provisional provider
      output becomes a durable review artifact.
- [ ] Task 4.4: Integrate hosted published runs into the existing viewer without
      adding cross-principal lookup, sharing, or ownership transfer paths.
      Trust-boundary review trigger: the established read surface begins
      resolving newly created hosted data.

### Verification

- [ ] Production-build HTTP and browser tests prove create → activity → review,
      cancellation/retry, mobile/accessibility behavior, pair validation, and
      exhaustive cross-principal denial for guessed media/job/run IDs.

### Stop/Go Gate

Stop unless only the validated owner can create or view a run, publication is
atomic, and every error/UI surface remains free of secrets, raw provider data,
transcripts, and signed URLs.

## Phase 5: Retention, Spend, And Operational Safety

### Tasks

- [ ] Task 5.1: Implement explicit `ephemeral` and `retained` media policies;
      use private R2 only for retained bytes and configure lifecycle expiry.
      Trust-boundary review trigger: recording bytes may persist beyond the
      provider operation for the first time.
- [ ] Task 5.2: Implement client-canvas evidence captures with manifest source
      and timestamp provenance, plus a gated Stream-thumbnail adapter if Stream
      is later adopted. Trust-boundary review trigger: derived image evidence
      leaves the local playback surface and enters the durable contract.
- [ ] Task 5.3: Enforce per-principal Gemini-call caps through atomic D1
      reservation/reconciliation and fail closed with a stable sanitized code.
      Trust-boundary review trigger: shared Worker credentials incur spend for
      user-initiated work.
- [ ] Task 5.4: Emit ADR-0017 codes-only telemetry for Access, upload, Workflow,
      spend, publication, and cleanup outcomes without user or media content.
      Trust-boundary review trigger: hosted failure metadata may leave the
      Worker for an external telemetry processor.

### Verification

- [ ] Lifecycle, explicit-delete, orphan-reconciliation, spend-race, screenshot
      provenance, telemetry scrubber, and no-content logging tests pass on
      success, failure, timeout, and cancellation paths.

### Stop/Go Gate

Stop unless ephemeral bytes are absent after cleanup, retained bytes are
private and expiring, concurrent spend cannot exceed cap, and telemetry
contains codes and structural fields only.

## Phase 6: Tier A Deployment And Team Gate

### Tasks

- [ ] Task 6.1: Wire Worker + D1 + Workflows + Access on the existing hostname
      with `GEMINI_API_KEY` as the only Worker secret and module-format Nitro
      output. Trust-boundary review trigger: hosted creation reaches the
      internet-facing deployment boundary.
- [ ] Task 6.2: Configure Google and One-time PIN login, email allowlist policy,
      and a separate service-token policy through the same principal middleware.
      Trust-boundary review trigger: Access policy begins granting real users
      and agents creation authority.
- [ ] Task 6.3: Run module-output dry-run checks, migration rehearsal on a D1
      clone, Workflow binding validation, boundary scanning, and rollback drills.
      Trust-boundary review trigger: release configuration can bind production
      data and durable execution resources.
- [ ] Task 6.4: Complete adversarial Tier A review, synthetic canary run,
      cleanup proof, cost-cap proof, and operator runbook before enabling hosted
      routes. Trust-boundary review trigger: the route flag changes from dark
      deployment to allowlisted team use.

### Verification

- [ ] Wrangler output shows the module entrypoint, Workers Assets, D1 `DB`, and
      Workflow binding without 100329; canary and rollback receipts prove
      identity, upload, execution, publication, spend, and cleanup end to end.

### Stop/Go Gate

Stop unless a named adversarial reviewer approves all Tier A trust boundaries,
the D1 backup/rollback drill succeeds, and production enablement needs no
additional secret or local-only module.

## Phase 7: Tenant Connections And Credential Custody

### Tasks

- [ ] Task 7.1: Add a second Worker KEK secret and versioned AES-GCM envelope
      storage for per-user Bluedot/Granola tokens with `principal_sub` as AAD.
      Trust-boundary review trigger: the service begins custody of tenant
      provider credentials.
- [ ] Task 7.2: Add OAuth/session connection and disconnect flows with exact
      redirect/state binding, rotation, revocation, and no credential echo.
      Trust-boundary review trigger: third-party authorization callbacks mutate
      a principal's encrypted credential state.
- [ ] Task 7.3: Build Connections UI that shows provider, connected/not,
      verification time, and reconnect/disconnect actions but never token or
      ciphertext. Trust-boundary review trigger: credential state becomes a
      user-visible multi-request surface.
- [ ] Task 7.4: Resolve provider context only for the authenticated principal,
      with bounded pagination, exact-resource isolation, and provider-specific
      deletion receipts. Trust-boundary review trigger: encrypted credentials
      authorize retrieval of external meeting data.

### Verification

- [ ] Cryptographic fixtures, wrong-principal/wrong-AAD denial, key-version
      rotation, OAuth replay, disconnect, redaction, and provider isolation
      tests pass without exposing plaintext in logs, D1 queries, responses, or
      client state.

### Stop/Go Gate

Stop unless KEK separation, rotation, revocation, principal binding, and zero
credential reflection pass independent security review; Tier A remains usable
with provider connections disabled.

## Phase 8: Tenant Policy, Scale, And Release

### Tasks

- [ ] Task 8.1: Add organization/group Access policy options while preserving
      `sub` ownership, email display-only semantics, and separate service-token
      policy. Trust-boundary review trigger: authorization expands beyond a
      static email allowlist.
- [ ] Task 8.2: Add quota administration and per-principal operational views
      without an implicit administrator bypass or unscoped data query.
      Trust-boundary review trigger: operators receive limited tenant metadata
      and policy controls.
- [ ] Task 8.3: Load-test concurrent uploads, Workflows, D1 contention, spend
      reservations, event pagination, and cleanup against documented Cloudflare
      limits. Trust-boundary review trigger: concurrency can expose isolation,
      replay, and shared-resource failure modes.
- [ ] Task 8.4: Complete tenant adversarial review, incident/restore rehearsal,
      public docs, compatibility matrix, and staged release approval.
      Trust-boundary review trigger: hosted execution becomes a multi-tenant supported product.

### Verification

- [ ] Multi-principal/load/security suites, restore and KEK-loss drills,
      policy regression tests, full `bun run check`, and production-shaped
      canaries pass with retained evidence and no cross-principal result.

### Stop/Go Gate

Stop unless tenant isolation survives concurrency and operator workflows,
credential recovery limitations are documented, and release approval confirms
local Studio and Tier A compatibility.

## Issue-Ready Decomposition

Each phase is one epic. Each `Task N.M` is an independently assignable issue
whose description copies its trust-boundary trigger, expected failing tests,
implementation fence, documentation impact, and phase verification receipt.
Author and adversarial reviewer must differ. Phases 1-6 carry the `tier-a`
label; Phases 7-8 carry `tier-b` and remain blocked until the Phase 6 gate.

## Risk Register

| Risk | Control | Release evidence |
|---|---|---|
| Cross-principal data access | Principal-required repositories and exhaustive denial fixtures | Query audit plus two-principal suite |
| Recording corruption or substitution | Incremental client digest and Gemini hash cross-check | Encoding fixtures and mismatch cleanup |
| Duplicate calls/spend on retries | Workflow idempotency and atomic spend reservations | Replay and concurrency suite |
| Orphaned provider/R2 data | Terminal cleanup, reconciliation, lifecycle backstop | Failure/cancel cleanup receipts |
| Secret or content leakage | Worker-only secrets, encrypted tenant tokens, codes-only telemetry | Bundle/log/response scans |
| Cloudflare runtime mismatch | Module preset, allow/deny markers, dry-run binding inspection | Wrangler output without 100329 |
| Tier B weakens Tier A | Feature gates and separate acceptance suites | Tier A regression gate in every Tier B PR |

## Rollback And Compatibility

- Hosted route enablement is reversible independently of the review viewer.
- D1 migration rehearsal starts from a backup/clone; legacy rows remain bound
  to the recorded first principal and never become public during rollback.
- Workflow deployments are versioned; in-flight instances finish on their
  compatible implementation or enter explicit operator recovery.
- Disabling retained media prevents new R2 writes without deleting existing
  objects before their declared lifecycle.
- Disabling Tier B leaves Tier A Gemini-only execution and all local Studio
  behavior intact; loss of the Tier B KEK fails connections closed.
- Schema-v2 meeting bundles, schema-v3 video bundles, CLI workflows, local
  SQLite executor, and import-only review remain supported throughout.

## Final Verification

- [ ] All eight phase gates have named review receipts and no open blocker.
- [ ] Every hosted route and D1 repository is covered by cross-principal denial.
- [ ] Browser hashing stays bounded and matches the small-file WebCrypto oracle;
      Gemini digest mismatch fails closed before Workflow creation.
- [ ] Upload, Workflow retry/cancel, publication, spend, and cleanup pass a
      production-shaped end-to-end run with sanitized observability.
- [ ] The built Cloudflare bundle contains all hosted required markers and no
      local bootstrap, local staging, local executor, or `bun:sqlite` marker.
- [ ] Wrangler reports module output, Workers Assets, D1, and Workflows without
      100329; `GEMINI_API_KEY` is the only Tier A Worker secret.
- [ ] Tier B credential encryption, rotation, revocation, and policy expansion
      pass independent adversarial review.
- [ ] `bun run check` passes and local CLI/Studio plus existing run contracts
      remain compatible.
