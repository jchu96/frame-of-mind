# Track: Local Studio - Drag-and-Drop Analysis

**ID:** `local-studio_20260726`
**Status:** In Progress

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- [Adversarial Plan Review](./review.md)

## Progress

- Phases: 8/9 complete
- Tasks: 50/51 complete
- Current focus: Task 9.4, completing the final adversarial release review.

## Decision

Phase A runs analysis on the user's machine through Bun. The browser provides
the Studio experience; it does not become the durable execution boundary.
Recording and Intent are required, Context is an optional explicit enrichment,
and the composer may begin with any of those sections. Execution resolves
committed context before media analysis and never fabricates missing context.
Phase B hosted execution is tracked separately in
[`hosted-studio_20260822`](../hosted-studio_20260822/). Its Access identity,
internal Workflow execution, spend, telemetry, and release-preparation slices
are built but dark; upload materialization and production deployment remain
pending. ADR 0018's Worker-proxied Gemini boundary supersedes the earlier
direct-R2 proposal.

## Quick Links

- [Back to Tracks](../../tracks.md)
- [Product Context](../../product.md)
- [Tech Stack](../../tech-stack.md)
- [Workflow](../../workflow.md)
