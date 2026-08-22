# Track: Hosted Studio - Team And Tenant Execution

**ID:** `hosted-studio_20260822`
**Status:** Active — Slice 1 and Phase 3 complete; Phase 2 GO at 4 MiB parts pending ADR 0018 amendment

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- [Adversarial Plan Reviews R1 and R2](./review.md)

## Progress

- Phases: 2/8 complete
- Tasks: 8/33 complete
- Current focus: adopt the proposed ADR 0018 amendment (FR-04: 4 MiB parts, ≤4
  concurrent per principal), then Tasks 2.1–2.4. Task 3.0 selected an internal
  sibling Workflows Worker reached from Nuxt by service binding; Tasks 3.1–3.4
  implement and verify its dark durable execution path. The live Nuxt artifact
  remains unchanged.

## Decision

Tier A extends the existing Cloudflare Worker, D1, Access application, and
hostname with principal-scoped hosted creation and durable Workflows. The
Task 2.0d accepts measured runtime materialization and bounds it by construction:
all 1, 2, and 4 MiB combinations at concurrency 2 and 4 passed, so the proposed
contract is 4 MiB parts with at most four in flight per principal. It remains
pending ADR amendment; the unadopted private-R2 draft is the second fallback.
Full-file integrity remains
incremental in a browser Web Worker, recording retention remains explicit, and
the local SQLite executor remains untouched. Tier B adds encrypted
per-principal provider connections only after the Tier A trust boundaries pass
review.

## Quick Links

- [Back to Tracks](../../tracks.md)
- [Product Context](../../product.md)
- [Tech Stack](../../tech-stack.md)
- [Workflow](../../workflow.md)
- [ADR 0018](../../../docs/adr/0018-hosted-studio-trust-boundary.md)
