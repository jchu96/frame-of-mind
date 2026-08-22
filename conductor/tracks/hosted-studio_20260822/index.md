# Track: Hosted Studio - Team And Tenant Execution

**ID:** `hosted-studio_20260822`
**Status:** Active — Slice 1, Task 2.0 (GO), and Task 3.0 (topology B) complete; Phases 2 and 3 unblocked

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- [Adversarial Plan Reviews R1 and R2](./review.md)

## Progress

- Phases: 1/8 complete
- Tasks: 4/33 complete
- Current focus: implement Tasks 2.1–2.4 behind the dark hosted boundary; Task 3.0
  selected an internal sibling Workflows Worker reached from Nuxt by service binding.
  Slice 1 principal-scopes the deployed viewer; hosted upload and Workflow
  creation remain dark until their own gates pass.

## Decision

Tier A extends the existing Cloudflare Worker, D1, Access application, and
hostname with principal-scoped hosted creation and durable Workflows. The
Worker-proxied upload decision passed Task 2.0b through a built exact-path
wrapper and Cloudflare `DigestStream`; the unadopted private-R2 draft is not
needed and remains reference-only. Full-file integrity remains
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
