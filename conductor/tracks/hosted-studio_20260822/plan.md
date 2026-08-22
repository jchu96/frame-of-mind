# Implementation Plan: Hosted Studio - Team And Tenant Execution

**Track ID:** `hosted-studio_20260822`
**Spec:** [spec.md](./spec.md)
**Status:** Active — Phase 1 complete; Phase 2 blocked by Task 2.0c NO-GO

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

- [x] Task 1.1: Make validated Access identity executable: extend
      `apps/web/server/utils/access.ts:5-20` to return user `sub` plus
      display-only email and normalized empty-sub service principals; bind it
      once in `apps/web/server/middleware/00.auth.ts:42-48`; keep
      `GET /api/session` (`apps/web/server/api/session.get.ts:1-2`) display-only
      and never a principal override. Add missing/malformed/recycled-sub and
      service-route denial fixtures. Trust-boundary review trigger: middleware
      begins deriving durable ownership from an external Access assertion.
- [x] Task 1.2: Add the reviewed D1 migration for `principal_sub TEXT NOT NULL`
      and `principal_email` on both run tables, both item tables, and the
      registry, with composite parent/child keys and indexes. Rehearse against
      an empty D1: a non-empty legacy count fails closed for operator review,
      the sentinel is removed through table rebuild, and hosted creation stays
      dark. Add the reserved SQLite principal `local:single-user` to the same
      shared schema without changing v2/v3 import bytes.
      Trust-boundary review trigger: existing projection rows and shared local SQL acquire an owner.
- [x] Task 1.3: Scope every existing viewer/import path below and delete or make
      unreachable every unscoped alternative:
      - list route `apps/web/server/api/runs/index.get.ts:12-16`, D1 pagination
        `apps/web/server/data/d1.ts:45-69`, and union SQL
        `apps/web/server/data/sql.ts:210-232`: bind principal in both union arms
        and bind the cursor to that same principal;
      - detail route `apps/web/server/api/runs/[id].get.ts:9-11` and D1 reads
        `apps/web/server/data/d1.ts:72-100`: query by
        `(principal_sub, run_id)` for both schema versions;
      - import route `apps/web/server/api/runs/index.post.ts:46-49`, D1 import
        `apps/web/server/data/d1.ts:103-155`, and shared SQL
        `apps/web/server/data/sql.ts:105-202`: bind the authenticated principal,
        use composite registry/parent conflicts, scope every child delete and
        insert, and reject `run_principal_conflict` before touching another
        principal's matching run ID;
      - registry lookup `apps/web/server/data/d1.ts:145-149` and existence
        probes `apps/web/server/data/d1.ts:106-111`: require the principal in
        every predicate;
      - SQLite twins `apps/web/server/data/sqlite.ts:82-185` and shared
        `schemaSql` at `apps/web/server/data/sql.ts:7-103`: run identical SQL
        under `local:single-user` while preserving import request and bundle
        bytes;
      - `GET /api/session` remains display-only and `GET /api/health`
        (`apps/web/server/api/health.get.ts:1-5`) remains data-free.
      Add built-Worker HTTP contracts where two principals import distinct runs
      and cannot list, detail, overwrite, or delete each other's parent or item
      rows through any route. Trust-boundary review trigger: the existing
      deployed viewer/import surface becomes a row-level authorization boundary.

**Task 1.1 status (2026-08-22).** Complete. RS256 Access verification now
returns `sub`, display email, and the normalized principal; middleware binds
the principal once, the session response stays display-only, and service
principals fail closed on `/api/runs*`. Signed claim fixtures cover malformed,
wrong-audience, wrong-issuer, expired, empty/reserved subject, and service
shapes.

**Task 1.2 status (2026-08-22).** Complete. Migration 0003 rebuilds all five
projection tables with principal columns, composite keys/FKs, and indexes. An
empty D1 completes with zero sentinel rows; any legacy row trips the named
operator guard. Local SQLite upgrades under `local:single-user`, and v2/v3
request and bundle bytes remain unchanged.

**Task 1.3 status (2026-08-22).** Complete. D1 and SQLite stores require a
constructor-bound principal; both list arms, principal-bound cursor, both
detail versions, global ownership conflict probe, registry/existence checks,
parent upserts, and every child delete/insert carry it. The built workerd HTTP
contract proves two same-email/different-sub principals cannot list, read, or
reuse one another's runs while hosted creation stays dark.

