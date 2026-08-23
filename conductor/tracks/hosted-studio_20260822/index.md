# Track: Hosted Studio - Team And Tenant Execution

**ID:** `hosted-studio_20260822`
**Status:** Active — Phases 1–4 complete; Phase 5 retention work remains

## Documents

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- [Adversarial Plan Reviews R1 and R2](./review.md)

## Progress

- Phases: 4/8 complete
- Tasks: 18/33 complete
- Current focus: Phase 5 retention and capture Tasks 5.1–5.2. Phase 2 uses
  adopted ADR 0018 Amendment 2 direct browser → Gemini upload. Phase 5
  spend/telemetry Tasks 5.3 and 5.4 are complete. Phases 2–4 are dark live:
  durable execution, composer, activity, and atomic publication are built and
  contract-proven behind the hosted-mode gate.

## Decision

Tier A extends the existing Cloudflare Worker, D1, Access application, and
hostname with principal-scoped hosted creation and durable Workflows. ADR 0018
Amendment 2 removes the Worker from the recording byte path. The Worker caps
pending sessions, mints a write-only Gemini capability, and seals only after
exact provider size and digest verification. Real Chromium and a fake Files
API prove reload/resume, mismatch deletion, ownership, and janitor races.
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
