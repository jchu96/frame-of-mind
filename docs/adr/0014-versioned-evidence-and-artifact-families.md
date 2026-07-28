# ADR 0014: Version evidence separately from composed artifact families

- Status: Proposed
- Date: 2026-07-28

## Invariant

Every useful conclusion must remain traceable to bounded recording evidence
when the model, recipe, renderer, or target artifact changes.

## Context

Frame of Mind recipes range from UX and repository reviews to communication
coaching, technical explanations, process walkthroughs, SOPs, and open-ended
video questions. The current v2/v3 `details[]` label/value pairs are a useful
compatibility layer, but they cannot enforce the difference between direct
observation, stated intent, interpreted intent, inference, uncertainty, and
guidance.

High-quality implementation artifacts also require more than video extraction.
They combine validated meeting evidence with separately verified repository,
data, product, and operational context. Conversely, coaching needs to compare a
speaker's stated goal, observed behavior, likely intent, audience response,
missed cues, alternatives, and next-time guidance without turning one recording
into a stable judgment about the person.

## Proposed Decision

Introduce a future `analysis.json` v4 with a small shared claim-evidence spine:

- evidence anchors have stable IDs, bounded start/end timestamps, source,
  modality, observation text, verbatim/paraphrase status, and speaker basis;
- claims have stable IDs, epistemic kind, support level, evidence references,
  alternatives, and verification needs;
- findings use an explicit disposition instead of only `accepted: boolean`;
- numeric model confidence is not treated as calibrated probability;
- recipes select bounded typed extensions and a composed artifact family.

Initial artifact families:

| Family | Examples | Required distinctions |
|---|---|---|
| Findings/brief | UX review, product issue, requirements, decisions | observed state, request, implication, uncertainty |
| Procedure | SOP, process walkthrough | prerequisites, ordered steps, branches, exceptions, validation, safety |
| Technical explanation | electrical or construction walkthrough | components, relationships, flow, terminology, assumptions, unknowns |
| Coaching report | self-review, teaching, facilitation | goal, behavior, interpreted intent, audience response, missed cue, guidance |
| Q&A | targeted or exploratory video questions | answered, partial, unanswerable, evidence, assumptions |

Recipe-specific fields remain subordinate to the evidence/claim graph. Custom
recipes declare bounded field definitions rather than arbitrary JSON.

Deep analysis becomes a role-separated pipeline:

1. Flash discovers candidate windows.
2. A bounded evidence pass extracts observations only.
3. `gemini-pro-latest` or another explicitly selected reasoning model derives
   claims from validated evidence IDs.
4. An optional synthesis pass deduplicates, connects, or contradicts claims and
   may cite only existing IDs.
5. A composer combines the validated analysis with separately verified target
   context to produce a rich issue, SOP, explainer, coaching report, or answer.

Before mixed models ship, the manifest must record each pass's role, requested
model, provider-resolved model version when available, prompt/profile revision,
sampling, attempts, and usage. A mutable `*-latest` alias must never masquerade
as a reproducible resolved model.

## Current Compatibility Position

This ADR does not alter v2/v3. The current `--depth deep` option means denser
whole-video sampling plus layered prompting under the existing two-pass schema.
It may use `gemini-pro-latest` for both current passes through `--model`; it is
not yet the role-separated v4 pipeline described above.

Internal or private exemplar artifacts must not be copied into this public
repository. Evaluation uses synthetic or properly licensed golden videos and
artifacts that reproduce the structural quality bar without participant data,
private URLs, screenshots, transcripts, or proprietary repository details.

## Consequences

- One semantic core can support many recipes without becoming one universal
  report object.
- SOP and explainer composers can reuse the same evidence without rerunning the
  video.
- A repository issue remains a downstream, context-grounded artifact rather
  than unverified model output.
- v4, synthesis, per-role model provenance, and schema registries require a
  separately reviewed implementation track.

## Alternatives Considered

### Keep arbitrary label/value details forever

Rejected as the long-term contract. It cannot enforce citations or epistemic
separation and is weak for search, rendering, and automation.

### Add every recipe field to one object

Rejected. It creates a sparse universal blob and couples unrelated consumers.

### Give every recipe an unrelated complete schema

Rejected. Evidence, provenance, temporal validation, and review semantics would
drift.

### Ask one large model pass for the final artifact

Rejected. It mixes observation, interpretation, target-system facts, and
composition, recreating the large malformed-response failure mode and making
unsupported claims harder to detect.
