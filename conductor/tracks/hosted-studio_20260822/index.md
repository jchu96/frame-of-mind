# Track: Hosted Studio - Team And Tenant Execution

**ID:** `hosted-studio_20260822`
**Status:** Active — Slice 1 and Phase 3 complete; Phase 2 remains in flight

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- [Adversarial Plan Reviews R1 and R2](./review.md)

## Progress

- Phases: 2/8 complete
- Tasks: 8/33 complete
- Current focus: Task 2.0 streaming stop/go remains required. Task 3.0 selected
  an internal sibling Workflows Worker reached from Nuxt by service binding;
  Tasks 3.1–3.4 implement and verify its dark durable execution path. Hosted
  upload remains in flight and the live Nuxt artifact remains unchanged.

## Decision

Tier A extends the existing Cloudflare Worker, D1, Access application, and
hostname with principal-scoped hosted creation and durable Workflows. Uploads
are Worker-proxied to Gemini, full-file integrity is computed incrementally in
a browser Web Worker, recording retention is opt-in, and the local SQLite
executor remains untouched. Tier B adds encrypted per-principal provider
connections only after the Tier A trust boundaries pass review.

## Quick Links

- [Back to Tracks](../../tracks.md)
- [Product Context](../../product.md)
- [Tech Stack](../../tech-stack.md)
- [Workflow](../../workflow.md)
- [ADR 0018](../../../docs/adr/0018-hosted-studio-trust-boundary.md)
