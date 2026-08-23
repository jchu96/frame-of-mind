# Specification: Hosted Studio - Team And Tenant Execution

**Track ID:** `hosted-studio_20260822`
**Type:** feature
**Created:** 2026-08-22
**Status:** Proposed — pending adversarial plan review

## Summary

Extend the deployed Cloudflare review workspace into a hosted Frame of Mind
Studio that can accept a recording, resolve optional context, run the existing
analysis pipeline durably, and publish a reviewable run without requiring the
local Bun process to remain online.

Tier A is a small-team mode on the existing `fom.flickerventures.com` Worker,
D1 database, custom domain, and Access application. Tier B adds tenant-safe
per-user provider connections and policy expansion after every Tier A boundary
has passed adversarial review. The local Studio remains supported and keeps its
current SQLite executor.

## Context

Frame of Mind already has:

- versioned schema-v2 meeting and schema-v3 video-only run bundles;
- a Nuxt review workspace with SQLite and D1 `RunStore` adapters;
- a deployed Worker protected by Cloudflare Access and in-Worker JWT
  validation;
- a provider-neutral `AnalysisOrchestrator` and `AnalysisJobExecutor` port;
- local job, event, context, and media lifecycles behind Bun-only adapters;
- a marker-based build gate that currently proves the hosted bundle is the
  review shell and excludes local Studio code.

Hosted creation changes the trust boundary. Recording bytes leave the user's
machine, long-running execution becomes Cloudflare-owned operational state,
and every D1 row must belong to a validated Access principal. The plan must
therefore define identity, ownership, upload integrity, provider credentials,
cost controls, cleanup, cancellation, and deployment before runtime work
begins.

Current platform facts used by this proposal are linked rather than assumed:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
  set 128 MB per isolate, not per request, and make request-body size an account
  plan limit: Free and Pro currently allow 100 MB. Hosted parts are fixed at
  8 MiB. Before deployment an operator must check the zone/account plan and any
  lower upload ceiling in the dashboard because Wrangler cannot read that
  setting; 8 MiB remains below the lowest documented tier.
- [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)
  documents streaming as the way to avoid buffering inside the isolate, but it
  does not prove Nitro/H3 preserves the request stream. Task 2.0 measures that
  exact `cloudflare_module` path before the upload contract can proceed.
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
  allow unlimited wall time per step subject to CPU limits and permit up to
  10,000 retries per step. The current
  [sleeping and retrying guide](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
  documents defaults of `timeout: "10 minutes"` and `retries.limit: 5` with
  exponential backoff. Those defaults are forbidden here: every `step.do` has
  explicit config, and provider steps use a 15-minute timeout—strictly greater
  than `MODEL_REQUEST_TIMEOUT_MS`—with `retries.limit: 0`.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) retain a
  2,000,000-byte maximum string/BLOB/row, 100 bound parameters per query, and a
  thirty-second query-duration ceiling; existing 1.8 MB row and 900 KB
  parameter application caps remain stricter.
