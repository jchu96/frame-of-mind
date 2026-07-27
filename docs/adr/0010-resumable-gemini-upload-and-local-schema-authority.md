# ADR 0010: Use resumable Gemini upload and keep Zod authoritative

- Status: Accepted
- Date: 2026-07-27

## Invariant

Provider compatibility may change, but a recording must reach only the
authorized Gemini boundary, structured output must satisfy the complete local
contract, and every known temporary remote file must be deleted by default.

## Context

`@google/genai` 2.13.0 `files.upload()` returned an empty 404 under the required
Bun runtime even though the same key and generated video succeeded through
Google's documented resumable Files upload protocol. Gemini 3.6 also rejected
the complete JSON Schema emitted by Zod because the provider accepts only a
subset of JSON Schema keywords.

A successful provider request is not enough to make data durable. The provider
schema cannot carry every local length, refinement, timestamp-ordering, or URL
safety rule. Conversely, weakening the durable Zod contract to fit a provider
would make accepted artifacts less trustworthy.

Google's Interactions API supports the latest feature surface but remains Beta.
The stable `generateContent` path already works for both structured video
passes once upload and schema guidance are corrected.

## Decision

1. Upload video with Google's documented two-step resumable Files REST
   protocol.
2. Put the Developer API key only in `X-Goog-Api-Key` on the fixed upload-start
   endpoint.
3. Accept a resumable URL only when it is HTTPS, has no credentials or fragment,
   and uses the exact `generativelanguage.googleapis.com` host.
4. Disable automatic redirects on both upload requests so the API-key header
   and signed resumable URL cannot cross an unvalidated hop.
5. Stream the local file with its exact byte length and a generic display name;
   never disclose the source basename.
6. Continue using `@google/genai` for file status, stable
   `generateContent`, and exact-name deletion.
7. Derive provider guidance from the authoritative Zod schema through an
   explicit supported-keyword allowlist.
8. Decode every model response as `unknown`, then validate with the complete
   originating Zod schema. Fail closed and report only sanitized issue paths
   and codes.
9. Keep Beta Interactions outside production until a later ADR justifies a
   migration.
10. Maintain an explicit live smoke command that uses generated media and
   exercises upload, index, detail interrogation, and deletion. Do not run it
   automatically in CI or against meeting data.

## Consequences

- Bun no longer depends on the SDK upload wrapper that reproduced the empty
  404.
- Upload, model generation, and cleanup remain one adapter-owned lifecycle.
- Provider schema success never bypasses local validation.
- Some provider responses can still fail local constraints. The run fails
  closed rather than truncating or accepting invalid data.
- If finalization succeeds remotely but the response is lost or invalid before
  a file name is known, immediate deletion cannot be confirmed. Provider
  expiration remains the backstop; sanitized failure reporting must not claim
  cleanup succeeded.
- The direct upload code must be rechecked when Google changes the documented
  host or protocol.

## Alternatives Considered

### Keep using SDK `files.upload()`

Rejected because the required Bun runtime reproduced a wrapper-specific
failure while the documented protocol worked with the same account and media.

### Move all generation to Beta Interactions

Rejected for this release because it expands the migration surface without
solving a durable-contract concern and adopts a Beta API unnecessarily.

### Send the complete Zod-generated schema

Rejected because the provider rejected supported local constraints such as
generated array bounds.

### Remove local constraints or coerce model output

Rejected because provider limitations must not weaken artifact integrity.

### Use Vertex AI and Cloud Storage

Deferred. That is a separate media, IAM, billing, retention, and cleanup
architecture, not a configuration toggle.
