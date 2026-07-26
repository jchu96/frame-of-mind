# Local Studio Threat Model

Status: Phase 1 implementation baseline

Last reviewed: 2026-07-26

This model covers the local Bun-controlled Studio defined by ADRs
[0006](adr/0006-local-studio-execution-and-session-boundary.md),
[0007](adr/0007-separate-media-job-and-run-lifecycles.md), and
[0008](adr/0008-local-secret-resolution.md). Those decisions are accepted
implementation constraints. Hosted execution remains out of scope.

## Security Invariants

1. Network location is not authorization. Sensitive local routes require a
   per-launch Studio session in addition to loopback peer and Host checks.
2. Recording, context, credential, and model content never become source code,
   logs, telemetry, or committed fixtures.
3. Browser input names opaque resources; only the server resolves private
   filesystem paths.
4. Media, jobs, and published runs retain separate state and authority.
5. A Cloudflare review build contains no local credential, staging, execution,
   deletion, or media-serving implementation.
6. Cleanup failure is recorded and recoverable; it is never reported as
   successful deletion.

## Data Flow And Trust Boundaries

```mermaid
flowchart LR
    U[Local user] -->|selects media and context| B[Browser]
    B -->|loopback HTTP plus Studio session| N[Nuxt and Nitro]
    N -->|typed contracts| J[Concurrency-one executor]
    N -->|opaque IDs only| S[Private local staging]
    J -->|exact-resource OAuth| P[Bluedot or Granola]
    J -->|temporary Files API upload| G[Gemini]
    J -->|atomic v2 publication| R[Private run bundle]
    R -->|validated projection| Q[SQLite review projection]

    subgraph Local machine
      B
      N
      J
      S
      R
      Q
    end
```

Trust boundaries:

- Browser to local server: untrusted request metadata, bodies, filenames, and
  timing.
- Other local processes to local server: potentially hostile despite sharing
  the same user or loopback interface.
- DNS and browser origin resolution: potentially attacker-controlled.
- Provider and Gemini responses: private, untrusted external data.
- Local server to disk: subject to exhaustion, races, partial writes,
  replacement, permissions errors, and process termination.
- Local source tree to Cloudflare artifact: a build-time isolation boundary,
  not merely a runtime feature flag.

## Protected Assets

| Asset | Required protection |
|---|---|
| Gemini and Granola API keys | Environment or process memory only; never returned |
| Provider OAuth state | Exact-resource binding and private existing token store |
| Recording and context bytes | Private staging outside checkout; bounded retention |
| Signed provider URLs | Bearer-secret handling; never log or persist |
| Transcript and provider payload | In-memory processing; bounded excerpts only |
| Active job/event records | Atomic local operational authority |
| `analysis.json` and `manifest.json` | Atomic publication and digest validation |
| Private server paths | Never accepted from or returned to the browser |

## Threats And Required Controls

### Session bootstrap theft

Threat: the launch capability leaks through URLs, logs, browser history,
referrers, screenshots, or diagnostics.

Controls:

- generate at least 256 bits of operating-system randomness per launch;
- bind the bootstrap exchange to a loopback peer and approved Host;
- accept it once, set an HttpOnly `SameSite=Strict` cookie, and immediately
  redirect to a clean URL;
- set `Referrer-Policy: no-referrer` and prevent bootstrap responses from
  caching;
- redact query strings and the capability from request and error logs;
- invalidate the capability and cookie when the Bun process exits.

Verification: reuse, missing-token, wrong-token, log-capture, history, and
clean-redirect tests.

### DNS rebinding and hostile Host

Threat: an attacker-controlled page resolves a hostname to loopback and sends
requests to the local service.

Controls:

- listen on an explicit loopback address, never a wildcard;
- validate the connected peer address and an allowlist of literal local Hosts;
- require the Studio session for every local Studio route;
- require same-origin mutation semantics and JSON or an explicit non-simple
  request header;
- reject forwarded-host trust unless a future deployment mode defines it.

Verification: hostile Host, non-loopback peer abstraction, cross-site fetch,
simple-form request, and forwarded-header tests.

### Untrusted local process

Threat: another process owned by the user calls credential, analysis,
cancellation, deletion, or media routes.

Controls:

- treat loopback as reachability only;
- require the per-launch session for reads and mutations;
- never expose secret values through status APIs;
- bind mutations to strict schemas, body limits, resource state, and opaque
  identifiers;
- keep destructive operations idempotent and record cleanup receipts.