### Verification

- [x] Access claim fixtures, empty-DB migration/backfill rehearsal, shared
      D1/SQLite schema parity, byte-stable local v2/v3 import fixtures, and the
      complete two-principal built-Worker HTTP contract pass. Hosted creation
      routes remain dark; only the already-deployed viewer/import surface ships.

### Stop/Go Gate

Stop unless two principals cannot see or mutate each other's runs, proven by an
HTTP contract against a built Worker. Tasks 1.1–1.3 are Slice 1 and must be
shippable/deployable alone with hosted creation dark; no Phase 2 work is needed
to release this security hardening.

## Phase 2: Bounded Upload And Media Integrity

### Tasks

- [x] Task 2.0: Stop/go spike the real `cloudflare_module` route with a
      synthetic body at least 8 MiB: use a built wrapper entry to route the
      exact upload path around Nitro/H3, pipe the original `request.body`
      directly into a Gemini-compatible resumable sink, and measure isolate
      memory with two concurrent uploads. Record heap/backing/total-process
      evidence and exact failure shape. The Worker digest must use Cloudflare
      `DigestStream` or a statically imported precompiled WASM module; runtime
      compilation is forbidden. Failure changes FR-04 to smaller parts or
      private R2 staging through an ADR amendment before any Task 2.1+ work.
      Trust-boundary review trigger:
      the platform is asked to carry untrusted recording bytes through a
      shared 128 MB isolate.
- [ ] Task 2.1: Add the browser hashing worker using `hash-wasm`
      `createSHA256().update()/digest()` over bounded `Blob.slice()` chunks,
      with cancellation/progress and small-fixture WebCrypto oracle tests.
      Trust-boundary review trigger: untrusted recording bytes are summarized
      into the digest that gates remote execution.
- [ ] Task 2.2: Implement principal-scoped media session creation and sealed
      Gemini resumable-session receipts without returning provider URLs or
      keys, plus the documented key-rotation abort procedure.
      Trust-boundary review trigger: the Worker creates and encrypts
      provider-side upload authority on a user's behalf.
- [ ] Task 2.3: Implement `POST /api/hosted/media/:id/parts` as a raw-body
      8 MiB-or-final-shorter request with bounded Content-Length, offset, part,
      and digest headers—never multipart. On every start/retry query Gemini's
      accepted offset and forward only the unaccepted suffix; D1 completed-part
      receipts never authorize overlap. Leave shared `MAX_MEDIA_PART_BYTES`
      untouched. Trust-boundary review trigger:
      recording bytes cross browser → Worker → provider without persistence.
- [ ] Task 2.4: Finalize by normalizing and comparing client SHA-256 with
      Gemini `sha256Hash`, fail closed as `media_digest_mismatch`, and delete
      mismatched remote files. Trust-boundary review trigger: provider metadata
      becomes eligible to authorize a Workflow.

**Task 2.0 status (2026-08-22): Complete — NO-GO after 2.0c.** The original
stock-Nitro run materialized the body before H3 and `hash-wasm` attempted
forbidden runtime WASM compilation. Task 2.0b's exact-path wrapper and
`DigestStream` looked bounded against a fast sink, but adversarial review found
that the tee retained the full request when the sink stalled. Task 2.0c
replaced it with one counting/digesting `TransformStream`, deleted the old
Nitro spike route, normalized path variants, and added complete Access,
over-length, and client-abort checks. Path, Access, digest, exact-byte, and
client-abort receipts pass. The required 2,503 ms slow-sink check still added
8,398,085 bytes of inspector backing storage against a 2,097,152-byte limit.
The over-length workerd check also returned 200 with a receipt because the
service boundary exposed only the declared 8 MiB to the wrapper. Tasks 2.1–2.4
remain blocked. The decision record and active, unadopted private-R2 fallback are in
[`hosted-streaming-spike-2026-08-22.md`](../../../docs/spikes/hosted-streaming-spike-2026-08-22.md)
and
[`adr-0018-private-r2-staging-amendment-draft-2026-08-22.md`](../../../docs/spikes/adr-0018-private-r2-staging-amendment-draft-2026-08-22.md).

### Verification

- [ ] Task 2.0 proves bounded streaming under sink backpressure and rejects an
      over-length source without recording a receipt.
