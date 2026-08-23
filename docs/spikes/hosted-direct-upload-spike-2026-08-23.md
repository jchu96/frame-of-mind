# Hosted direct Gemini upload spike — 2026-08-23

## Decision

**GO for ADR 0018 Amendment 2 review; no implementation authority until the
amendment is adopted.** A validated browser can receive one Gemini resumable
session capability without receiving the project API key, upload recording
bytes directly to Gemini, and resume after a complete client restart. This
removes the Worker from the recording byte path and makes the prior 4 MiB
Worker-materialization bound irrelevant to this path.

The GO has one required protocol change: browser finalization is
**indeterminate**, not self-authorizing. Across repeated runs Chromium sent the
final part but received either `NetworkError` or `TimeoutError`, with no final
response headers. In both cases a
Worker-side `query` immediately reported `final`, exact size 20,971,520, and
the file receipt. `files.get` then confirmed the exact size and provider digest
before exact deletion. Hosted code must therefore treat browser finalize
success, network error, and timeout identically: ask the Worker to reconcile
the session; only the Worker may seal the media receipt.

The spike changes no deployed Worker, route, or Wrangler configuration. It is
standalone and is not part of `bun run check`.

## Invariant and implication

The invariant is not “the browser may never receive a provider URL.” It is:

> The browser never receives project-wide Gemini authority, and every
> delegated media capability is principal-owned, single-file, size-bounded,
> digest-bound, time-bounded by Frame of Mind, and unable to authorize
> analysis until independently verified.

The existing Worker-proxy rule preserved the first clause by keeping every
provider capability server-side, but the slow-sink spike showed that the rule
also forced recording bytes through a materializing runtime. The live evidence
below shows that the resumable URL is a narrower bearer capability: it can
advance one already-created upload, but cannot start another File or call the
project Files collection.

## Method

`scripts/spike-hosted-direct-upload.ts`:

1. creates a valid three-second synthetic MP4 and pads it to exactly 20 MiB
   with a valid top-level ISO BMFF `free` box;
2. starts a real Gemini resumable Files upload with `GEMINI_API_KEY` read only
   from `process.env`;
3. opens Chromium at `http://127.0.0.1:<ephemeral-port>`;
4. sends a 16 MiB `PUT` with `X-Goog-Upload-Command: upload`;
5. closes the complete browser, starts a fresh browser, and queries the exact
   accepted offset;
6. sends the remaining 4 MiB with `upload, finalize`;
7. reconciles the indeterminate browser result from the Worker side, verifies
   size and SHA-256 through `files.get`, and deletes the exact File; and
8. attempts unauthenticated new-file, list, control-delete, and post-delete
   query operations without printing any URL, key, file ID, provider body, or
   provider request ID.

The 16 MiB non-final chunk is an exact multiple of Gemini's live-advertised
8 MiB chunk granularity; the shorter final chunk is 4 MiB.

## Q1 — What is in the session URL?

**PASS.** The start request returned HTTP 200. The upload URL and control URL
were identical in the decisive run. Each contained only these query-parameter
names:

```text
upload_id
upload_protocol
```

Neither URL contained `key`, `api_key`, `access_token`, an Authorization
value, the API-key bytes, or a bearer-token shape. Subsequent browser PUTs sent
neither `X-Goog-Api-Key` nor `Authorization`.

Start-response header names (values intentionally omitted) were:

```text
alt-svc
content-length
content-type
date
server
x-goog-upload-chunk-granularity
x-goog-upload-control-url
x-goog-upload-header-content-type
x-goog-upload-header-vary
x-goog-upload-header-x-google-backends
x-goog-upload-header-x-google-esf-cloud-client-params
x-goog-upload-header-x-google-gfe-backend-request-cost
x-goog-upload-header-x-google-security-signals
x-goog-upload-header-x-google-session-info
x-goog-upload-status
x-goog-upload-url
x-guploader-uploadid
```

