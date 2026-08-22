# Reference draft amendment to ADR 0018: stage hosted media in private R2

- Status: Not needed — not adopted; kept for reference
- Date: 2026-08-22
- Amends: [ADR 0018](../adr/0018-hosted-studio-trust-boundary.md)
- Historical trigger: Task 2.0 hosted streaming NO-GO

Task 2.0b resolved both blockers without changing the storage boundary: a
built wrapper entry bypasses Nitro only for the authenticated upload path, and
Cloudflare `DigestStream` supplies the Worker-side streaming digest. This R2
design is therefore not needed for the current track and grants no
implementation authority. It remains as a reviewed fallback reference if the
wrapper contract regresses.

## Preserved invariant

A hosted request may act only for the identity proven by its validated
Cloudflare Access assertion, and no upload, retry, query, or storage adapter
may widen that identity's authority or weaken the durable run contract.

The upload-specific implication is stronger: untrusted recording bytes must
not be materialized in the shared application isolate merely because an HTTP
framework adapts the request.

## Proposed amendment

Replace ADR 0018's default browser → Worker → Gemini raw-part path with a
private, short-lived R2 staging boundary:

- the authenticated Worker creates a principal-owned media receipt and an
  opaque R2 object key that cannot be selected by the browser;
- the browser uploads bounded parts directly to private R2 through narrowly
  scoped, short-lived S3-compatible presigned requests; recording bytes do not
  traverse the Nuxt Worker;
- the existing dedicated browser Web Worker computes the complete SHA-256 with
  `hash-wasm`; R2 completion records exact object length and the client digest;
- hosted execution streams the private R2 object to Gemini from a runtime path
  whose response-stream behavior is separately measured, then normalizes and
  compares Gemini's final digest before analysis;
- ephemeral mode now means short-lived staging custody, not zero R2 custody:
  successful provider ingestion deletes the exact R2 object immediately, and
  a short bucket lifecycle plus incomplete-multipart abort rule remains only a
  backstop;
- retained mode copies or promotes the verified object into a distinct
  principal-owned retention prefix with its own visible expiry; and
- every object key, multipart upload ID, receipt, quota reservation, abort,
  completion, read, and delete is scoped by validated `principal_sub`.

Generating direct R2 upload capabilities adds an R2 access-key secret and CORS
surface. That is a material expansion from ADR 0018's Tier A assertion that
`GEMINI_API_KEY` is the only Worker secret; adoption therefore requires a
fresh secret-custody and threat-model review rather than treating this draft
as an implementation detail.

## Why not only reduce the part size

Nitro 2.13.4 materializes every request body before H3. Four MiB parts would
make each allocation smaller, but they would preserve the forbidden shape,
increase request and receipt count, and leave concurrency as an allocation
multiplier. Smaller parts remain a possible separate amendment only if the
product explicitly accepts bounded materialization and proves its concurrency
ceiling; this draft does not weaken that requirement silently.

## Required proof before adoption

- presigned requests can write only the exact principal-owned key, part, size,
  method, and expiry granted by the Worker;
- cross-principal create/list/complete/abort/read/delete attempts fail closed;
- CORS permits only the hosted origin and required methods/headers;
- duplicate, overlap, missing-part, stale-capability, and killed-upload cases
  reconcile without accepting different bytes;
- client digest, completed R2 object bytes, and Gemini digest agree;
- ephemeral success/failure/cancellation removes the exact object, while
  lifecycle and incomplete-multipart rules clean abandoned state;
- per-principal in-flight bytes, object count, and request rate are bounded;
- D1 exports and logs contain no presigned URLs, R2 credentials, object names,
  recording names, or media bytes; and
- local Studio and durable v2/v3 run contracts remain unchanged.

## Historical consequence before Task 2.0b

Tasks 2.1–2.4 were blocked by the original NO-GO. Task 2.0b has since unblocked
them without adopting this amendment. If a future regression causes this
fallback to be reconsidered, Phase 2 must be replanned around R2 session
creation, direct multipart transfer, verified completion, provider streaming,
and exact cleanup. This draft does not modify ADR 0018 and carries no
implementation or deployment authority.