- [ ] Bounded-memory browser tests, raw 8 MiB request limits, killed-mid-part
      Gemini-offset resume, overlap denial, provider digest fixtures, mismatch
      cleanup, and cross-principal media denial all pass.

### Stop/Go Gate

Stop immediately if Task 2.0 does not prove bounded two-upload streaming on the
built Worker. Otherwise continue only when the full-file digest is incremental,
one-shot WebCrypto is test-only, Gemini offset is resume authority, and no
Workflow can start from an unsealed or mismatched receipt.

## Phase 3: Durable Workflow Execution

### Tasks

- [x] Task 3.0: Spike whether Nitro's `cloudflare_module` output can export a
      `WorkflowEntrypoint` class and bind it in the generated Wrangler module.
      Record the module/dry-run receipt. If it fails, freeze the decided fallback:
      a sibling Workflows Worker reached through a service binding while the
      Nuxt Worker remains on the same Access hostname.
      Trust-boundary review trigger: deployment topology begins granting durable execution authority.

      **Status (2026-08-22):** topology B selected. Pinned Nitro 2.13.4 has no
      supported named-export seam; both sibling-Worker and Nuxt service-binding
      dry-runs passed, and local workerd completed one two-step Workflow created
      through Nuxt. See
      [`docs/spikes/hosted-workflows-spike-2026-08-22.md`](../../../docs/spikes/hosted-workflows-spike-2026-08-22.md).
- [ ] Task 3.1: Implement a Cloudflare Workflows `AnalysisJobExecutor` adapter
      while leaving the local SQLite executor selection and behavior untouched.
      Trust-boundary review trigger: durable execution authority moves from one
      Bun process to Cloudflare.
- [ ] Task 3.2: Implement one Workflow per job with idempotent `fetch_context`,
      `ensure_gemini_file`, `transcribe`, `index`, `interrogate`, `publish`, and
      `cleanup` steps. The hosted transcript ladder uses provider/operator
      context, then Gemini-audio directly from the uploaded file, then none;
      it never invokes ffmpeg or fabricates provenance.
      Trust-boundary review trigger: durable step state may invoke providers and mutate job state.
- [ ] Task 3.3: Give every `step.do` an explicit `WorkflowStepConfig` with a
      15-minute timeout, strictly greater than `MODEL_REQUEST_TIMEOUT_MS`.
      Provider steps use `retries.limit: 0`, check the durable principal-scoped
      receipt before any Gemini call, and throw `NonRetryableError` after
      success-without-receipt. Add a crash-after-Gemini regression that proves
      no second generate occurs; mark the attempt indeterminate for operator
      replay only. Keep bounded receipts, stable idempotency keys, and
      cancellation checks between steps. Trust-boundary review trigger:
      platform defaults could otherwise duplicate a billable provider call.
      Phase 3 review note N1: cleanup must still run after a
      `NonRetryableError`; wrap provider steps so terminal cleanup executes or
      register a Workflow rollback handler before this task can pass.
- [ ] Task 3.4: Implement retry as a new linked attempt with immutable prior
      receipts, an atomic spend reservation, and no Workflow-instance reuse.
      Trust-boundary review trigger: a user reauthorizes cost and provider work
      after a terminal attempt.

### Verification

- [ ] Task 3.0 resolves and records one deployment topology. Workflow contracts
      cover every explicit StepConfig, crash-after-Gemini, success-without-
      receipt, timeout, cancellation, linked user retry, Gemini-file expiry,
      transcript provenance, and terminal cleanup; local executor tests and
      principal-free job/media ports remain unchanged.

### Stop/Go Gate

Stop unless Task 3.0 proves the chosen export/service-binding topology and every
external action has a durable receipt boundary. A missing provider receipt may
require a new user-linked Workflow but may never trigger an automatic second
generate; cleanup remains terminal-path safe.

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
      is later adopted. Disclose and test that an ephemeral run has no
      playback/screenshots after tab close until retained media or exact-digest
      reattachment is available. Trust-boundary review trigger: derived image
      evidence leaves the playback surface and enters the durable contract.
- [ ] Task 5.3: Enforce per-principal estimated-token ceilings through atomic D1
      reservation/reconciliation. Estimate each video-bearing call at recording
      duration × the documented conservative 300 tokens/second plus versioned
      prompt/output headroom; fail closed when duration, call graph, rate, or
      cap state is unknown.
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

