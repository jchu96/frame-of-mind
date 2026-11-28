# Propose moments and read exact edges

A finder can submit one JSON document for an original recording. Frame of Mind checks the document locally, grades the selected windows and measures eligible edges on the recording. Gemini's first pass goes through the same check. The CLI capabilities report advertises the candidates major and supported roles.

## Input on the source clock

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
      "label":"Door opens","reason":"The latch clicks before the door moves.",
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

IDs are nonempty and unique. The recording owns each half-open interval from start through end-exclusive. Counts are nonnegative JSON safe integers. Each precision is an independent positive safe-integer radius in milliseconds. Basis is one of `model`, `word`, `shot`, `speech`, `person` or `search-hit`. The actor's model may be null. A finite finder-local score, definition and search phrase are optional. An empty candidates array is valid. The validator refuses the whole document on an invalid row, chain, identity or schema major. [Machine schema](../schemas/cli/candidates.schema.json)

Passes are numbered consecutively starting at one. A pass moves one edge and strictly reduces its radius. Its entire uncertainty interval must fit inside the previous interval for that edge, and the two edges must stay ordered. A first placement of a search block can move both edges together within the block plus one block of margin on either side, clipped to the available recording and caller range. Both placement entries use model basis, the grading actor and 1,000 ms precision.

With the built-in proposer, `--depth deep` keeps the released first-pass prompt and 1 FPS sampling and also configures grading. With a candidates file it configures grading alone.

The built-in index assigns IDs such as `gemini-1` by original response order. It maps whole seconds to source counts by rounding start down and end up, adding the sent-window offset once, clipping to the end and dropping empty intersections. The model’s printed seconds come from its reply on the sent video. For example, a start of `00:00:01` on a whole recording at 30000/1001 fps projects to frame 29. Keep the original second for the model’s text. Measurement and `resolvedEdges` use the native count. Each edge initially has model basis and 1,000 ms precision. Kind supplies the label and summary supplies the reason. High, medium and low importance give scores 3, 2 and 1. The chain starts empty. The four free-text fields stay in local provenance. Grading requests and retries use the verified window, media, operator instruction and scoped context.

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