- [Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
  expose a user `sub` and display `email`; service-token assertions instead
  carry an empty `sub` and a `common_name` client ID.

## Architectural Invariant

> A hosted request may act only for the identity proven by its validated
> Cloudflare Access assertion, and no browser, workflow retry, database query,
> or storage adapter may widen that identity's authority or weaken the durable
> run contract.

Implications:

- every read and write is scoped by `principal_sub` from the validated Access
  JWT; there is no unscoped query path;
- identity is derived in middleware and is never accepted from request input;
- browser uploads are integrity-bound without exposing the Gemini key;
- workflow steps are retry-safe and cannot silently duplicate provider work;
- recording retention is explicit and absent by default;
- D1 owns hosted operational state until a validated run publishes, while the
  run contract remains the durable analysis authority;
- local and hosted execution share domain ports but not runtime adapters or
  secret stores.

## User Story

As an approved Frame of Mind user, I want to upload an authorized recording,
choose explicit video-only or provider-enriched context, start a durable hosted
analysis, and return later to its activity and review pages, while seeing what
leaves my machine, who owns the data, what it costs, and when retained media is
deleted.

## Primary Experience

### Hosted Studio Home

- Recent runs and active jobs scoped to the current principal
- One primary "New analysis" action
- Gemini service readiness and non-secret provider connection state
- Spend-cap status without exposing provider payloads or raw billing data
- No local launch capability, loopback disclosure, or Bun-only control

### Hosted Analysis Composer

The composer preserves the local readiness model: Recording and Intent are
required; Context is an explicit optional choice. It replaces local filesystem
staging with a Worker-proxied resumable upload.

1. **Intent** — stable recipe, optional focus, model, and privacy/cost receipt.
2. **Context** — explicit video-only choice or one exact provider connection.
3. **Recording** — bounded chunk upload, streaming digest, retention choice,
   and transfer disclosure.
4. **Run** — immutable principal, recipe, context, media, spend, and cleanup
   receipt followed by one idempotent start action.

### Hosted Activity

- Durable Workflow-backed stage timeline
- Elapsed time and last sanitized event
- Cancellation flag and linked retry
- Spend-cap or provider-reconnect action
- Cleanup and retained-media expiry receipt

### Hosted Review

- The existing accepted/rejected analysis experience
- Principal-scoped run and media access
- Canvas-derived screenshots captured only at accepted evidence timestamps
- Retained playback only when R2 retention was explicitly selected
- No claim that D1 or the rendered view replaced the versioned run contract

## Architectural Decisions

### Architectural Decision 1 - Use Cloudflare On The Existing Hostname

**Decision.** Hosted Studio uses one Cloudflare Worker with D1, Workflows, and
Access on `fom.flickerventures.com`. It extends the existing `frame-of-mind`
Worker and D1 deployment rather than creating a second product hostname.

**Rationale.** The repository already has D1 projections, Access validation,
Workers Assets, an operating runbook, and a deployed custom domain. Workflows
provide durable long-running orchestration without coupling work to an HTTP
client connection.

**Rejected alternative.** Vercel is rejected because this track depends on the
existing Access/D1 boundary and Cloudflare Workflows. A second hostname is
rejected because it would create another Access application and identity
boundary without improving isolation.

### Architectural Decision 2 - Treat Access `sub` As User Identity

**Decision.** The verified Access `sub` is the user `principal_sub`; `email` is
display and initial allowlist input only. Google and One-time PIN are the Tier A
login methods. GitHub may be added later. The first policy is a named-email
allowlist; organization and group policies wait for Tier B.

Service-token requests use a separate Access Service Auth policy and the same
signature/issuer/audience middleware. Because Cloudflare documents an empty
service-token `sub`, middleware derives the non-user principal
`service:<common_name>` only after validating that claim shape. Service-token
routes are explicitly allowlisted; they never inherit browser management
routes or a user's provider connection.

Cloudflare documents that a user's `sub` can change when a seat is removed and
re-added. The new subject never inherits the old subject's rows automatically;
seat restoration requires a reviewed ownership-migration receipt that names
both verified subjects. Email match alone cannot transfer data.

**Rationale.** `sub` is the stable account-scoped user identifier available to
the origin. Separating display email prevents address changes from silently
transferring ownership. A normalized service principal preserves the same
repository contracts without pretending an empty `sub` is a user.

**Rejected alternative.** Email-keyed ownership is rejected because email is a
mutable display and policy attribute. Treating service tokens as empty-sub
users is rejected because every such token would collide. IdP groups are
rejected for Tier A because current JWT custom claims can be trimmed and the
small-team allowlist is sufficient.

### Architectural Decision 3 - Scope Every Row By Principal

**Decision.** Every hosted repository method receives middleware-created
principal context and includes `principal_sub` in its predicate and mutation.
Existing single-tenant projection rows are assigned to the first approved
principal during a one-time fail-closed bootstrap before hosted creation is
enabled. New rows always include `principal_sub TEXT NOT NULL` and optional
`principal_email` display provenance.

The shared `RunStore` stays SQL-lockstep across D1 and SQLite by binding a
principal when the store is constructed: Access `sub` for D1 and the reserved
synthetic value `local:single-user` for local SQLite. Route payloads and run
bundles remain byte-stable and never carry a principal. The local-facing
`JobRepository` and `MediaStagingAdapter` ports remain principal-free; hosted
adapters wrap them with principal-scoped repositories rather than widening the
local contracts.

`GET /api/runs`, `GET /api/runs/:id`, and `POST /api/runs` remain the shared
viewer/import routes. Their store is principal-bound at construction, so local
HTTP payloads stay byte-stable and hosted callers cannot select an owner.

**Rationale.** Access at the hostname prevents anonymous reachability but does
not prevent one authenticated user from reading another user's row through an
unscoped query. Repository contracts and composite indexes make ownership an
executable invariant.

**Rejected alternative.** Route-only authorization is rejected because a
future handler can call an unscoped store. One D1 database per user is rejected
for Tier A because it complicates migrations and operations without replacing
the need for application authorization.

### Architectural Decision 4 - Proxy Gemini Resumable Upload Through The Worker

**Decision (revised by ADR 0018 Amendment 2).** The Worker opens a Gemini
resumable session with the secret key and returns only the write-only session
URL; the browser uploads the recording directly to Google and the Worker
never proxies bytes. The original text below describes the superseded
Worker-proxied design: the browser sends raw-body parts of exactly 8 MiB except for the
final shorter part to `POST /api/hosted/media/:id/parts`. Metadata is carried
in bounded `Content-Length`, upload-offset, part-number, and part-digest
headers; multipart encoding is forbidden. The Worker validates the Access
principal and headers, then streams `request.body` into a Gemini resumable
session opened with the Worker-secret `GEMINI_API_KEY`.

On every part start or retry, the Worker queries Gemini's resumable session for
its provider-accepted offset and forwards only the remaining suffix from that
offset. D1 receipts record completed parts but never authorize an overlapping
replay. Task 2.0 must first prove the exact Nitro/H3 path does not call
`readBody()` or otherwise buffer, using two concurrent synthetic uploads of at
least the hosted part size. Failure keeps the route dark and changes this
contract—smaller parts or private R2 staging require an ADR amendment before
Tasks 2.1+ proceed.

The Gemini resumable-session URL is a bearer capability. It is never returned
to browser code or stored in plaintext. In Tier A the Worker seals it for short
term D1 storage using an AES-GCM key derived from `GEMINI_API_KEY` with
domain-separated HKDF information; rotating that secret invalidates active
uploads, which fail closed and restart. Tier B provider-token encryption uses a
separate KEK and does not reuse this derived key.

The Tier A rotation procedure disables new uploads, marks every active media
session aborting, attempts deletion of each exact Gemini file, clears only the
corresponding encrypted session ciphertext, rotates `GEMINI_API_KEY`, and then
reenables uploads. An unclean abort remains fail-closed and operator-visible.

**Rationale.** The browser cannot receive the Gemini API key, while streaming
through the Worker keeps memory bounded and avoids mandatory R2 storage.

**Rejected alternative.** Direct browser-to-Gemini upload is rejected because
starting the resumable session requires the API key and returning a provider
capability would widen the browser boundary. Mandatory browser-to-R2 staging is
rejected because ephemeral analysis does not require durable recording
retention.

This hosted browser → Worker → Gemini decision supersedes the local Studio
Phase B browser → R2 sketch. It does not change local
`MAX_MEDIA_PART_BYTES` (64 MiB) or `DEFAULT_MEDIA_PART_SIZE_BYTES` (8 MiB).

### Architectural Decision 5 - Hash Incrementally In A Dedicated Web Worker

**Decision.** A dedicated Web Worker reads the selected `File` through
`Blob.slice()` and computes the full SHA-256 with the reviewed `hash-wasm`
package using `createSHA256().update()` and `digest()`. Chunks remain bounded;
the main UI thread receives progress and the final digest only.

`crypto.subtle.digest("SHA-256", ...)` is used solely as a test oracle for
small synthetic fixtures. After Gemini finalizes the file, the server
normalizes the provider's `sha256Hash` through the existing live-proven
encoding matcher and compares it with the client receipt. A mismatch fails
closed with sanitized code `media_digest_mismatch`; no analysis Workflow may
continue.

**Rationale.** The end-to-end digest proves the finalized Gemini file matches
the browser-selected bytes without buffering a large recording in either the
browser or Worker.

**Rejected alternative.** WebCrypto's one-shot `SubtleCrypto.digest()` is
rejected because it requires the complete input in memory and offers no
standard streaming state. Server-side hashing across stateless chunk requests
is rejected because request retries and out-of-order delivery would require a
second durable incremental-hash authority and complicate replay safety.

### Architectural Decision 6 - Retain Recording Bytes Only By Explicit Choice

**Decision.** Default `retention=ephemeral` streams bytes to Gemini without
placing the complete recording in R2. `retention=retained` additionally writes
an encrypted/private R2 object owned by `principal_sub`, with visible expiry,
manual deletion, and bucket lifecycle rules. Incomplete multipart uploads have
their own shorter abort rule.

Hosted execution has no ffmpeg. Screenshots are captured client-side from a
user-authorized video element and canvas at accepted evidence timestamps. If a
future retained-media implementation adopts Cloudflare Stream, Stream
thumbnails may replace canvas capture. The manifest records source, timestamp,
digest, and capture method.

Ephemeral review deliberately has no playback or screenshot capture after the
originating tab loses its `File`. Evidence capture after tab close requires
retained R2 media or a digest-verified reattachment of the original bytes.

**Rationale.** Ephemeral processing preserves the local-first deletion posture;
retained playback is an explicit product feature with a separate cost and
retention receipt.

**Rejected alternative.** Always retaining R2 media is rejected as a silent
recording archive. Running ffmpeg in Workers is rejected because it would add a
large CPU/runtime boundary. Claiming screenshot provenance without the capture
method is rejected because canvas and provider thumbnails are not equivalent.

### Architectural Decision 7 - Run One Cloudflare Workflow Per Job

**Decision.** Each job owns one Workflow instance whose idempotent steps are
`fetch_context`, `ensure_gemini_file`, `transcribe`, `index`, `interrogate`,
`publish`, and `cleanup`. Model operations retain the existing ten-minute
timeout. Every `step.do` supplies an explicit `WorkflowStepConfig` with a
15-minute timeout. Provider steps set `retries.limit: 0`, check the
principal-scoped durable receipt before every Gemini call, and throw
`NonRetryableError` when Gemini succeeded but its receipt could not be
committed. A crash after Gemini success must never cause a second automatic
generate; the attempt becomes indeterminate and only explicit user retry may
create a new Workflow instance. The Workflow catches terminal provider/receipt
errors inside `run`, executes the explicit `cleanup` step before rethrowing or
finalizing, and registers rollback handlers for committed step outputs that own
cleanup actions. An uncaught `NonRetryableError` may not sit before a later
linear cleanup step because Cloudflare would skip that step.
Cancellation writes a D1 flag checked between steps and before publication;
retry creates a new linked job, attempt, and Workflow instance.

`AnalysisJobExecutor` gains a hosted Workflows adapter. The local Bun/SQLite
executor and its startup/restart behavior remain untouched.

Task 3.0 resolved the runtime topology on 2026-08-22. Pinned Nitro 2.13.4 has
no supported named-export seam for the required `WorkflowEntrypoint`, so a
sibling, internal-only Workflows Worker owns the class export. The Nuxt Worker
reaches it through a service binding while browser/API traffic remains on the
same Access hostname. Both dry-runs passed, and local workerd completed a
two-step instance created through Nuxt; see the
[topology spike](../../../docs/spikes/hosted-workflows-spike-2026-08-22.md).

**Rationale.** Workflows persist step progress and retry independently of
browser or HTTP lifetime. One instance per attempt maps directly to existing
job/retry semantics.

**Rejected alternative.** `waitUntil`, Cron, and Queue-only execution are
rejected because they do not provide the same durable per-step attempt record.
Reusing one Workflow instance for retry is rejected because it would blur
immutable attempt identity and provider side effects.

### Architectural Decision 8 - Split Team And Tenant Secret Models

**Decision.** Tier A has exactly one Worker secret: `GEMINI_API_KEY`, installed
with `wrangler secret` and never written to D1, a bundle, logs, or client state.
Provider-enriched analysis in Tier A is limited to connections explicitly
available under that team boundary; no shared provider token is silently
presented as user-owned.

Tier B adds user-provided Bluedot and Granola credentials encrypted in D1 with
AES-GCM under a second Worker secret KEK. `principal_sub` is authenticated
associated data, so ciphertext cannot move between principals. The Connections
page shows provider plus `connected`/`not connected`, verification time, and
reconnect/delete actions; it never returns a token, ciphertext, IV, or provider
payload.

**Rationale.** A single team Gemini key enables hosted execution without
creating a general credential vault. Tenant provider access requires a
separate rotatable encryption boundary and explicit user ownership.

**Rejected alternative.** Plaintext D1 tokens and browser local storage are
rejected. Reusing `GEMINI_API_KEY` as the long-lived Tier B KEK is rejected
because provider credentials must survive independent Gemini-key rotation.

### Architectural Decision 9 - Fail Closed On Per-Principal Spend

**Decision.** Every job reserves estimated input tokens in D1 before Workflow
creation. The estimate multiplies each planned video-bearing Gemini call by
the recording duration and the currently documented worst-case default video
rate of approximately 300 tokens/second, then adds versioned prompt/output
headroom. Each principal has a token ceiling; unknown duration, call graph, or
rate configuration fails closed. The job records sanitized estimated/actual
usage receipts per attempt,
and reconciles the reservation at terminal cleanup. Starting work beyond the
principal's cap fails with `principal_spend_cap_exceeded`. Missing or corrupt
cap state also fails closed.

**Rationale.** A shared Worker secret otherwise gives every approved user an
unbounded path to third-party spend. Reservation prevents concurrent jobs from
individually passing the same remaining balance.

**Rejected alternative.** Account-wide alerting alone is rejected because it
detects cost after provider work. Browser-side counting is rejected because it
is neither authoritative nor durable.

### Architectural Decision 10 - Reuse Codes-Only Telemetry

**Decision.** Hosted telemetry follows ADR 0017's opt-in, codes-only contract:
opaque principal-safe job ID, stage, recipe/model IDs, duration, and sanitized
code only. No email, Access token, recording name, transcript, provider payload,
analysis body, file path, signed URL, or raw error crosses the telemetry
boundary.

**Rationale.** Hosted Workflows need operational visibility without turning
telemetry into another analysis-data store.

**Rejected alternative.** Default SDK payloads, stack traces, request capture,
and raw provider messages are rejected as incompatible with the project's
privacy contract.

### Architectural Decision 11 - Invert The Cloudflare Bundle Gate

**Decision.** The Cloudflare artifact gate becomes a concrete allow/deny pair.
Required markers are `/api/hosted/media`, `/api/hosted/jobs`,
`/hosted/activity`, `HostedWorkflowAnalysisJobExecutor`,
`principal_spend_cap_exceeded`, and the hosted Studio shell. Forbidden markers
are `/__studio/bootstrap`, `/api/studio/jobs`,
`server-local/studio-session`, `server-local/studio-media`,
`server-local/studio-ui/activity`, `LocalMediaStagingAdapter`,
`LocalSqliteJobRepository`, `OrchestratedAnalysisJobExecutor`, and
`bun:sqlite`. Generic `/activity` is removed from the deny list so the explicit
hosted route can exist; the local source-path marker remains forbidden. The
hosted adapter may reuse domain orchestration contracts but never imports the
local `OrchestratedAnalysisJobExecutor` implementation.

**Rationale.** Once hosted creation is intended, proving only that local code is
absent can green-light a review-only bundle with no hosted implementation.

**Rejected alternative.** Runtime flags around one combined adapter graph are
rejected because bundling the local control plane is already a boundary
failure. Presence-only or absence-only scans are each rejected as incomplete.

### Architectural Decision 12 - Deliver Team Mode Before Tenant Mode

**Decision.** Phases 1-6 deliver and gate Tier A small-team mode. Phases 7-8
add Tier B user-owned provider credentials, broader policy rules, and
multi-principal operational hardening. Tier B cannot weaken or replace the
Tier A principal, upload, Workflow, retention, telemetry, or bundle gates.

**Rationale.** The upload/execution boundary can be proven with a narrow named
population before introducing a multi-credential tenant vault.

**Rejected alternative.** Shipping tenant credential storage in the first
slice is rejected because it combines two independent trust-boundary changes
and makes rollback ambiguous.

## Functional Requirements

### FR-01 - Hosted Runtime And Deployment

Hosted Studio runs as a module-format Cloudflare Worker with Workers Assets,
D1 binding `DB`, one Workflows binding, and a whole-hostname Access application
on `fom.flickerventures.com`. Tier A extends the deployed `frame-of-mind`
Worker and database. Hosted creation remains disabled until the D1 migration,
first-principal backfill, Access allowlist, spend cap, secret, Workflow, and
allow/deny bundle gates pass.

### FR-02 - Identity And Authorization

Every data-bearing request validates the `Cf-Access-Jwt-Assertion` signature,
RS256 algorithm, issuer, audience, expiry, and not-before fields before
constructing principal context. User context requires non-empty `sub`; email is
display only. Service context requires empty `sub`, validated `common_name`, a
Service Auth policy, and an allowlisted route. Request bodies, query strings,
and headers cannot override principal identity.

### FR-03 - Principal-Scoped Storage

Every repository operation requires `principal_sub` and uses it in the SQL
predicate. Hydration validates that row and child-event principals agree.
Pagination cursors are principal-bound. Foreign keys and indexes include the
principal where a child table can otherwise cross ownership. There is no admin
or migration query in normal runtime code that omits principal scope.

### FR-04 - Worker-Proxied Media Upload

- `POST /api/hosted/media` creates an opaque principal-owned media session.
- `POST /api/hosted/media/:id/parts` accepts one raw-body 8 MiB part (or the
  shorter final part) with bounded `Content-Length`, upload-offset,
  part-number, and part-digest headers; it never accepts multipart bytes.
- Every start/retry queries Gemini's accepted resumable offset and forwards
  only the unaccepted suffix; D1 never authorizes overlapping replay.
- The Worker never carries recording bytes: the browser uploads directly to a
  Worker-minted, write-only Gemini resumable session (ADR 0018 Amendment 2);
  seal requires `files.get` size and SHA-256 to equal the declared values.
- The browser maintains bounded upload concurrency and reconciles from the
  server receipt after refresh.
- The provider session capability is encrypted and never returned or logged.
- Default uploads do not create an R2 object.
- Task 2.0 is a hard stop/go measurement. If Nitro/H3 buffers or two concurrent
  parts exceed the isolate budget, this part contract changes before Tasks
  2.1+; no implementation may wave the spike through.

### FR-05 - End-To-End Media Integrity

The hash Web Worker reads deterministic `Blob.slice()` ranges, feeds them to
`hash-wasm`'s incremental SHA-256 state, and returns progress plus the final
lowercase digest. Small-fixture tests compare that output with
`SubtleCrypto.digest`. Finalization normalizes Gemini's `sha256Hash` and
requires equality before marking media sealed. Mismatch records
`media_digest_mismatch`, deletes the exact remote file when possible, and
prevents Workflow execution.

### FR-06 - Context And Connections

Video-only remains explicit. Tier A exposes only sanctioned team connection
availability and never silently falls back among Bluedot, Granola MCP, Granola
API, or local context identities. Tier B lets each user add/delete their own
encrypted provider credential. The UI reports connection presence and last
verification only. Provider failure cannot authorize video-only execution.

The hosted transcript ladder is provider transcript, bounded operator context,
Gemini-audio derived transcript directly from the already uploaded Gemini file,
then none. Hosted execution never invokes ffmpeg. The derived rung records the
existing `gemini-audio` origin and zero alignment only when that Gemini
transcription actually succeeds; failure is nonfatal and never fabricates
provider or derived provenance.

### FR-07 - Durable Workflow Execution

One Workflow instance maps to one immutable job attempt. The step sequence is:

```text
fetch_context
ensure_gemini_file
transcribe
index
interrogate
publish
cleanup
```

Every `step.do` has an explicit `WorkflowStepConfig` with a 15-minute timeout,
strictly above `MODEL_REQUEST_TIMEOUT_MS`. Provider steps use
`retries.limit: 0`, check a principal-scoped durable receipt before any Gemini
call, and raise `NonRetryableError` after provider success without a committed
receipt. A crash-after-Gemini test must prove the platform never issues a
second generate. Terminal provider/receipt errors are caught within `run` so
the explicit `cleanup` step executes before the error is rethrown or finalized;
owned step outputs also register rollback handlers for termination. Steps
return only bounded state and emit codes-only events.
`ensure_gemini_file` accepts only a sealed,
digest-matched media receipt. `publish` validates the analysis/manifest pair
and atomically records the projection. `cleanup` runs after success, failure,
or cancellation and never rewrites published provenance.

### FR-08 - Cancellation And Retry

Cancellation commits a durable timestamp and event before the Workflow sees
it. Every step boundary checks the flag; a provider call already in flight is
allowed to return its exact cleanup identity before cancellation settles.
Terminal and indeterminate jobs never reopen. User retry creates a new linked attempt, spend
reservation, and Workflow ID; it cannot reuse an expired ephemeral recording.

### FR-09 - Spend And Quota

Job creation atomically compares the principal's estimated-token ceiling with
committed usage plus active reservations. Each video-bearing call reserves
`duration_seconds × 300` input tokens plus versioned text/output headroom; the
300 tokens/second conservative default follows the current
[Gemini video token guidance](https://ai.google.dev/gemini-api/docs/video-understanding).
Reservation, adjustment, and terminal release are auditable by sanitized code
and opaque IDs. Missing rate/duration/call-graph data fails closed. Provider
quota/billing errors remain distinct from the application spend-cap code.

### FR-10 - Publication And Review

A hosted job succeeds only after the existing versioned pair validates,
projection import succeeds or records its existing recoverable warning, and
remote cleanup provenance is frozen. D1 remains a review projection after
publication. Every list/detail/media route remains principal-scoped.

### FR-11 - Retention And Screenshots

Ephemeral media is deleted from Gemini during terminal cleanup and is not
stored in R2. Retained media is private, principal-prefixed, time-bounded,
manually deletable, and governed by R2 lifecycle rules. The browser captures
screenshots at evidence timestamps through a canvas only after explicit media
access; the manifest records `client-canvas` provenance, timestamp, and digest.
Stream thumbnail provenance is a separately labeled future option. After the
uploading tab closes, ephemeral runs have no playback or screenshot source;
retained R2 media or digest-verified reattachment is required before evidence
capture, and the manifest records which source was used.

### FR-12 - Observability And Bundle Isolation

Logs and telemetry carry route class, status, opaque job ID, stage, duration,
byte count, and sanitized code only. The Cloudflare build fails unless every
required hosted marker is present and every local-only marker is absent. Local
Studio job/media ports remain principal-free. Shared RunStore SQL uses the
synthetic `local:single-user` principal in SQLite so local imports and bundles
remain byte-stable while the D1 build binds Access `sub`.

### FR-13 - Accessibility And Responsiveness

Upload, digest, Workflow, retention, connection, and spend state have visible
text equivalents; keyboard focus survives retry/error transitions; progress
does not fabricate percentages for model work; and the hosted composer,
activity, and review surfaces remain usable in a single-column layout.

## API Surface

Provisional hosted endpoints:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/hosted/configuration` | Return non-secret service, connection, cap, and retention status |
| `GET` | `/api/hosted/recipes` | Return bounded built-in recipe receipts |
| `POST` | `/api/hosted/media` | Create a principal-owned resumable upload session |
| `GET` | `/api/hosted/media/:id` | Read one principal-owned media receipt |
| `POST` | `/api/hosted/media/:id/parts` | Stream one bounded ordered part to Gemini |
| `POST` | `/api/hosted/media/:id/complete` | Cross-check digest and seal the Gemini file |
| `DELETE` | `/api/hosted/media/:id` | Abort and clean one owned media session |
| `GET` | `/api/hosted/catalog/:provider` | List bounded context identities for the exact connection |
| `GET` | `/api/hosted/jobs` | List principal-scoped job summaries |
| `POST` | `/api/hosted/jobs` | Reserve spend and create one job/Workflow attempt |
| `GET` | `/api/hosted/jobs/:id` | Read an owned job and bounded event page |
| `POST` | `/api/hosted/jobs/:id/cancel` | Persist cancellation intent |
| `POST` | `/api/hosted/jobs/:id/retry` | Create a linked attempt and Workflow |
| `GET` | `/api/runs` | List principal-scoped completed projections |
| `GET` | `/api/runs/:id` | Read one principal-owned validated projection |
| `GET` | `/api/hosted/runs/:id/media` | Stream authorized retained media by opaque ID |
| `PUT` | `/api/hosted/connections/:provider` | Tier B: encrypt and set one user-owned credential |
| `DELETE` | `/api/hosted/connections/:provider` | Tier B: delete one user-owned credential |

Every handler receives principal context from middleware. Routes never accept
`principal_sub`, `principal_email`, provider session URLs, D1 keys, R2 keys, or
Workflow instance IDs as client authority.

## Data Model

The implementation adds a new D1 migration; it never edits released
migrations. This concrete sketch is design input, not an applied migration:

```sql
-- 0003_hosted_studio_scope.sql (sketch only)
-- The sentinel is never a valid Access sub and is invisible to scoped reads.
ALTER TABLE analysis_runs
  ADD COLUMN principal_sub TEXT NOT NULL DEFAULT '__legacy_unclaimed__';
ALTER TABLE analysis_runs ADD COLUMN principal_email TEXT;
ALTER TABLE analysis_items
  ADD COLUMN principal_sub TEXT NOT NULL DEFAULT '__legacy_unclaimed__';
ALTER TABLE analysis_items ADD COLUMN principal_email TEXT;
ALTER TABLE analysis_run_registry
  ADD COLUMN principal_sub TEXT NOT NULL DEFAULT '__legacy_unclaimed__';
ALTER TABLE analysis_run_registry ADD COLUMN principal_email TEXT;
ALTER TABLE video_analysis_runs
  ADD COLUMN principal_sub TEXT NOT NULL DEFAULT '__legacy_unclaimed__';
ALTER TABLE video_analysis_runs ADD COLUMN principal_email TEXT;
ALTER TABLE video_analysis_items
  ADD COLUMN principal_sub TEXT NOT NULL DEFAULT '__legacy_unclaimed__';
ALTER TABLE video_analysis_items ADD COLUMN principal_email TEXT;

-- SQLite cannot alter a PRIMARY KEY or FOREIGN KEY in place. The applied
-- migration rebuilds all five projection tables plus the registry so their
-- authoritative constraints are exactly:
-- analysis_runs PRIMARY KEY (principal_sub, run_id)
-- analysis_run_registry PRIMARY KEY (principal_sub, run_id)
-- video_analysis_runs PRIMARY KEY (principal_sub, run_id)
-- analysis_items PRIMARY KEY (principal_sub, run_id, item_index)
--   FOREIGN KEY (principal_sub, run_id)
--     REFERENCES analysis_runs (principal_sub, run_id) ON DELETE CASCADE
-- video_analysis_items PRIMARY KEY (principal_sub, run_id, item_index)
--   FOREIGN KEY (principal_sub, run_id)
--     REFERENCES video_analysis_runs (principal_sub, run_id) ON DELETE CASCADE

CREATE UNIQUE INDEX analysis_runs_principal_run_idx
  ON analysis_runs (principal_sub, run_id);
CREATE INDEX analysis_runs_principal_completed_idx
  ON analysis_runs (principal_sub, completed_at DESC);
CREATE UNIQUE INDEX analysis_registry_principal_run_idx
  ON analysis_run_registry (principal_sub, run_id);
CREATE UNIQUE INDEX video_runs_principal_run_idx
  ON video_analysis_runs (principal_sub, run_id);
CREATE INDEX video_runs_principal_completed_idx
  ON video_analysis_runs (principal_sub, completed_at DESC);
CREATE INDEX analysis_items_principal_run_idx
  ON analysis_items (principal_sub, run_id, item_index);
CREATE INDEX video_items_principal_run_idx
  ON video_analysis_items (principal_sub, run_id, item_index);

CREATE TABLE hosted_media_sessions (
  media_id TEXT NOT NULL,
  principal_sub TEXT NOT NULL,
  principal_email TEXT,
  state TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL,
  received_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  client_sha256 TEXT,
  gemini_sha256 TEXT,
  gemini_session_ciphertext TEXT NOT NULL,
  retention TEXT NOT NULL CHECK (retention IN ('ephemeral', 'retained')),
  r2_key TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, media_id)
) STRICT;

CREATE TABLE hosted_analysis_jobs (
  job_id TEXT NOT NULL,
  principal_sub TEXT NOT NULL,
  principal_email TEXT,
  root_job_id TEXT NOT NULL,
  retry_of_job_id TEXT,
  attempt INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  immutable_input_json TEXT NOT NULL,
  cancellation_requested_at TEXT,
  spend_reserved_units INTEGER NOT NULL,
  run_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, job_id),
  UNIQUE (principal_sub, idempotency_key),
  FOREIGN KEY (principal_sub, media_id)
    REFERENCES hosted_media_sessions (principal_sub, media_id)
) STRICT;

