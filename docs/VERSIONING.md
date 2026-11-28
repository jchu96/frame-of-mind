# Versioning and Releases

Frame of Mind uses Semantic Versioning for the CLI/package and explicit
versions for durable schemas and prompts.

## Version surfaces

| Surface | Current | Change rule |
|---|---:|---|
| CLI/package | `0.6.7` | Semantic Versioning |
| `analysis.json` schema | `2` (meeting), `3` (video-only) | increment for breaking shape/meaning |
| `manifest.json` schema | `2` (meeting), `3` (video-only) | increment for breaking provenance changes |
| `times.json` sidecar | `2` (default), `3` (speech snapping) | increment for breaking shape/meaning |
| exact-time test table | `2` | increment for changed conversion semantics |
| prompt revision | `2026-08-11.1` | increment for material instruction changes |
| built-in recipe ID | stable string | do not rename after release |

A build that is not a release bundle prints its version with `+source` (for example `0.6.7+source`)
in `--version`, `doctor`, the `version` document, run manifests and the local MCP server. A release
bundle prints the plain version. Hosted Studio reports the plain version: its deploy is its release.
A reader that parses the version must accept the `+source` build mark.

## Machine contract compatibility

Version 1 was frozen on 2026-11-24 and amended before release that day.
Within a schema major version, fields may only be added. Added fields may be absent. Renaming a field,
removing it or changing its type or meaning requires a new schema major. Announce the
change one release ahead and offer both shapes via `--schema-version` in that release. The old major remains the default during the overlap. Readers check
`schemaVersion` before using any fields and accept additional fields in a known
major. Fixed error codes and exit statuses keep their meanings across releases.
The [CLI and MCP contract](MCP_TOOLS.md) lists the current interfaces.

## Before 1.0

- patch: fixes, documentation, tests, compatible provider normalization;
- minor: new recipe/provider/renderer/command or compatible contract field;
- major: reserved for the stable 1.0 contract; before then, breaking text-mode CLI changes
  require a minor bump and prominent migration notes.

## Release checklist

1. Create `release/vX.Y.Z` from current `main` and update the package version.
2. Update `CHANGELOG.md`.
3. Confirm README and runbook commands.
4. Confirm official provider and Google links.
5. Run `bun install --frozen-lockfile`.
6. Run `gate-lock bun run check:deploy` at the committed release head and
   require `CHECK_DEPLOY status=PASS`. This includes the default gate and the
   entire hosted lane; a hosted failure blocks release/deploy even though it
   no longer blocks ordinary pull requests. Required GitHub CI at the exact
   PR head remains the merge oracle: `check`, `browser-e2e`, `auth-contract`,
   and all three `fresh-clone` jobs must pass. This check does not authorize a
   later deployment: `gate-lock bun run deploy:hosted web` (or `workflows`) runs
   both gates again at the revision being deployed before invoking Wrangler.
