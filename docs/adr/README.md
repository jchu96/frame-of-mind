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
| [0015](0015-derived-transcript-from-recording-audio.md) | Derive a transcript from the recording's own audio | Accepted | 2026-07-28 |
| [0016](0016-recipe-charters-and-executor-owned-prompt-policy.md) | Decompose recipes into charters under executor-owned prompt policy | Accepted | 2026-08-11 |
| [0017](0017-opt-in-sentry-telemetry.md) | Make Sentry telemetry opt-in and codes-only | Accepted | 2026-08-22 |
| [0018](0018-hosted-studio-trust-boundary.md) | Host Studio creation behind principal-scoped Cloudflare execution; 4 MiB materialization-bound Amendment 1 remains proposed in PR #65 | Proposed | 2026-08-22 |
| [0019](0019-pluggable-auth-modes.md) | Make hosted authentication a pluggable Access, Better Auth, or stacked perimeter | Accepted | 2026-08-23 |
| [0020](0020-self-serve-access-requests.md) | Separate sign-in from maintainer-approved hosted access | Accepted | 2026-08-23 |
| [0021](0021-admin-approval-surface.md) | Gate the admin approval surface with a deploy-time maintainer allowlist | Accepted | 2026-08-24 |
| [0022](0022-content-free-analysis-tracing.md) | Content-free analysis tracing extends opt-in telemetry | Accepted | 2026-08-24 |

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