- [ ] Task 6.1: Wire Worker + D1 + the Task-3.0-resolved Workflows topology +
      Access on the existing hostname
      with `GEMINI_API_KEY` as the only Worker secret and module-format Nitro
      output. Rewrite the artifact gate with the exact AD-11 required/forbidden
      markers: hosted `/hosted/activity` is allowed, generic `/activity` is not
      denied, and local activity source plus `OrchestratedAnalysisJobExecutor`
      remain forbidden. Trust-boundary review trigger: hosted creation reaches
      the internet-facing deployment and bundle boundary.
- [ ] Task 6.2: Configure Google and One-time PIN login, email allowlist policy,
      and a separate service-token policy through the same principal middleware.
      Trust-boundary review trigger: Access policy begins granting real users
      and agents creation authority.
- [ ] Task 6.3: Run module-output dry-run checks, migration rehearsal on a D1
      clone, Workflow binding validation, boundary scanning, local byte-stable
      import regression, and rollback drills. Record the active Cloudflare zone
      plan/body ceiling from the dashboard because Wrangler cannot read it; the
      fixed 8 MiB part must remain below the lowest documented tier.
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
| Duplicate calls/spend on retries | Zero provider-step retries, indeterminate receipt failures, and atomic token reservations | Crash-after-Gemini and concurrency suite |
| Orphaned provider/R2 data | Terminal cleanup, reconciliation, lifecycle backstop | Failure/cancel cleanup receipts |
| Secret or content leakage | Worker-only secrets, encrypted tenant tokens, codes-only telemetry | Bundle/log/response scans |
| Cloudflare runtime mismatch | Task 2.0/3.0 spikes, module preset, concrete allow/deny markers, zone-plan receipt | Streaming/export receipts and Wrangler output without 100329 |
| Tier B weakens Tier A | Feature gates and separate acceptance suites | Tier A regression gate in every Tier B PR |

## Rollback And Compatibility

- Hosted route enablement is reversible independently of the review viewer.
- D1 migration rehearsal starts from a backup/clone; legacy rows remain bound
  to the recorded first principal and never become public during rollback.
- Workflow deployments are versioned; in-flight instances finish on their
  compatible implementation or enter explicit operator recovery.
- Replacing `GEMINI_API_KEY` first disables uploads, aborts/cleans exact active
  Gemini sessions, clears only their ciphertext, rotates the secret, and then
  reenables uploads; unconfirmed cleanup stays operator-visible.
- Disabling retained media prevents new R2 writes without deleting existing
  objects before their declared lifecycle.
- Disabling Tier B leaves Tier A Gemini-only execution and all local Studio
  behavior intact; loss of the Tier B KEK fails connections closed.
- Schema-v2 meeting bundles, schema-v3 video bundles, CLI workflows, local
  SQLite executor, and import-only review remain supported throughout.

## Final Verification

- [ ] All eight phase gates have named review receipts and no open blocker.
- [ ] Every hosted route and D1 repository is covered by cross-principal denial.
- [ ] Slice 1 alone passes the built-Worker two-principal HTTP contract with
      hosted creation dark and local v2/v3 imports byte-stable.
- [ ] Browser hashing stays bounded and matches the small-file WebCrypto oracle;
      Gemini digest mismatch fails closed before Workflow creation.
- [ ] Upload, Workflow retry/cancel, publication, spend, and cleanup pass a
      production-shaped end-to-end run with sanitized observability.
- [ ] Task 2.0 proves the wrapper remains bounded under sink backpressure;
      Task 3.0 records the working WorkflowEntrypoint topology.
- [ ] A crash after Gemini success cannot trigger a second automatic generate,
      and user retry creates a new linked Workflow instance.
- [ ] The built Cloudflare bundle contains all hosted required markers and no
      local bootstrap, local staging, local executor, or `bun:sqlite` marker.
- [ ] Wrangler reports module output, Workers Assets, D1, and Workflows without
      100329; `GEMINI_API_KEY` is the only Tier A Worker secret.
- [ ] Tier B credential encryption, rotation, revocation, and policy expansion
      pass independent adversarial review.
- [ ] `bun run check` passes and local CLI/Studio plus existing run contracts
      remain compatible.
