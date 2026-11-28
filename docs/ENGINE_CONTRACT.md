# Propose moments and read exact edges

A finder can submit one JSON document for an original recording. Frame of Mind checks the document locally, grades the selected windows and measures eligible edges on the recording. Gemini's first pass goes through the same check. The CLI capabilities report advertises the candidates major and supported roles.

## Input on the source clock

Twelve Labs accepts a direct upload of up to 200 MB for this route. Many real recordings exceed 200 MB. Use `--from` and `--to` to select a shorter time range. The preflight measures the local cut before sending media to either engine. When the cut is too large, the default two-engine route reports `media-limit` and switches to Gemini for both roles. A chosen Twelve Labs route returns `PROVIDER_LIMIT` with `details.reason = "media-limit"` and a Gemini retry command in `details.retryWith`.

Pass `--candidates FILE` to `analyze`. Hash the complete original file with SHA-256 and use 64 lowercase hex digits. A frame or sample recording uses `rate` in units per second. A tick recording uses `tick` in seconds per unit. Both ratios use positive, coprime safe integers. Length is the exclusive source end as a canonical unsigned decimal string. A tick recording with unknown end has `length: null`. The tool verifies fingerprint, clock and known length before upload. For a locally unknown end it checks fingerprint, unit and tick even if the file states a length. Rows and passes may reach at most one tick beyond the last observed presentation timestamp.

```json
{
  "schemaVersion": 1,
  "recording": {
    "recordingSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "unit": "video-frame", "length": "1500", "rate": {"num":25,"den":1}
  },
  "candidates": [
    {
      "id":"door-1","start":300,"end":400,
      "precisionMs":{"start":1000,"end":1000},"basis":{"start":"model","end":"model"},
      "label":"Door opens","reason":"The latch clicks before the door moves.","surface":"Entry camera",
      "proposedBy":{"engine":"finder","model":"visual-1"},
      "definition":"Find the opening movement",
      "chain":[{"pass":1,"edge":"start","at":305,"precisionMs":120,"basis":"word",
                "by":{"engine":"finder","model":"visual-1"}}]
    },
    {
      "id":"door-2","start":500,"end":600,
      "precisionMs":{"start":500,"end":1000},"basis":{"start":"speech","end":"model"},
      "label":"Door closes","reason":"A second click is audible.",
      "proposedBy":{"engine":"finder","model":null},"chain":[]
    }
  ]
}
```

Document order is the finder’s rank. The budget keeps the first eligible rows and the grader processes them in source-time order. A score is local to its finder. Gemini writes its rows best first, breaking score ties by source start.

IDs are nonempty and unique. The recording owns each half-open interval from start through end-exclusive. Counts are nonnegative JSON safe integers. Each precision is an independent positive safe-integer radius in milliseconds. Basis is one of `model`, `word`, `shot`, `speech`, `person` or `search-hit`. The actor's model may be null. A finite finder-local score, definition, search phrase and surface string are optional. The limits are 10,000 characters for `reason`, 500 for `surface` and 120 for `label`, counted in UTF-16 code units as in the built-in first pass. One field over its limit refuses the entire document before grading. A file returns `USAGE` with `invalid-candidates`. An invalid proposer document returns `PROVIDER_REFUSED` with `invalid-reply`. An empty candidates array is valid. The validator refuses the whole document on an invalid row, chain, identity or schema major. [Machine schema](../schemas/cli/candidates.schema.json)

Passes are numbered consecutively starting at one. A pass moves one edge and strictly reduces its radius. Its entire uncertainty interval must fit inside the previous interval for that edge, and the two edges must stay ordered. A first placement of a search block can move both edges together within the block plus one block of margin on either side, clipped to the available recording and caller range. Both placement entries use model basis, the grading actor and 1,000 ms precision.

With the built-in proposer, `--depth deep` keeps the released first-pass prompt and 1 FPS sampling and also configures grading. With a candidates file it configures grading alone.

