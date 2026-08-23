# ADR 0018: Host Studio creation behind principal-scoped Cloudflare execution

- Status: Accepted
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
- recording bytes travel browser → Gemini directly through a resumable upload
  session that the Worker opens with the secret key and hands to the browser
  as a write-only session URL; the Worker never carries recording bytes, and
  Frame of Mind never stores them unless the user explicitly chooses retained
  media (Amendment 2, superseding the original Worker-proxied 8 MiB parts); this supersedes local Studio's provisional Phase B
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
| Isolate-memory DoS | Task 2.0 measured that workerd materializes a proxied part under backpressure; Amendment 2 removes the Worker from the byte path, so isolate memory is no longer a function of upload size. Open sessions per principal are capped instead. |
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

Originally rejected on the assumption that resumable upload authorization
would expose the shared Worker key. The 2026-08-23 spike
(`docs/spikes/hosted-direct-upload-spike-2026-08-23.md`) disproved that
assumption: the session URL carries no credential, is write-only to one
file, and cannot create or list files. Adopted by Amendment 2.

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

## Amendment 2 (adopted 2026-08-23): browser → Gemini direct upload

**Supersedes Amendment 1.** Amendment 1 (4 MiB proxied parts, PR #65) is
withdrawn; the Worker leaves the recording byte path entirely.

**Finding.** Measured against the real Gemini Files API from real Chromium at
a loopback origin: the Worker opens a resumable session with the secret key
and returns only the session URL; the browser PUTs the recording directly to
Google with `X-Goog-Upload-Command` / `-Offset` headers; CORS preflight
succeeds from a non-Google origin; no API key or bearer appears in the URL,
request headers, or any response; a captured session URL can only write bytes
to that one file (it cannot create, list, or read files); the session has a
provider-side TTL and supports offset query/resume after a client restart;
`files.get` returns `sizeBytes` and `sha256Hash` of the uploaded bytes.

**Decision.**
- `POST /api/hosted/media` creates a principal-owned media session with a
  declared size, declared SHA-256, and MIME type, opens the Gemini resumable
  session server-side, stores the Gemini file name, and returns the session
  URL to the browser. The Worker holds at most **N open sessions per
  principal** (default 2) — enforced in D1 before the Gemini call — and
  refuses a new session while the cap is reached.
- The browser uploads directly to the session URL. Part size is a browser
  concern (Google's 256 KiB multiple rule), not a trust property.
- `POST /api/hosted/media/:id/seal` asks the Worker to call `files.get` and
  **requires** `sizeBytes` and `sha256Hash` to equal the declared values;
  a missing hash fails closed. Only then is the sealed-media receipt written
  and `ensure_gemini_file` allowed to proceed. A mismatched or abandoned
  session is deleted from Gemini by the Worker (and by the Phase 5 janitor
  for expired sessions).
- FR-04 and AD-4 in the hosted spec are rewritten to match; the 4 MiB /
  8 MiB part constants, the wrapper-entry upload path, and the proxy
  streaming oracle are retired (the wrapper entry remains only as the
  production `main` that delegates to Nitro).

**What changes in the trust statement.** The Worker never sees recording
bytes. The browser holds a short-lived, single-file, write-only capability
URL; leaking it lets a third party write into that one pending file before
seal, which the digest check detects and rejects. The Gemini key stays a
Workflows-Worker / Nuxt-Worker secret and is never sent to the browser.

**Rejected alternatives.** Worker-proxied parts (Amendment 1): bounded only
by part size × concurrency and measured to materialize in isolate memory.
Private R2 staging: adds a second custody of ephemeral recordings.

**Adoption.** Adopted for Phase 2 on 2026-08-23. Phase 2 is re-planned as:
2.1 media session + cap, 2.2 browser direct upload + resume, 2.3 seal with
size+digest verification, and 2.4 abandoned-session cleanup. The built-Worker
contract uses a fake Files API and real Chromium.
