# ADR 0031 — Grant upload retention on each CLI job start

- Status: Accepted
- Date: 2026-11-24

## Invariant

A consumer controls how long the provider may retain each upload a job acquires.

## Decision

Every analysis or transcription job start and analysis dry run requires
`--retention provider|run`. A replacement start supplies its own grant.
Analysis uploads the recording. Transcription uploads its extracted AAC
windows. Under `provider`, each acquired object remains until provider expiry.
Under `run`, the worker reserves a deletion request and attempts cleanup on
every terminal path, including cancellation. Failed acquisition of a known
object also triggers cleanup.

## Consequences

The versioned job receipt records each upload disposition and available expiry.
A confirmed provider response supports a claim of deletion. A lost response
can leave both a charged request and an upload at the provider. The durable
receipt preserves that uncertainty for the next caller. The worker removes
its own local media copies. The caller retains the original recording.

ADR 0024 governs retention on the synchronous CLI. Defaulting a job from that
environment setting would let an unattended start keep or delete media
without a retention choice in its grant.
