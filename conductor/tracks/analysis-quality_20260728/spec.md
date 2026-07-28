# Specification: Analysis Quality and Cost Layer

**Track ID:** `analysis-quality_20260728`
**Type:** feature
**Created:** 2026-07-28
**Status:** Proposed (spec drafted; plan pending approval)

## Summary

Make analysis-pipeline changes measurable, predictable, and cheaper. Build the
evaluation harness first so every later recipe, model, depth, and sampling
change is a scored decision; then add pre-run cost estimation, transcript-led
pre-clipping, and duration-adaptive sampling in that order.

## Context

PR #32 shipped the derived-transcript ladder and was validated by three live
runs over one authorized recording, compared by hand against a human-verified
moment list. That comparison worked — it upgraded the teaching-method recipe
from v1 to v2 and settled Flash-vs-Pro empirically — but it does not scale
past one afternoon. The method is captured in
`docs/spikes/recipe-model-evaluation-runbook-2026-07-28.md`; this track
automates it and then spends the savings it unlocks.

## Architectural Invariant

> No pipeline change that affects what the model sees (sampling, prompts,
> recipes, models, clipping) ships on judgment alone once a scored harness
> exists; and no evaluation fixture may be a restricted recording — hosted
> online is not public.

## Scope (priority order)

1. **Evaluation harness.** Golden fixture (genuinely public or self-produced
   recording — the 2026-07-28 validation recording is restricted and must be
   replaced) + human-verified oracle JSON + a scorer with timestamp-tolerant
   matching (±90s observed) reporting recall, novel finds, calibration spread,
   guardrail behavior, wall time, and estimated cost. Opt-in script (live
   Gemini spend), not part of `bun run check`.
2. **Pre-run cost/time estimate.** ffprobe duration × documented token rates
   (~300 tok/s video default res, ~32 tok/s audio) × model price, printed
   before upload and recorded in the manifest; `--dry-run` exits after the
   estimate.
3. **Pre-clip automation.** Use derived/provider transcript timestamps plus
   operator scope to cut the smallest useful local derivative before upload
   (ADR 0009's operator step, automated). Original recording is never touched.
4. **Duration-adaptive sampling.** fps ladder by recording length, shipped
   only with harness evidence that recall holds.
5. **Tail (harness-gated or Studio-driven):** ffmpeg scene-detect candidate
   corroboration, contact-sheet artifacts for review, Studio surfacing of
   derived-transcript provenance and an opt-out control in the job input.

## Out of scope

- Whisper or any non-Gemini transcription provider (new trust boundary).
- ADR 0014's typed evidence/claim schema v4 (separate track).
- Hosted-studio execution concerns.

## Constraints carried from decisions

- Flash (`gemini-3.6-flash`) stays the default model; Pro is a deliberate
  per-run upgrade (`docs/project_notes/decisions.md`, 2026-07-28).
- Evaluation fixture licensing per the invariant above
  (`docs/project_notes/gotchas.md`, 2026-07-28).
- Manifest changes follow the additive-lockstep rule in `docs/VERSIONING.md`.
