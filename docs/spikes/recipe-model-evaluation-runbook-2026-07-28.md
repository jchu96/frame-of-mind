# Runbook: evaluating recipes, models, and sampling profiles against a golden recording

Status: validated manually on 2026-07-28 (three live runs); automation is the
"eval harness" backlog item. Use this runbook whenever a recipe, model, depth,
or sampling change needs evidence instead of vibes.

## Fixture requirements

- The golden recording MUST be genuinely public (its own license permits reuse,
  e.g. CC-BY) or self-produced. **Hosted-online does not mean public** — a
  restricted or unlisted recording can be analyzed with authorization but can
  never become a shared test fixture, be linked in docs, or have its quotes
  redistributed. The 2026-07-28 validation used an authorized restricted
  recording; its results are recorded, but the fixture must be replaced before
  automation.
- The fixture needs a **human-verified moment list** (oracle): timestamps plus
  one-line observable descriptions, verified against video, audio, and captions
  by a person. Ten-ish moments is enough to be discriminating.
- Prefer a recording with speech, slides or UI, and at least one live-friction
  event; silent footage cannot exercise the transcript ladder.

## Method

1. Freeze everything except one variable per comparison: recipe revision,
   model, or depth — never two at once. Record the exact command lines.
2. Run each configuration once through `frameofmind analyze` (video-only
   source exercises the derived-transcript ladder; keep `--max-moments` equal
   across runs).
3. After each run verify the manifest before reading results: outcome status,
   candidate counts, `derivedTranscript` provenance when the ladder ran, and
   `remoteFile.deleted: true`.
4. Score each run against the oracle with **timestamp tolerance**: the same
   moment anchors at different seconds across runs (observed spread ±90s for
   the same content, e.g. 01:45 vs 02:08 for one moment). Match on content,
   then check the anchor is within the tolerance window.
5. Report recall (oracle moments found), novel finds (candidates the oracle
   lacks — send to human review, they may be oracle gaps), calibration
   (importance ratings spread), guardrail behavior (did it decline to invent
   unobservable evidence?), wall time, and estimated cost.
6. A novel find confirmed by human review gets added to the oracle. The oracle
   only grows through human verification.
7. Delete temporary local derivatives; confirm remote cleanup via the manifest.

## 2026-07-28 baseline results (29m42s teaching recording, max 8 moments)

| Config | Validated | Indexed | Wall time | Est. cost | Notes |
|---|---|---|---|---|---|
| Pro + recipe v1, 0.5 fps | 6/6 | 13 | ~13 min | ~$1.50–1.80 | missed both live-friction moments |
| Pro + recipe v2, 1 fps deep | 8/8 | 13 | ~23–25 min | ~$2.00–2.40 | caught both friction moments; graded importance high/medium; 1 novel find |
| Flash + recipe v2, 1 fps deep | 8/8 | 16 | ~8–9 min | ~$1.20–1.50 | same core moments + 1 different novel find; flat importance (all medium); missed 2nd friction moment in top 8 |

Conclusions adopted (n=1 video — revisit when the harness runs on more
fixtures): recipe design moved results more than model choice; Flash stays the
default (it already is); Pro is opt-in for deliverable coaching passes where
importance calibration and friction coverage justify ~1.3–1.6× token price and
~3× wall time. Pricing snapshot 2026-07-28: Pro ≈ $2/M in, $12/M out (≤200K
prompts); Flash 3.6 $1.50/M in, $7.50/M out; thinking tokens bill as output on
both.

## Recipe-design lessons (transferable)

- Demanding **alternative readings** per interpretation and **pattern names as
  hypotheses** measurably improved usefulness without hurting validation.
- Asking for **friction/recovery moments** explicitly was the difference
  between missing and catching live-error handling.
- Asking for **learner signals when observable** with an explicit
  no-fabrication rule produced honest "not observable in this recording"
  answers on both models — keep that phrasing.

## Next step

Automate steps 4–5: golden fixture + oracle JSON in-repo, a scorer with
timestamp tolerance, run as an opt-in script (live Gemini cost). Tracked as
the top "analysis quality and cost layer" backlog item.