CREATE TABLE hosted_analysis_job_events (
  principal_sub TEXT NOT NULL,
  principal_email TEXT,
  job_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  code TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (principal_sub, job_id, sequence),
  FOREIGN KEY (principal_sub, job_id)
    REFERENCES hosted_analysis_jobs (principal_sub, job_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE hosted_principal_spend (
  principal_sub TEXT PRIMARY KEY,
  principal_email TEXT,
  cap_units INTEGER NOT NULL,
  committed_units INTEGER NOT NULL,
  reserved_units INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE hosted_provider_connections (
  principal_sub TEXT NOT NULL,
  principal_email TEXT,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version TEXT NOT NULL,
  verified_at TEXT,
  PRIMARY KEY (principal_sub, provider)
) STRICT;

CREATE INDEX hosted_media_principal_state_idx
  ON hosted_media_sessions (principal_sub, state, expires_at);
CREATE INDEX hosted_jobs_principal_created_idx
  ON hosted_analysis_jobs (principal_sub, created_at DESC);
CREATE INDEX hosted_jobs_principal_stage_idx
  ON hosted_analysis_jobs (principal_sub, stage, updated_at);
CREATE INDEX hosted_events_principal_job_idx
  ON hosted_analysis_job_events (principal_sub, job_id, sequence);
```

The rollout coordinator validates one Access user, binds that user's verified
`sub` and display email, and atomically performs:

```sql
UPDATE analysis_runs
SET principal_sub = ?1, principal_email = ?2
WHERE principal_sub = '__legacy_unclaimed__';
UPDATE analysis_items
SET principal_sub = ?1, principal_email = ?2
WHERE principal_sub = '__legacy_unclaimed__';
UPDATE analysis_run_registry
SET principal_sub = ?1, principal_email = ?2
WHERE principal_sub = '__legacy_unclaimed__';
UPDATE video_analysis_runs
SET principal_sub = ?1, principal_email = ?2
WHERE principal_sub = '__legacy_unclaimed__';
UPDATE video_analysis_items
SET principal_sub = ?1, principal_email = ?2
WHERE principal_sub = '__legacy_unclaimed__';
```

Hosted routes remain disabled until the coordinator proves no sentinel rows
remain and both run tables, both item tables, and the registry contain only
that first principal. Production D1 is expected to be empty, so a non-empty legacy
row count fails closed for operator review rather than silently assigning
ownership. A follow-up
migration rebuilds the tables without the sentinel default, retaining
`principal_sub TEXT NOT NULL`; this ensures future inserts cannot omit the
principal. Rollback never maps rows back to email or removes ownership.

Shared import SQL inserts and resolves the registry by
`(principal_sub, run_id)`, deletes/inserts children with both predicates, and
uses `ON CONFLICT(principal_sub, run_id) DO UPDATE`. Before mutation, an
explicit query for the same `run_id` under any different `principal_sub`
returns `run_principal_conflict`; import never overwrites, deletes, or adopts
that row. List cursors encode principal-bound state, and detail reads require
both columns. Local SQLite runs the same SQL with `local:single-user`; tests
prove the submitted v2/v3 bundle and HTTP import payload remain byte-for-byte
unchanged.

D1 stores operational job/events/media state while work is active. Recording,
transcript, provider payload, API keys, OAuth plaintext, Gemini session URL,
analysis body outside the existing bounded projection, and screenshots never
enter these operational rows.

## Failure And Recovery Requirements

| Failure | Required behavior |
|---|---|
| Missing, invalid, or wrong-audience Access JWT | Reject before repository or body access |
| Service token reaches a browser-only route | Reject even when the Service Auth assertion is valid |
| Browser refresh during upload | Query Gemini offset, rehydrate owned receipt, and resume only the unaccepted suffix |
| D1/Gemini upload offsets disagree | Gemini offset is transfer authority; never overlap replay; repair D1 only after completed-part proof |
| Duplicate or conflicting chunk | Replay exact completed receipt or fail closed; never double-forward |
| Raw part exceeds 8 MiB or account upload ceiling | Return bounded 413 guidance; no provider state advance |
| Hash worker stops | Preserve upload receipt, require a fresh complete digest pass before seal |
| Client/Gemini digest mismatch | Record `media_digest_mismatch`, clean remote file, block Workflow |
| Gemini key rotates during upload | Active encrypted session becomes unreadable; clean/restart explicitly |
| Workflow provider step restarts | Explicit retries.limit 0; check receipt before call; never automatic second generate |
| Gemini succeeds but D1 receipt fails | Throw NonRetryableError, mark attempt indeterminate, require new user-linked Workflow |
| Ten-minute model timeout | Preserve exact cleanup identity and offer linked retry |
| User cancellation | Persist flag, finish safe in-flight receipt, skip later work, run cleanup |
| Retry requested | Create a new linked job and Workflow; never reopen the old attempt |
| Per-principal spend cap reached | Fail before Workflow creation with `principal_spend_cap_exceeded` |
| Provider credential expired | Fail with reconnect action; never fall back to another identity |
| Publication succeeds but projection warns | Preserve validated run authority and expose re-import action |
| Ephemeral cleanup fails | Preserve a sanitized cleanup-failed receipt and retry explicitly |
| R2 lifecycle is missing or broader than policy | Disable retained mode; ephemeral mode may continue |
| Access user is removed and re-added | New sub receives no old rows; require reviewed old/new-sub ownership migration |
| Import uses another principal's run ID | Reject as run_principal_conflict before any parent or child mutation |
| Unscoped repository call is attempted | Type/test/build gate fails; no runtime fallback |
| Hosted marker absent or local marker present | Fail Cloudflare build and release |

## Security And Privacy

- Validate Access in the Worker even though Access protects the hostname.
- Derive principal context once; never accept identity from the browser.
- Scope every SQL statement, cursor, child join, R2 key, Workflow ID, and
  provider connection by principal.
- Stream request and provider bodies; never buffer a recording in Worker
  memory or Workflow state.
- Treat Gemini resumable URLs, Access assertions, provider tokens, and R2
  object keys as sensitive capabilities; never log or return them.
- Treat a D1 export as a secret-bearing artifact because encrypted Gemini
  session URLs remain bearer capabilities if the derived key is also exposed;
  restrict exports, storage, retention, and deletion accordingly.
- Keep `GEMINI_API_KEY` as the only Tier A Worker secret.
- Encrypt Tier B provider credentials with AES-GCM, a separate KEK, unique IVs,
  explicit key version, and `principal_sub` associated data.
- Delete Gemini uploads after terminal work by default.
- Store recording bytes only under explicit retained mode with visible expiry,
  manual deletion, and R2 lifecycle enforcement.
- Keep transcript, provider payload, recording name, analysis body, Access
  email, and raw errors out of logs and telemetry.
- Treat transcript, video pixels/audio, provider content, custom recipes, and
  uploaded filenames as untrusted data.
- Use only synthetic media and identities in tests and documentation.

## Public Repository Policy

Track:

- `conductor/**`, ADRs, runbooks, schemas, and migration source;
- synthetic provider/media/hash fixtures;
- marker-gate allow/deny lists;
- placeholder environment/secret names only.

Ignore:

- Wrangler account configuration and `.dev.vars`;
- API keys, Access tokens, provider credentials, KEKs, and ciphertext dumps;
- recordings, transcripts, screenshots, generated runs, D1 exports, Workflow
  instance dumps, R2 objects, and raw logs.

Do not add broad ignores for JSON, Markdown, media extensions, or images.
Runtime data belongs outside the checkout; ignores remain defense in depth.

## Tier Compatibility Requirements

| Tier A - Team Mode | Tier B - Tenant Mode |
|---|---|
| Named Access email allowlist | Organization/group policy after claim-volume review |
| User `sub` ownership on every row | Same ownership invariant; no schema relaxation |
| Team-approved context availability | Per-user encrypted Bluedot/Granola credentials |
| One `GEMINI_API_KEY` secret | Same key plus separate provider-token KEK |
| Per-principal spend cap | Per-principal caps plus tenant administration |
| Ephemeral by default; optional retained R2 | Same retention contract and lifecycle rules |
| Service tokens designed and route-limited | CLI/agent service access enabled after isolation tests |

Tier B replaces no Tier A security control. It adds credential and policy
adapters behind the same domain and principal-scoped repository contracts.

## Acceptance Criteria

- [ ] An approved Access user can create, leave, return to, cancel, retry, and
      review one hosted analysis without a local Bun process.
- [ ] Every hosted read and write proves `principal_sub` scope; cross-principal
      list, detail, event, media, retry, and projection tests fail closed.
- [ ] Existing single-tenant D1 rows are assigned to the first principal before
      hosted routes enable, and no sentinel/default-owned row remains.
- [ ] Raw browser parts are 8 MiB or the shorter final part, query Gemini offset
      before forwarding, pass the two-concurrent-upload streaming spike, and
      never expose the Gemini key or resumable-session URL.
- [ ] `hash-wasm` computes the complete file digest with bounded memory in a
      Web Worker; WebCrypto verifies small fixtures; Gemini digest mismatch
      blocks analysis with `media_digest_mismatch`.
- [ ] Ephemeral mode stores no complete recording in R2; retained mode is
      explicit, principal-owned, lifecycle-bound, visible, and deletable.
- [ ] Hosted screenshots use client canvas or explicitly adopted Stream
      thumbnails, never ffmpeg, and record exact provenance in the manifest;
      ephemeral review after tab close discloses that no media is available.
- [ ] One Workflow per attempt runs the seven idempotent steps with existing
      ten-minute model timeouts inside explicit 15-minute step configs,
      provider `retries.limit: 0`, durable cancellation, and linked user retry.
- [ ] A crash after a successful Gemini generate but before receipt persistence
      never causes a second automatic generate.
- [ ] `AnalysisJobExecutor` has a Workflows adapter while the local
      Bun/SQLite executor and its tests remain unchanged.
- [ ] Tier A deploys with only `GEMINI_API_KEY`; Tier B credentials are
      AES-GCM ciphertext under a separate KEK with principal associated data.
- [ ] Connections shows only connected/not connected, verification state, and
      actions; no credential or ciphertext reaches browser state.
- [ ] Per-principal estimated-token reservation prevents concurrent jobs from
      exceeding the configured token ceiling and fails closed with a sanitized
      code when rate, duration, call graph, or cap state is unknown.
- [ ] Telemetry conforms to ADR 0017 and contains codes only.
- [ ] The Cloudflare bundle contains every hosted marker and none of the local
      session, staging, executor, or `bun:sqlite` markers.
- [ ] The module-format Cloudflare build and dry-run deployment show the module
      entrypoint, Workers Assets, D1 `DB`, and Workflow bindings without code
      100329.
- [ ] Existing schema-v2/v3 bundles, local CLI behavior, local Studio, and
      SQLite review projection remain compatible.

## Dependencies

- Accepted ADRs 0006-0017, including the codes-only telemetry contract now on
  main at the Attempt 2 base
- Proposed [ADR 0018](../../../docs/adr/0018-hosted-studio-trust-boundary.md)
- Existing `AnalysisOrchestrator`, `AnalysisJobExecutor`, job schemas, and run
  pair validators
- Existing Nuxt review workspace, D1 `RunStore`, Access middleware, and
  Cloudflare deployment
- Cloudflare Workers, D1, Workflows, Access, and optional R2
- Gemini Developer API resumable Files upload and `sha256Hash`
- `hash-wasm` incremental SHA-256 for the browser worker

## Out Of Scope

- Changing or removing the local Bun/SQLite Studio executor
- Direct browser-to-Gemini upload
- Mandatory R2 recording storage
- ffmpeg or server-side screenshot extraction in Workers
- Collaborative editing, shared annotations, or ownership transfer
- Organization/group Access policy in Tier A
- GitHub login in Tier A
- Per-user Gemini keys or automatic provider-key billing allocation
- Raw transcripts, provider payloads, recordings, or screenshots in D1
- Automatic external issue/task publication
- Public buckets, public media URLs, or cross-principal sharing links
- Deploying, migrating production D1, creating Access policies, or setting
  secrets as part of this planning track

## Technical Notes

- Keep hosted media, repository, secrets, and Workflow adapters independent
  from local implementations and selected at build time.
- Treat provider-side digest encoding as a normalization boundary; the existing
  live-observed matcher accepts the documented and observed representations
  before comparing canonical lowercase hex.
- Keep non-stream Workflow step return values well below Cloudflare's 1 MiB
  limit; recording bytes and complete analysis bodies belong in provider/R2/D1
  boundaries, not Workflow state.
- R2 lifecycle rules are a deletion backstop, not immediate cleanup evidence;
  application deletion still records its exact result.
- Wrangler cannot report the zone's configured request-body ceiling. Phase 6
  records a dashboard/operator receipt for the active plan before route
  enablement even though the fixed 8 MiB part is below every documented tier.
- Task 2.0 is the only resolver for Nitro/H3 upload streaming; Task 3.0 is the
  only resolver for same-module versus sibling-Worker Workflow topology.
- The marker gate is a release instrument. Every new hosted route or adapter
  family must add a stable required marker, and every local-only family must
  retain a forbidden marker.
- All residual decisions are fixed here or assigned to Task 2.0/3.0. An
  implementation may refine names and schemas only without reopening the
  accepted trust, retention, identity, upload, execution, or secret boundaries.
