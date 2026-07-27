# ADR 0011: Keep local context staging bounded and ephemeral

- Status: Accepted
- Date: 2026-07-27

## Invariant

A local transcript or notes file may inform one analysis, but its private
content must not become durable job state, leak into an HTTP receipt, or
outlive the shortest useful execution boundary without explicit authority.

## Context

The CLI already normalizes JSON, text, Markdown, SRT, and VTT through
`FileContextSource`. Local Studio needs a browser ingestion path without
accepting arbitrary filesystem paths or duplicating transcripts into SQLite.
Unlike recordings, context files are small, replaceable inputs and do not need
resumable multipart upload or review retention.

A job can wait in SQLite after its browser tab closes, so browser memory cannot
own cleanup. Conversely, deleting the staged file immediately after upload
would leave the queued worker with no exact input. Context therefore needs a
short private receipt plus an execution lease, but not a second durable state
machine.

## Decision

1. Accept only UTF-8 JSON, text, Markdown, SRT, or VTT through the local-only
   `POST /api/context-files` route.
2. Require the per-launch Studio session, same-origin mutation checks, an exact
   `Content-Length`, an explicit `X-Context-Format`, a matching allowlisted
   MIME type, and an 8 MiB maximum.
3. Stream request bytes into a private per-user staging root outside the
   checkout. Publish the receipt and content together through an atomic
   directory rename.
4. Return only an opaque ID, format, byte count, SHA-256, and expiry. Never
   return a path, original filename, or body.
5. Keep the receipt file as the context-staging authority. SQLite stores only
   the opaque context ID and expected SHA-256 in immutable job input; it does
   not copy the receipt or transcript.
6. Revalidate regular-file identity, exact size, and SHA-256 immediately before
   execution. The resolver obtains a process-local lease and passes the private
   path only to the existing `FileContextSource`.
7. Release the lease in the executor `finally` path and delete the staged copy
   after success, failure, or cancellation. Cleanup failure cannot replace a
   valid run or the original execution error; the hourly receipt expiry and
   minute janitor remain the retry backstop.
8. Reject external deletion while an execution lease is active. Manual delete
   is otherwise idempotent.
9. Never delete the user-owned source file. Browser upload creates a distinct
   private staged copy.
10. Keep the adapter, routes, paths, environment override, and janitor absent
    from the Cloudflare review artifact.

## Consequences

- Local-file context no longer requires an arbitrary path or durable
  transcript copy.
- A context receipt is intentionally single-use once execution starts.
- Retrying a completed or failed file-context job after cleanup requires
  staging the authorized source again and creating a new immutable attempt.
- Queued but never executed context can remain for at most one hour, subject to
  normal filesystem cleanup success.
- Validation may read up to 8 MiB into memory after the request has streamed to
  disk. This is the explicit small-input bound and is separate from the
  bounded-memory recording path.
- Process crashes cannot preserve an active in-memory lease. Startup expiry
  reconciliation removes expired or abandoned private staging.

## Alternatives Considered

### Reuse resumable media sessions

Rejected because context has a much smaller bound, no playback retention, and
no need for multipart resume. Sharing the state machine would blur ownership
and increase the public API surface.

### Store normalized transcripts in SQLite

Rejected because operational job rows would become a second sensitive-content
authority with unclear retention and projection behavior.

### Keep the browser-selected file path

Rejected because browsers do not expose a durable arbitrary path, and server
APIs must never accept one.

### Retain context for linked retry

Rejected for the first local release. Automatic retention expands privacy
scope; explicit restaging is the honest retry boundary.
