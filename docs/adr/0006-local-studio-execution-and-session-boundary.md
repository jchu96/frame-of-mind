# ADR 0006: Run Phase A Studio locally behind a per-launch session

- Status: Accepted
- Date: 2026-07-26

## Invariant

A browser tab may control a local analysis, but it must not become the durable
executor or widen a loopback service into an unauthenticated credential control
plane.

## Context

Frame of Mind v0.2 has a CLI analysis pipeline and a Nuxt review workspace. The
local workspace currently permits unauthenticated loopback access because it
only imports and reads reviewed run projections. Frame of Mind Studio adds
credential status, session-scoped secrets, media staging, job creation,
cancellation, and deletion. Loopback address and Host validation reduce remote
exposure and DNS rebinding risk, but they do not authorize a local process to
perform these new mutations.

Cloud-first execution would also require private object storage, durable hosted
jobs, team authorization, retention policy, and materially different
operations before the local experience is proven.

## Decision

Phase A is a single-user local Studio:

1. `bun run studio` starts one Bun-owned application process on loopback.
2. The process hosts Nuxt/Nitro and a concurrency-one analysis queue.
3. Analysis continues when the browser closes while the Bun process remains
   alive.
4. Process termination marks active work interrupted. Indeterminate Gemini
   operations never auto-resume; the user creates an explicit linked retry.
5. Every local Studio route requires Host and peer loopback validation.
6. Mutating and sensitive routes also require a high-entropy per-launch
   capability exchanged once for an HttpOnly, SameSite=Strict session cookie.
7. Bootstrap input is immediately redirected to a clean URL and must not enter
   logs, diagnostics, or durable configuration.
8. Browser mutations require same-origin semantics, bounded bodies, and
   non-simple content types or explicit anti-CSRF headers.
9. Cloudflare review builds exclude the local session bootstrap, secret,
   staging, executor, and media-serving implementations. Local-only routes
   return 404 in hosted mode, and a bundle inspection gate rejects `bun:` or
   local-control-plane leakage.
10. Phase B hosted execution is a separate track behind compatible job and
    media contracts.

The existing exact-resource Bluedot and Granola OAuth isolation remains
unchanged.

## Consequences

Positive:

- the first product remains easy to run with Bun and no cloud account;
- closing or refreshing the browser does not stop the job;
- credential and deletion routes are not protected by network location alone;
- hosted review cannot accidentally expose partially implemented local control
  routes;
- concurrency one gives predictable local CPU, disk, and Gemini quota use.

Costs:

- the Bun process must remain running during analysis;
- restart recovery is explicit interruption and retry, not transparent resume;
- local session bootstrap and cookie handling require security tests;
- Phase B needs a different executor and authentication implementation.

## Alternatives Considered

### Loopback and Host validation only

Rejected because credential and destructive mutations need a capability, not
only proof that a request reached localhost.

### Detached background daemon

Deferred because daemon installation, updates, logs, and orphan cleanup add
cross-platform operational complexity before the Studio workflow is proven.

### Tauri or Electron

Deferred because desktop packaging would create a second distribution surface.
The Nuxt browser interface plus Bun process already provides local execution.

### Cloud-first execution

Rejected for Phase A because it would force R2, durable hosted execution,
retention, cost, and organization authentication into the first usable Studio.