Google's Files example starts the session with `X-Goog-Api-Key` and then sends
the bytes to the returned URL without resending the key. The live run confirms
that using a header for the start request does not copy the key into the
returned URL. See the official [Files REST API](https://ai.google.dev/api/files)
and [Files guide](https://ai.google.dev/gemini-api/docs/files).

## Q2 — Does browser CORS permit a two-part direct upload?

**PASS, with mandatory Worker reconciliation after finalize.** Chromium sent
20,971,520 bytes by PUT in two direct requests. The first PUT returned 200.
After the browser was fully closed, a new Chromium instance queried offset
16,777,216 and resumed from that exact byte.

The observed OPTIONS response was 200. Headers below are verbatim from the
decisive run except that no secret-bearing/provider-ID header was present:

```text
access-control-allow-credentials: true
access-control-allow-headers: content-type,x-goog-upload-command,x-goog-upload-offset
access-control-allow-methods: PUT
access-control-allow-origin: http://127.0.0.1:54408
alt-svc: h3=":443"; ma=2592000,h3-29=":443"; ma=2592000
content-length: 0
content-type: text/plain; charset=utf-8
date: Sun, 23 Aug 2026 01:21:42 GMT
server: UploadServer
```

The first upload response was 200 with these headers; the provider upload ID
is redacted by policy:

```text
access-control-allow-credentials: true
access-control-allow-origin: http://127.0.0.1:54408
access-control-expose-headers: Access-Control-Allow-Credentials, Access-Control-Allow-Origin, Access-Control-Expose-Headers, Content-Length, Content-Type, Date, Server, Transfer-Encoding, X-GUploader-UploadID, X-Goog-Upload-Status, X-Google-Trace
alt-svc: h3=":443"; ma=2592000,h3-29=":443"; ma=2592000
content-length: 0
content-type: text/plain; charset=utf-8
date: Sun, 23 Aug 2026 01:21:42 GMT
server: UploadServer
x-goog-upload-status: active
x-guploader-uploadid: <redacted-provider-id>
```

The final recorded browser PUT returned `TimeoutError`; an earlier run returned
`NetworkError`. Neither exposed final response headers to browser code. The
Worker query returned HTTP 200 with
`x-goog-upload-status: final`, offset 20,971,520, and the File receipt.
`files.get` reported size 20,971,520 and a digest matching the exact local
fixture; `files.delete` then returned successfully. This result is why a
browser response must never seal hosted media by itself.

Google documents `upload`, `upload, finalize`, aligned chunks, and `query` in
its [resumable upload protocol](https://developers.google.com/photos/library/guides/resumable-uploads).
The Gemini guide documents `files.get`, delete, 2 GB per File, 20 GB per
project, and 48-hour File retention. Session lifetime is addressed separately
below.

## Q3 — Does the capability widen to project authority?

**PASS.** The browser received only the session/control URL and upload command
headers. A `start` command sent to the captured session URL returned 404. A GET
to the Files collection without the API key returned 403. Neither response nor
any browser request contained the key or an Authorization header, and no new
File receipt was returned.

The capability is still sensitive: its holder can choose the bytes committed
to that one declared upload until finalization. The digest gate is therefore a
security boundary, not an integrity enhancement.

## Q4 — Lifetime, restart, and invalidation

- **Restart:** proven. A new browser queried and resumed at the exact accepted
  offset of 16,777,216.
- **Final-response loss:** proven. Worker query recovered a `final` receipt and
  exact size after browser `NetworkError` and `TimeoutError` variants.
- **File retention:** Gemini documents automatic deletion after 48 hours; the
  spike deleted the File immediately.
- **Session lifetime:** Gemini's Files documentation does not publish a
  session-specific lifetime. Google's resumable protocol documentation says
  seven days. Treat seven days as an upper-bound protocol observation, not a
  Gemini-specific SLA; Frame of Mind must use a shorter application TTL.
- **Active revoke:** no supported Gemini active-session revoke is documented.
  The returned control URL was identical to the upload URL. A control `DELETE`
  after finalization returned 400. Deleting the finalized File succeeded; a
  later browser query had no usable response and did not report an active
  session. Do not claim that `files.delete` revokes an unfinished session.

The operational consequence is explicit: the Worker can stop minting and stop
honoring a D1 receipt, but a browser that already holds an unfinished session
URL may retain that one bounded capability until provider expiry. Quotas and
digest verification bound the residual risk.

## Q5 — Bounds and ownership proposal

Use these initial Tier A bounds:

- at most **4 open upload sessions per `principal_sub`**;
- at most **2 actively transferring sessions per principal** in the browser;
- at most **2,000,000,000 declared bytes per session**, additionally bounded
  by a lower operator-configured account ceiling when present; and
- a **one-hour Frame of Mind receipt TTL**, independent of the longer provider
  session/File lifetimes.

The Worker creates a D1 row before returning the session URL. The row binds:

```text
principal_sub
opaque media_id
declared byte size
validated MIME
lowercase full-file SHA-256 commitment
encrypted upload/control session capability
provider chunk granularity
created/expires timestamps
state and last reconciled provider offset
```

The browser computes the complete digest before session creation, sends only
that commitment and bounded metadata to the Worker, then uploads sequential
aligned parts directly to Gemini. On completion or any final-response error,
the browser asks the Worker to reconcile. The Worker queries the encrypted
session capability, pins the exact File identity, calls `files.get`, and
requires both exact size and normalized provider digest before marking the
media row sealed. A mismatch deletes the exact File and blocks Workflow
creation.

`ensure_gemini_file` accepts only that principal-owned, unexpired, sealed,
size-and-digest-matched receipt. The Workflow repeats `files.get` immediately
before provider use. D1 never stores recording bytes, a browser response never
authorizes analysis, and default terminal cleanup deletes the exact Gemini
File.

## ADR 0018 Amendment 2 — PROPOSAL

**Status: PROPOSAL — not adopted; grants no implementation authority.**

Amend Architectural Decision 4 and FR-04 so that hosted ephemeral media uses
browser-direct Gemini resumable upload instead of Worker-proxied recording
bytes:

1. The authenticated Worker creates the provider session with
   `GEMINI_API_KEY`, stores the capability encrypted in a principal/media-bound
   D1 row, and returns the upload URL to that principal's browser.
2. The returned URL is an explicit single-upload bearer capability. It may
   never appear in logs, telemetry, errors, run bundles, or normal HTTP
   receipts after the upload page no longer needs it.
3. The browser sends sequential PUT chunks aligned to the provider-advertised
   granularity and may resume only from a Worker- or provider-reconciled exact
   offset. The Worker never receives recording bytes.
4. Browser finalize is always indeterminate. Success, timeout, network error,
   tab loss, and restart all converge on one Worker reconciliation operation.
   Only the Worker query plus `files.get` can commit the exact File identity.
5. A media receipt seals only after provider size and SHA-256 match the
   principal-bound declaration. `ensure_gemini_file` repeats that verification
   before Workflow use.
6. D1 enforces four open sessions and the configured byte ceiling per
   principal. Frame of Mind expires its receipt after one hour. Because no
   supported active revoke is proven, abandoned provider sessions remain a
   bounded residual risk until provider expiry.
7. Finalized ephemeral Files are deleted on success, failure, cancellation,
   expiry reconciliation, and digest mismatch. Retained media remains a
   separate explicit private-R2 decision and is not implied here.
8. The 4 MiB Worker-proxy amendment remains a fallback only. If Amendment 2 is
   adopted, its memory/concurrency numbers do not govern the direct byte path.

### Amendment gate

Before hosted upload routes may leave the dark state, implementation must add
offline contracts for principal/session quotas, encrypted capability custody,
final-response reconciliation, restart, digest mismatch, expiry, deletion,
foreign-principal access, and secret/URL non-disclosure, plus one opt-in live
browser smoke reproducing this spike. Deployment, D1 migration, route enablement,
and production secret changes remain separately gated.

## Receipt

```text
HOSTED_DIRECT q1-session-url=PASS start_status=200 url_param_names=upload_id,upload_protocol api_key_in_url=false bearer_in_url=false subsequent_auth=none
HOSTED_DIRECT q2-first-chunk=PASS status=200 preflight_status=200
HOSTED_DIRECT q4-restart-query=PASS status=200 offset=16777216
HOSTED_DIRECT q2-final-chunk=FAIL status=0 error_stage=upload error_name=TimeoutError
HOSTED_DIRECT q2-final-reconcile=PASS status=200 upload_status=final offset=20971520 file_receipt=present
HOSTED_DIRECT q2-browser-cors=PASS method=PUT chunks=2 bytes=20971520 final_reconciled=true files_get_size=20971520
HOSTED_DIRECT q3-key-exposure=PASS browser_key=false browser_authorization=false new_file_status=404 list_files_status=403 new_file_count=0 capability_scope=one_declared_upload
HOSTED_DIRECT q4-lifecycle=PASS documented_session_ttl=7d_protocol_level gemini_specific_ttl=not_published live_restart=true final_response=browser_error_worker_reconciled active_revoke=not_documented post_finalize_control_delete_status=400 file_delete_session_active=false
HOSTED_DIRECT cleanup=PASS remote_files_deleted local_fixture_deleted_on_exit
HOSTED_DIRECT_SPIKE PASSED
```