Residual risk: a process able to read browser memory, process memory, or the
launch terminal can steal the capability. Phase A does not defend against a
fully compromised user account.

### Disk exhaustion and partial writes

Threat: a large, concurrent, interrupted, or dishonest upload exhausts disk or
seals incomplete or corrupt media.

Controls:

- cap media at 2 GB and context files at their smaller route-specific limit;
- reserve capacity before accepting bytes and retain a safety margin;
- enforce one writer per part or session transition;
- stream into a private temporary file while counting bytes;
- reject excess bytes immediately;
- stream the final SHA-256 and atomically rename only after exact byte-count
  and MIME validation;
- reconcile temporary and sealed receipts at startup.

Verification: bounded-memory measurement, insufficient-space simulation,
short or long body, digest mismatch, concurrent writer, interrupted write, and
restart tests.

### Path traversal and filesystem replacement

Threat: input names a private path, escapes the staging root, or races a
symlink or replacement between validation and use.

Controls:

- accept only generated opaque IDs;
- resolve paths from trusted receipts under one private server-owned root;
- create files without following user-selected paths;
- fail closed on symlinks or identity changes where the platform exposes the
  check;
- never delete the original user-selected file.

Verification: traversal encodings, separator variants, symlink fixtures,
unknown IDs, and post-seal replacement tests on supported platforms.

### Deletion and retention failure

Threat: the UI claims deletion that did not occur, deletes a user source, or
silently retains private media.

Controls:

- default staged copies to ephemeral;
- make retention explicit, time-bounded, visible, and manually revocable;
- resolve retained-media expiry on the server from a one-hour-to-seven-day TTL
  instead of accepting a client-authored timestamp;
- transition through `deleting` and persist success or a sanitized failure
  receipt;
- retry cleanup without changing an already-published manifest;
- require digest-verified reattachment after expiry or deletion.

Verification: success, missing file, permission failure, process interruption,
expiry, idempotent retry, and wrong-digest reattachment tests.

### Provider and model content injection

Threat: transcript, pixel, MCP, provider, or Gemini content attempts to change
system behavior or escape into HTML or logs.

Controls:

- treat all meeting content as evidence, never instructions;
- preserve immutable prompt constraints and recipe validation;
- render untrusted content as text without `v-html`;
- sanitize stored failures and omit raw provider or model bodies;
- never execute filenames, transcript text, or model-generated commands.

Verification: synthetic prompt-injection strings, HTML or script payloads,
control characters, oversized errors, and log-capture tests.

### Hosted bundle leakage

Threat: a build or import refactor places local control-plane code or callable
routes into the Cloudflare review artifact.

Controls:

- select local and hosted implementations at build time;
- keep local routes and `bun:` modules behind local-only source boundaries;
- make hosted local-control routes resolve to 404, not an authorization error
  that proves the route exists;
- scan the final Worker artifact for forbidden imports, route names, and
  implementation markers;
- run this gate before freezing Phase 3 APIs and in every later phase.

Verification: Cloudflare build, artifact scan, route-manifest scan, and hosted
request tests for every local-only endpoint family.

## Abuse And Failure Matrix

| Scenario | Expected result | Operator action |
|---|---|---|
| Invalid or reused bootstrap | 401 or 404; no cookie; no log disclosure | Restart Studio if capability may have leaked |
| Host or origin mismatch | Reject before body processing | Inspect local DNS and browser extensions |
| Upload exceeds limit | Abort stream and clean partial staging | Select a smaller recording |
| Insufficient disk | Reject reservation or write; never seal | Free disk and explicitly retry |
| Process dies during upload | Reconcile resumable receipt or clean orphan | Resume or abort |
| Process dies during Gemini work | Mark job interrupted; never auto-resume | Create linked retry |
| Cleanup permission failure | Preserve cleanup-failed receipt | Repair permission and retry cleanup |
| Worker contains local marker | Fail build and release | Fix the import or route boundary |

## Phase 1 Exit Evidence

Before API contracts freeze, Phase 1 must record:

- measured request-stream and memory behavior under Bun and Nitro;
- bounded `FileSink` write and atomic seal behavior;
- byte-range behavior for a private synthetic file;
- Cloudflare artifact and route-absence results;
- commands, Bun and Nuxt versions, operating system, fixture size, and peak
  memory measurement method;
- any platform-specific uncertainty that later phases must test.

No real recording, transcript, meeting identifier, provider payload, or
credential may be used as threat-model evidence.

The first measured result is recorded in
[Local Studio Streaming Spike](spikes/local-studio-streaming-20260726.md).
