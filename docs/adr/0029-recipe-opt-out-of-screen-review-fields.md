# ADR 0029: Let a recipe opt out of screen-review fields

- Status: Proposed
- Date: 2026-11-22

## Invariant

A rendered record shows what the analyst model was asked for and returned. A
placeholder that asserts an absence ("URL: Not visibly confirmed") is honest
only for a run in which that field was in scope.

## Context

Frame of Mind began as a screen-recording reviewer, and three screen-review
fields are woven through every run regardless of recipe:

- the index task asks every recipe for a "UI surface" per candidate
  (`src/adapters/gemini.ts`, both index task variants);
- the detail task carries the `appUrl` rule and asks for visible text copied
  verbatim, which the model returns as `evidence.verbatimUiText`;
- `analysis.md` always prints `Surface: … || Unknown` and, when no URL was
  returned, `URL: Not visibly confirmed`; `report.html` always prints a
  Surface row (`src/services/artifacts.ts`, `renderAnalysis` and
  `renderHtmlArtifact`).

On 2026-11-22 eight one-minute loudspeaker-placement explainer videos were
analysed with a custom teaching recipe. Every one of the 53 accepted records
carried a Surface line ("Instructional video diagram overlay", "On-camera
studio shot") and the URL placeholder, and 47 carried a Verbatim UI evidence
block, often holding only a brand name or a caption. None of it was useful; it was noise
between the reader and the teaching point.

The durable contract is not the obstacle. `where`, `where.surface`,
`where.appUrl` and `evidence.verbatimUiText` are already optional in
`analysisDetailSchema`; `indexedMomentSchema.surface` is optional too. The
noise comes from two places that are not schema: executor prompt text and
renderer placeholders.

The built-in `teaching-points` charter already narrows its own detail pass
("omit where and evidence.verbatimUiText"), which ADR 0016 allows because it
narrows rather than widens. A charter cannot remove the executor's index-task
request for a UI surface, and it cannot change the renderer.

## Decision (proposed)

1. Add one optional recipe field, `screenEvidence`, to both custom recipe
   formats (charter and instruction pair). It defaults to `true`; existing
   recipes are unaffected and their digests do not change because the field is
   absent. `teaching-points` sets it to `false`.
2. When `screenEvidence` is `false`, the executor (not the recipe) changes its
   own task text: the index task asks for an on-screen setting only when one
   matters and drops "UI surface"; the detail task drops the `appUrl` line and
   says to omit `where` and `evidence.verbatimUiText`. Recipes that leave the
   field unset receive byte-identical prompts. The prompt revision is bumped
   because new executor text exists; prompt-prefix digests already record
   which text a run received.
3. The renderer decides from the data, not from the recipe: the Surface line
   and the URL line appear only when the record or its candidate carries a
   surface, and Verbatim UI evidence only when present (as today). Old bundles
   re-render identically wherever a surface was returned, which for
   screen-recording recipes is nearly every record, and no renderer needs the
   recipe definition at render time.

No `analysis.json` or `manifest.json` field changes. The recipe-file contract
gains one optional field, a compatible minor change under `docs/VERSIONING.md`.

## Consequences

- Explainer, lecture and demonstration videos produce records without
  screen-review noise, through a built-in or a custom recipe.
- A screen-recording record with no surface at all loses its
  `Surface: Unknown` and `URL: Not visibly confirmed` lines. That is a small
  visible change to `issue-review` output in a rare case, and arguably more
  honest: nothing about a surface was returned.
- The executor gains a second variant of two task lines, which tests must pin
  (both variants, and byte-identity for recipes without the field).
- Typed artifact families (ADR 0014) remain the long-term home for
  per-family evidence fields; this flag is the bridge under v2/v3.

## Alternatives Considered

### Renderer-only: hide empty fields

Rejected as insufficient on its own. The index pass still fills `surface` for
every candidate because the executor asks for it, so the Surface line and the
URL placeholder still render.

### Key the renderer on built-in recipe IDs

Rejected. Custom recipes could not opt out, and the renderer would depend on
the recipe registry.

### Record the flag in `analysis.json` or the manifest

Rejected for now. It is a durable schema change for a rendering concern the
data already answers.

### Leave it to the recipe text

Rejected. Recipe text cannot amend executor task lines (ADR 0016), and a
recipe that contradicts the task text invites inconsistent output.
