# ADR 0012: Record video-only runs without fabricated meeting context

- Status: Accepted
- Date: 2026-07-28
- Amended by: ADR 0015 (clause 5 — a video-only prompt may carry a transcript
  derived from the selected recording's own audio, labeled as derived)

## Invariant

Durable provenance must describe the evidence that was actually supplied. An
optional enrichment source may add context, but its absence or failure must
never be encoded as a meeting, transcript, provider, or alignment that did not
exist.

## Context

The schema-v2 run pair is intentionally meeting-backed. It requires a meeting
identity, context provider and transport, transcript digest, and transcript
alignment. Those fields are useful and truthful when Bluedot, Granola, or a
local context file supplied meeting evidence.

Local Studio also needs to analyze an operator-selected recording with an
Intent but no external Context. Making the existing v2 fields optional would
weaken every v2 consumer. Filling them with empty or synthetic values would
make a formally valid bundle misrepresent its evidence.

## Decision

1. Keep schema v2 unchanged and continue emitting it for meeting-backed runs.
2. Introduce a schema-v3 video-only pair with `context.mode` equal to `none` in
   both `analysis.json` and `manifest.json`.
3. Omit meeting identity, provider, transport, transcript digest, and
   transcript alignment from v3 instead of assigning empty values.
4. Restrict v3 media provenance to an operator-supplied local file. Remote
   meeting media requires real meeting context and remains a v2 concern.
5. Branch Gemini indexing and interrogation explicitly. Video-only prompts and
   response schemas contain no transcript or alignment fields and instruct the
   model to ground claims only in the recording.
6. Select v3 only through explicit `contextMode: "none"` input. A selected
   provider that fails or returns incomplete evidence causes the run to fail;
   it never downgrades to video-only.
7. Keep legacy v2-only importers and projections fail-closed until they
   deliberately adopt the versioned pair. The Studio projection publisher is
   version-aware and may receive v2 or v3; any remaining v2-only consumer must
   reject v3 visibly.
8. Use a recording-digest-derived directory segment only as a local storage
   namespace. It is not a meeting identity and does not enter artifact
   provenance.

## Consequences

- Existing v2 bundles, importers, and meeting-backed CLI behavior remain
  compatible.
- Video-only artifacts state that no external context was supplied and cannot
  accidentally expose a fabricated transcript or provider.
- Core readers that opt into the versioned contract can validate v2 and v3;
  legacy readers reject v3 visibly.
- Studio immutable job input and SQLite/D1 projection adopt v3 through a
  separate additive table family and shared run-version registry. Composer
  launch UX remains a separate step.
- Recording-only analysis has less evidence than an enriched run. Renderers
  and downstream agents must not imply off-screen discussion or participant
  identity.

## Alternatives Considered

### Make the v2 meeting fields optional

Rejected because it changes the meaning of an existing contract and makes
every consumer reason about impossible partial combinations.

### Store empty strings or a synthetic local meeting

Rejected because schema validity would conceal false provenance.

### Silently fall back when a context provider fails

Rejected because provider failure and deliberate video-only intent are
different user decisions with different evidence quality.

### Block all video-only analysis until Studio is complete

Rejected because the core contract and model boundary can be implemented and
tested independently while v2-only projections remain explicitly guarded.