7. Run `bun run smoke:gemini` with a maintainer key and generated media.
8. Validate the repository skill.
9. Test the skill installer in a temporary home directory.
10. Run `bun audit --production --audit-level=high`.
11. Review generated package contents.
12. Confirm no secrets, recordings, transcripts, or runs are tracked.
13. Commit with `release: vX.Y.Z`, push the release branch, and open a PR against
    `main`. Split harness or test fixes discovered during preparation into their
    own reviewed PRs, as with the hydration-wait fix in
    [#133](https://github.com/jchu96/frame-of-mind/pull/133).
14. Complete review and verify required CI at the final PR head, then merge the
    release PR with a **merge commit**. Record that merge commit's full SHA.
15. Create the annotated tag on that **release merge commit**, not the release
    branch head or a later `main` tip, then push the tag:
    `git tag -a vX.Y.Z <release-merge-sha> -m "Frame of Mind vX.Y.Z"` and
    `git push origin vX.Y.Z`.
16. Wait for the tag workflow to publish the verified CLI and release metadata.
    Download the release and verify its checksums and commit as described in the
    [release procedure](RUNBOOK.md#10-release-procedure).

### Release history

- `v0.4.0` tags merge commit `2f27ad7`; its GitHub release was backfilled on
  2026-09-08 without moving the tag.
- `v0.5.0` tags release PR [#132](https://github.com/jchu96/frame-of-mind/pull/132)'s
  merge commit `f9609ab`; its GitHub release was published on 2026-09-08.
- `v0.6.0` tags its release pull request's merge commit; pre-releases `v0.6.0-beta.1` to `v0.6.0-beta.4` came before it.
- `v0.6.1` tags its release pull request's merge commit. It carries new commands (the experimental job commands and `--thinking-level`) in a patch release by the owner's choice.
- `v0.6.2` tags its release pull request's merge commit. It is a fix release for transcript times.
- `v0.6.3` tags its release pull request's merge commit. It carries optional output fields and one new error code in a patch release by the owner's choice.
- `v0.6.4` tags its release pull request's merge commit. It carries the transcript recheck and its optional output fields in a patch release by the owner's choice.
- `v0.6.5` tags its release pull request's merge commit. It turns the transcript recheck of `v0.6.4` off by default, because that recheck could add lines that are not in the recording.
- `v0.6.6` tags its release pull request's merge commit. It sends full-size stills with each detail request and keeps a screen quotation only when it cites one, removes the transcript recheck, and makes `doctor` name where the provider key came from.
- `v0.6.7` tags its release pull request's merge commit. It lets an operator name a command that supplies the provider key, uses a key that is present on every launch, and lets the local media checks wait longer for a longer recording.
- `v0.3.0` has no tag or GitHub release.

## Model and dependency updates

Model changes require:

- official availability verification;
- prompt/structured-output test;
- video upload and cleanup test;
- changelog note;
- manifest model record.

`@google/genai` updates require:

- compare installed and registry versions;
- read official release/migration notes;
- verify documented resumable upload plus SDK `files.get/delete`;
- verify media metadata and response JSON schema;
- run `bun run smoke:gemini`;
- run the full check suite.

Provider SDK updates require OAuth, tool discovery, schema, and cleanup tests.

## Schema compatibility

CLI and local Studio pair analysis 4 with manifest 2 for meetings and analysis 5 with manifest 3 for video-only runs. Outcome 2 records exact failed spans. Versions 4 and 5 use exact half-open bounds for validation, so a short span can have equal whole-second labels. Historical analysis 2 and 3 and outcome 1 retain strictly increasing text spans. Hosted Studio publishes and imports the historical pairings.

`exactSpan` stores `start` and `endExclusive` on the source grid. A bound carries `frames` with `unit: "video-frame"`, `samples` with `unit: "sample"`, or `ticks` with `unit: "tick"`. Counts are unsigned decimal strings. Frames and samples use `rate: {num,den}` in units per second. Stream ticks use `tick: {num,den}` in seconds per tick. Each bound carries its origin and precision. A model bound also carries the visible support for that reported second.

Renderers must reject unsupported future major schema versions instead of
guessing. Compatible optional fields may be added without incrementing schema
version only when old consumers safely ignore them.

Optional `derivedTranscript` manifest provenance was added to schema 2 and
schema 3 under that additive-field rule, without a schema bump: it appears only
when a run transcribed the recording's own audio, and a consumer that ignores it
still reads a correct run. The rule carries a condition that this release had to
satisfy explicitly. Because both manifest validators are strict, an unknown key
is a hard rejection, so the additive field only stays compatible when every
validator that will read it is updated in lockstep in the same release. That is
what shipped here; do not backport a bundle carrying the field to a release
whose validators predate it. Two additional caveats: on schema 2 the addition
also changes what two pre-existing fields refer to — `transcriptSha256` may now
digest derived text rather than provider text, and `transcriptAlignment` is
pinned to explicit offset 0 — so a v2 consumer must check `derivedTranscript`
before attributing the transcript to the context provider (a cross-field schema
refinement now enforces the pinned relationship). And because SQLite/D1 run
reads re-validate stored manifests, rolling a deployed projection back to a
pre-`derivedTranscript` release makes previously stored derived runs unreadable
at detail-view time; roll the reader forward, not the bundles back.

The optional `derivedTranscript.requestedLanguage` field on schema 2 and 3
records the canonical BCP-47 hint used to derive a transcript. Its absence
means no hint was recorded. It carries no language-detection result and
changes neither the transcript digest nor its alignment. Both schemas use the
same strict provenance validator across import, publication and SQLite/D1 reads.
Roll readers forward before importing or serving bundles carrying this field.
After such a bundle has been stored, a reader predating the field rejects it.

The optional `label` field on manifest schema 2 and 3 records the operator's
`--label` text: one trimmed line of 1 to 200 characters without control
characters. Run folders are named by digests and run IDs, so the label is how
a person tells runs apart; it is never sent to the model or to telemetry. Its
absence means no label was given. It is added under the same additive rule and
the same caveat: both strict validators gain it in one release, so roll
readers forward before importing or serving labelled bundles.

Schema 2 is intentionally incompatible with schema 1 imports. It adds a shared
run ID, an analysis digest in the manifest, strict canonical timestamps, and
recipe revision/content provenance. Re-run the original source analysis to
migrate; do not hand-edit a v1 bundle into v2 because its evidence was not
validated under the v2 timestamp and pairing rules.

The optional `clock.transcriptClock` field distinguishes exact millisecond
representability (`exact-ms`) from a retained legacy alignment (`unverified`);
it does not change `transcriptAlignment.offsetSeconds` or assert model accuracy.

The clocks addition preserves analysis schema versions 2 and 3. Both manifest
versions accept optional clock provenance; `candidates.outOfRange` remains an
optional outcome count (absent means zero). Analysis timestamps and digests do
not change.

### Time sidecar migration: schema 1 → 2

Default runs write schema 2. A schema-1 reader sees `schemaVersion: 2` and must
reject it as unsupported rather than guessing. The prior numeric `source` or
`reel`, numeric `timeline`, top-level `precisionMs` and optional model `timecode`
fields are gone. Each pointer now has a `time` object and optional `timeline`
object, each with clock, decimal-string seconds, precisionMs and model origin.
Only the exact declared offset at `timeline.offset` has frame/tick/timecode
forms. A consumer pinned to a pre-update commit keeps producing and reading
schema-1 bundles until it updates; historical files are not rewritten and no
schema-1 sidecar is dual-written. Treat an old model timecode as an approximate
observation, never as a frame-accurate cut point.

Manifest changes are additive and optional: `clock.timeline.exactOffset` stores
clock, frame count string, rational rate and unit. `timelineOffsetMs` is optional
and may accompany it only when exactly representable and safe. A one-frame
offset at 24000/1001 has no exact millisecond field. The new reader accepts
manifests written at base 5a1b274, including legacy ms-only offsets between
frames and the website re-import path. Older strict readers reject a new
manifest carrying `exactOffset`; update the reader before importing such a
bundle. This is forward acceptance of historical bundles, not a promise that
older strict validators ignore new fields. `analysis.json` does not change.

### Time sidecar migration: schema 2 → 3 with speech snapping

Dispatch on `schemaVersion`. A default analysis writes the existing schema-2
bytes. An analysis requested with `--snap speech` writes only schema 3, even
with zero records or unavailable audio. Strict schema-2 readers reject schema
3. Update a consumer before enabling snapping for its runs. Historical sidecars
keep their original versions.

In schema 3, read `snapSettings` once. Candidate start and end pointers each
require `snap`. Evidence pointers carry only their original readings.
`snapped` supplies a measured target, signed shift, observed pause and alternatives.
`no-boundary` keeps the model time. Its `alternativesMs` lists the sorted
file-clock edges refused because reaching them would cross other speech.
This supersedes the specification's requirement that the list always be empty.
`ambiguous` lists competing edges and `unavailable` carries only its status.
Preserve the model entry on every path.

Both file and timeline measurements carry `gridMs: 10`. Their `precisionMs`
is 300 when the optional `noisy` flag is true. Otherwise it is 50 for source
audio at 32 kHz or higher and 200 for lower or unknown rates. New snaps also
report `floorDbfs` and `speechAboveFloorDb`. Historical schema-3 snaps can
omit these fields. The optional frame reference identifies the frame containing the
proposal. Its uncertainty can span neighbouring frames. The run import
still uses analysis and manifest.

## Prompt revision

Use a date plus sequence:

```text
2026-07-25.2
```

Increment when changing:

- inclusion/rejection policy;
- transcript alignment instruction;
- evidence/inference rules;
- structured output semantics;
- built-in recipe behavior.

Formatting-only code changes do not require a prompt revision.

## Exact-time arithmetic contract

The language-neutral table at `docs/contracts/time-cases.json` is copied byte for byte
from the pinned `exact-time` release. It has its own
`version: 2`. Its rules and expected outputs define exact frames at rational
rates on named clocks, half-open instant containment, explicitly selected
drop-frame, exact decimal-string ticks, and derived seconds as the first whole
millisecond inside a frame, explicitly marked `secondsDerived: true`. These
seconds are a reading form: reconstruct exact time from frames at the rate. A
frame with no whole millisecond (for example frame 1 at 2000/1) reports
`secondsUnavailable` instead of seconds, retaining exact frames, ticks and
timecode. The rate is not rejected. Integers that may exceed JavaScript's safe range
are strings in JSON. Whole-millisecond sources use an internal `1000/1` unit;
without a declared video rate they expose milliseconds, seconds and ticks,
with no video frame or timecode claim. Approximate times are a separate type.

Version 2 adds `entryCases` for decimal seconds with an explicit edge and
for Premiere subtitle milliseconds at up to 1000 fps. Consumers can continue
to use the original `cases` array. The package also supplies `tickCases` for tick-grid conversions. Its tests exercise the table,
and an independent oracle recomputes their expected outputs. Consumers in other
languages can use the same table without adopting this implementation. Changes
to the table's meaning require a new contract version. The table version is independent of
the sidecar and manifest version policies above.

The pure OTIO export uses `RationalTime.1` and `TimeRange.1` (start plus duration).
Its floating rate is explicitly lossy; unsafe integer frame values are refused.
It is an interchange boundary, never the arithmetic implementation. Unlike OTIO,
this contract does not infer drop-frame, truncate frame values, snap nearby
rates, accept skipped DF labels, or wrap elapsed timecode at 24 hours. Table rows
annotate intentional differences from OTIO defaults. Nonstandard rational rates
(such as 11/1) use nominal-rate labels rather than claiming SMPTE conformance.