The built-in index assigns IDs such as `gemini-1` by original response order. It maps the model’s seconds through the recording’s source-bound rules, applying the sent-window offset once, clipping at the read limit and dropping empty intersections. Printed source times are computed from their exact bounds. The model’s one-second support describes every native unit touched by the stated second. Measurement and `resolvedEdges` use native counts. Each edge initially has model basis and 1,000 ms precision. Kind supplies the label, summary supplies the reason and the optional surface maps directly to the row. High, medium and low importance give scores 3, 2 and 1. The chain starts empty. The grader receives one sentence in the same context section as transcript evidence. It quotes the full reason, or the label if the reason is empty, followed by the surface. A missing or empty surface reads “an unknown surface”. Markup and control characters are escaped. The standing instruction identifies this material as data to check. During a retry the sentence stays in context. Definition and search phrase remain local.

A hostile claim can argue for its own acceptance within the window the caller selected. The grader already sees untrusted speech and screen text there. The tool validates the grader’s typed reply and evidence time against the window. Items and failure rows retain the full proposal, including its surface. Result summaries and evidence quotes come from the grader. The effect of showing the claim was measured on one set of screen recordings.

## Read the answer

On meeting analysis 4 and video-only analysis 5, every accepted or rejected item has `candidateId`, `proposedBy`, `gradedBy`, `proposal` and `resolvedEdges`. The proposal preserves the original row and its passes. `candidate.proposalEdges` gives the latest attributed claim at each edge. `candidate.exactSpan` retains the whole-second support on the read span. Outcome 2 failure rows carry the candidate ID, actors, proposal and proposal edges. Historical bundles can omit these extensions. Treat absent attribution as unknown.

Before cutting, read `resolvedEdges.start` and `resolvedEdges.endExclusive` independently. A clipped cut takes precedence over a successful speech snap. Otherwise the tool writes the latest claim. The following excerpts are on the 25 fps clock of the input above.

| Item and edge | Written resolved edge |
|---|---|
| door-1 start, read begins at frame 310 | `{"bound":{"clock":"source","unit":"video-frame","frames":"310","rate":{"num":25,"den":1},"origin":"cut","precisionMs":0},"by":{"engine":"frame-of-mind","model":null},"status":"measured"}` |
| door-2 start, speech onset at 20.08 s | `{"bound":{"clock":"source","unit":"video-frame","frames":"502","rate":{"num":25,"den":1},"origin":"snap","gridMs":10,"precisionMs":50},"by":{"engine":"frame-of-mind","model":null},"status":"measured"}` |
| door-1 endExclusive, untouched proposal | `{"bound":{"clock":"source","unit":"video-frame","frames":"400","rate":{"num":25,"den":1},"origin":"model","at":400,"precisionMs":1000,"by":{"engine":"finder","model":"visual-1"},"basis":"model","pass":0},"by":{"engine":"finder","model":"visual-1"},"status":"claim"}` |

With speech snapping enabled, search up to the smaller of the latest claimed radius and the configured window. A radius above 3,000 ms skips measurement. The manifest marks that edge `skipped` and its resolved edge carries the attributed claim. A window smaller than two frames or samples also skips measurement. On variable-rate video the floor uses observed frame times. A miss, ambiguity or unavailable audio preserves the full attributed radius. `times.json` keeps the snap history.

## Routes and faults

`--proposer gemini` and `--grader gemini` select roles. Flags override optional recipe `engines.proposer` and `engines.grader`. With a file, the plan's proposer is `{"engine":"file","model":null,"source":"file"}`. Per-row actors remain available on the items. The other selection sources are `flag`, `recipe` and `default`. The reply and manifest contain `enginePlan`. Preview fills `planned` and `expected`, execution fills `planned` and `used`. The unused route field and `reason` are null. Doctor reports null routes when it sees no key. Manifest `engineItems` records the source actor, grader and edge outcomes by candidate ID.

| Code | Fixed reason | Caller action |
|---|---|---|
| USAGE | invalid-candidates | Correct the document structure, chain or out-of-bounds positions. |
| USAGE | candidate-recording-mismatch | Select the matching original recording. |
| USAGE | unsupported-engine | Select a registered engine for the role. |
| USAGE | conflicting-options | Supply a file or select a proposer. |
| PROVIDER_REFUSED | invalid-reply | The assembled engine document failed local validation. |
