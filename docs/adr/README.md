# Architecture Decision Record Log

This directory is the canonical record of durable Frame of Mind architecture
decisions. `docs/project_notes/decisions.md` preserves concise history and
routes future agents here; it is not a second decision authority.

## Status Values

- **Proposed:** under review and not yet an implementation constraint
- **Accepted:** active architecture constraint
- **Deprecated:** retained for history but no longer recommended
- **Superseded:** replaced by a later ADR named in the record

Accepted ADRs are not silently rewritten when the decision changes. Add a new
ADR that names the record it supersedes. Clarifying edits that do not alter the
decision may be made in place.

## Decision Log

| ADR | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-local-first-analysis-pipeline.md) | Keep the analysis pipeline local-first | Accepted | 2026-07-25 |
| [0002](0002-optional-local-vector-retrieval.md) | Make vector retrieval optional and local | Proposed | 2026-07-25 |
| [0003](0003-provider-neutral-context-and-artifact-rendering.md) | Separate meeting context, media, and renderers | Accepted | 2026-07-25 |
| [0004](0004-external-publishing-is-explicit.md) | Keep external publishing explicit | Accepted | 2026-07-25 |
| [0005](0005-review-workspace-as-projection.md) | Keep the review workspace a replaceable projection | Accepted | 2026-07-25 |
| [0006](0006-local-studio-execution-and-session-boundary.md) | Run Phase A Studio locally behind a per-launch session | Accepted | 2026-07-26 |
| [0007](0007-separate-media-job-and-run-lifecycles.md) | Separate media, analysis-job, and durable-run lifecycles | Accepted | 2026-07-26 |
| [0008](0008-local-secret-resolution.md) | Keep new API secrets environment- or session-scoped | Accepted | 2026-07-26 |
| [0009](0009-transcript-first-semantic-scoping.md) | Use transcript-first semantic scoping for bounded media analysis | Accepted | 2026-07-27 |
| [0010](0010-resumable-gemini-upload-and-local-schema-authority.md) | Use resumable Gemini upload and keep Zod authoritative | Accepted | 2026-07-27 |
| [0011](0011-ephemeral-local-context-staging.md) | Keep local context staging bounded and ephemeral | Accepted | 2026-07-27 |
| [0012](0012-explicit-video-only-run-provenance.md) | Record video-only runs without fabricated meeting context | Accepted | 2026-07-28 |
| [0013](0013-defensive-gemini-response-boundary.md) | Defend the Gemini response boundary per candidate | Accepted | 2026-07-28 |
| [0014](0014-versioned-evidence-and-artifact-families.md) | Version evidence separately from composed artifact families | Proposed | 2026-07-28 |

## Adding An ADR

1. Copy the template below to the next zero-padded number.
2. Use a short lowercase-hyphenated filename.
3. State the invariant before the implementation choice.
4. Record rejected alternatives and negative consequences.
5. Add the record to the table above.
6. Update architecture, runbook, Conductor, and project notes when affected.

```markdown
# ADR NNNN: Decision title

- Status: Proposed
- Date: YYYY-MM-DD
- Supersedes: ADR NNNN, if applicable

## Invariant

## Context

## Decision

## Consequences

## Alternatives Considered
```
