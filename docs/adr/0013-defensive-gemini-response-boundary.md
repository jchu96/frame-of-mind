# ADR 0013: Defend the Gemini response boundary per candidate

- Status: Accepted
- Date: 2026-07-28

## Invariant

A provider formatting failure must not erase independently validated evidence,
and no recovery or diagnostic path may weaken the local contract or persist the
rejected provider payload.

## Context

Gemini detail responses can be invalid JSON or nearly conforming JSON. Observed
synthetic reproductions include millisecond timestamps and an overlong
`where.surface`. The previous adapter repaired only responses that reached Zod
validation. Invalid JSON bypassed repair, and one terminal detail failure
escaped the candidate loop and discarded earlier valid records. Cleanup ran,
but a whole-run failure left no durable, sanitized proof of what failed or
whether the exact remote file was deleted.

Provider JSON Schema is an instruction to the model, not a trust boundary. The
local Zod schema remains authoritative.

## Decision

1. Decode every response as `unknown` and validate with strict Zod schemas.
2. Treat missing text, invalid JSON, and local schema failure as bounded
   response failures.
3. Regenerate the complete response at most once with only sanitized field
   paths and issue codes. Never echo rejected values.
4. Normalize only variants that are provably lossless. A timestamp ending in
   `.000` may become its whole-second form. A non-zero fraction is regenerated,
   not rounded. Overlong text is regenerated or the candidate fails; it is not
   truncated.
5. Catch only the typed response boundary per candidate. SDK/provider
   transport failures and unexpected programming errors still abort the run.
6. Retain every schema-valid candidate, including `accepted: false` records.
   Publish `analysis-outcome.json` with separate indexed, selected, omitted,
   validated, accepted, rejected, and failed counts plus bounded failure
   diagnostics.
7. When every selected detail fails response validation, publish an empty
   valid analysis pair with outcome `failed`. When a whole run fails after a
   remote file is obtained—or upload finalization cannot prove whether one was
   obtained—publish only `failure-manifest.json` with sanitized phase/error metadata and
   `not_obtained`, `confirmed_deleted`, `intentionally_retained`, or
   `unconfirmed` cleanup provenance.
8. Keep provider payloads, error messages, transcripts, media paths, focus
   text, and signed URLs out of failure artifacts.

## Consequences

- One bad detail no longer prevents later candidates or discards earlier valid
  candidates.
- Operators can distinguish model rejection from response failure and from
  candidates intentionally omitted by `--max-moments`.
- Repair remains bounded, deterministic, and locally testable.
- Failed-run receipts are intentionally less descriptive than local exceptions;
  privacy takes precedence over post-hoc payload debugging.
- Cancellation remains non-publishing. The owned remote file is still cleaned
  up before staging is removed.

## Alternatives Considered

### Loosen the durable schema

Rejected. It converts provider variance into permanent contract ambiguity.

### Truncate or coerce every near-valid value

Rejected. Truncating evidence or rounding non-zero sub-second timestamps can
change meaning while appearing valid.

### Retry the complete run

Rejected. It repeats expensive successful work and can produce a different
candidate index. Recovery belongs at the smallest independently valid boundary.

### Persist raw provider responses for debugging

Rejected. Recordings and transcripts may contain private, identifying, or
credential-bearing content. Synthetic fixtures represent useful failure shapes.
