# ADR 0018: Host Studio creation behind principal-scoped Cloudflare execution

- Status: Proposed
- Date: 2026-08-22

## Invariant

A hosted request may act only for the identity proven by its validated
Cloudflare Access assertion, and no upload, retry, query, or storage adapter
may widen that identity's authority or weaken the durable run contract.

## Context

The deployed Cloudflare workspace is currently an authenticated projection of
already completed runs. Hosted Studio adds recording transfer, provider calls,
long-running execution, operational state, and publication. That turns the
Worker from a viewer into a creation boundary.

Cloudflare is already the deployment authority: one Worker on the existing
hostname, D1, and an Access application. The domain already separates the
provider-neutral `AnalysisJobExecutor` from its local SQLite implementation.
The local executor must remain supported.

## Decision

Hosted Studio uses the existing Cloudflare hostname and Access application:

- a validated user JWT `sub` is the stable `principal_sub`; `email` is display
  only;
- user principals may create and view only their own media, jobs, events, and
  runs; there is no unscoped query path or implicit administrator read path;
- service tokens use a separate Access policy and the same middleware, which
  normalizes the documented empty `sub` plus `common_name` claim into a
  service-principal namespace;
- recording bytes travel browser → Worker → Gemini through raw 8 MiB resumable
  requests and are never stored by Frame of Mind unless the user explicitly
  chooses retained media; this supersedes local Studio's provisional Phase B
  browser → R2 sketch without changing local media-part constants;
- retained media is private, principal-owned R2 data with a visible lifecycle;
  ephemeral media is cleaned from Gemini on every terminal path;
- the browser computes the full recording SHA-256 incrementally in a dedicated
  Web Worker using `hash-wasm` `createSHA256().update()/digest()` over
  `Blob.slice()` chunks; one-shot WebCrypto is a bounded small-fixture oracle;
  the server cross-checks Gemini `sha256Hash` and fails closed on mismatch;
- each analysis job runs as one Cloudflare Workflow with idempotent steps,
  explicit 15-minute `WorkflowStepConfig`, zero provider-step retries, durable
  cancellation, linked user retry attempts, and terminal cleanup;
- an internal-only sibling Worker owns the `WorkflowEntrypoint` export because
  pinned Nitro 2.13.4 has no supported named-export seam; the public Nuxt
  Worker reaches it through a service binding on the existing Access hostname,
  and the sibling revalidates bounded principal-scoped receipts because Access
  context does not propagate across that binding;
- D1 stores principal-scoped operational state and review projections while
  the validated analysis/manifest bundle remains the durable run contract;
- `GEMINI_API_KEY` is the only Tier A Worker secret. Tier B provider tokens
  require a distinct KEK and principal-bound AES-GCM ciphertext;
- the deployed system is one linked boundary: Nuxt Worker + sibling Workflows
  Worker + D1 + Access, with optional private R2 only when retention is
  selected. The sibling deploys first; the caller binding deploys second.

The phased implementation and exact route/data contracts live in the
[Hosted Studio track](../../conductor/tracks/hosted-studio_20260822/).

## Threat Controls

| Threat | Decision |
|---|---|
| Isolate-memory DoS | Task 2.0 must prove raw 8 MiB request streaming and two concurrent uploads within the 128 MB per-isolate limit; failure changes the contract before implementation. |
| Workflow default retries / skipped cleanup | Every step has explicit config; provider steps use `retries.limit: 0`, durable pre-call receipt checks, and `NonRetryableError` after success-without-receipt. The Workflow catches terminal errors inside `run`, performs explicit cleanup before rethrow/finalization, and registers rollback for committed outputs that own cleanup actions. |
| D1 export of encrypted session URLs | D1 exports are secret-bearing artifacts; exports and derived keys have separate custody, and rotation aborts active sessions before ciphertext removal. |
| Access `sub` recycle | A re-added user's new subject receives no old rows automatically; email never transfers ownership, and an explicit old/new-sub migration is required. |
| Import-overwrite IDOR | Parent, child, and registry keys include `principal_sub`; import rejects another principal's matching run ID before any mutation. |

## Consequences

Positive:

- hosted creation reuses the deployed authentication and review surface;
- ownership is explicit at middleware, repository, Workflow, and storage
  boundaries;
- the Worker secret never reaches the browser, and recording memory remains
  bounded during integrity calculation and upload;
- local Studio continues through its existing SQLite executor;
- retention, retry, cancellation, spend, and cleanup become reviewable durable
  state rather than process-local behavior.

Costs:

- every existing D1 row needs a controlled first-principal backfill before
  creation routes can open;
- provider upload-session receipts need confidential, retry-safe handling;
- Workflow versioning, D1 migrations, R2 lifecycle, and Access policies become
  one coordinated release surface;
- Tier B credential custody adds a second secret, rotation, recovery, and
  incident-response obligations.

## Alternatives Considered

### Deploy hosted Studio on Vercel or a second hostname

Rejected because it would split identity, deployment, state, and operations
while the existing Worker + D1 + Access boundary already fits the product.

### Upload directly from the browser to Gemini

Rejected because Gemini resumable upload authorization would expose the shared
Worker key or an equivalent reusable provider credential.

### Hash with one-shot WebCrypto

Rejected because `SubtleCrypto.digest()` is not an incremental streaming API
and would require materializing the complete recording in memory. It remains a
bounded test oracle on small fixtures only.

### Hash on the server across stateless chunk requests

Rejected because durable incremental hash state would have to be serialized or
the full object reread, adding an unnecessary state/ownership boundary and
making retries harder to reason about. Gemini's final provider digest remains
the independent server-verified cross-check.

### Store every recording in R2 before analysis

Rejected because it changes ephemeral analysis into mandatory custody and
retention. R2 is opt-in for retained media only.

### Reuse the local SQLite executor or run long work in a request

Rejected because local process state and request lifetime are not durable
hosted execution boundaries. The port receives a Workflows adapter instead.
