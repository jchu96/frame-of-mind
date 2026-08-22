# Track: Local Studio - Drag-and-Drop Analysis

**ID:** `local-studio_20260726`
**Status:** In Progress

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- [Adversarial Plan Review](./review.md)

## Progress

- Phases: 7/9 complete
- Tasks: 41/51 complete
- Current focus: Task 8.1, adding a local-session-protected opaque-ID
  byte-range media route with traversal, expiry, content-type, and hostile-
  request coverage.

## Decision

Phase A runs analysis on the user's machine through Bun. The browser provides
the Studio experience; it does not become the durable execution boundary.
Recording and Intent are required, Context is an optional explicit enrichment,
and the composer may begin with any of those sections. Execution resolves
committed context before media analysis and never fabricates missing context.
Phase B hosted execution is represented through adapter contracts and a
roadmap entry, but is not implemented in this track.

## Quick Links

- [Back to Tracks](../../tracks.md)
- [Product Context](../../product.md)
- [Tech Stack](../../tech-stack.md)
- [Workflow](../../workflow.md)
