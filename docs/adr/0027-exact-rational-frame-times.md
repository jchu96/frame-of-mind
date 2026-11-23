# ADR 0027: Exact times are whole frames at a rational rate

- Date: 2026-11-17
- Status: Accepted
- Supersedes: the 2026-11-13 integer-millisecond decision for exact times only

## Invariant and measured fault

Never print a form of time more exact than its source. An exact time is one
non-negative whole frame count at a reduced positive rational rate, on a named
source, reel or timeline clock. All output forms are derived from that value.
An approximate time retains its precision and origin and cannot enter an exact
conversion. A future snapped time must retain both its target and the
approximate time it came from; this change implements no snapping.

Whole milliseconds cannot represent every frame boundary. At 24000/1001,
frame 2 starts at 83.4166… ms; storing 83 ms makes the correct containment
renderer return frame 1. Nearest-ms storage loses 6,593 of 14,386 frames at
24000/1001 and 8,393 of 17,983 at 30000/1001 over the first ten minutes.
The renderer was correct for its input; the stored representation was lossy.
The regression was demonstrated before the frame-based implementation.

## Decision

`src/domain/exact-time.ts` owns exact conversions. Use integer/BigInt arithmetic;
there is no runtime dependency. Rates retain the four named decimal aliases,
reduction and explicit drop-frame policy. Drop-frame is allowed only at
30000/1001 and 60000/1001, never inferred by a conversion. Reject skipped DF
labels, mismatched separators, out-of-range frame fields, negative values and
malformed or padded input. Elapsed hours do not wrap at 24.

Ticks use 254,016,000,000 per second and serialize as decimal strings. A rate
with fractional ticks per frame reports ticks unavailable with a reason.
Reading seconds use the first whole millisecond inside the frame, written to
three decimals and marked `secondsDerived: true`; they are a display, never the
exact reconstruction path or necessarily the frame boundary. Reconstruct exact
time from whole frames at its rate. An instant on a boundary belongs to the
frame starting there; no nearest-frame rule is introduced.

At rates above 1000 fps, some frames contain no whole millisecond. Frame 1 at
2000/1 spans [0.5, 1) ms. Keep the accepted rate and exact frames, ticks and
timecode; omit only `seconds` and provide `secondsUnavailable` with the reason.
A direct request for that seconds form refuses. This edge has an independent
table row; it never rounds to a neighboring frame or rejects the whole time.

A whole-millisecond source without a video rate uses internal rate 1000/1,
explicitly labeled as a millisecond source. Its public output contains whole
milliseconds, seconds and ticks, with no video frame or timecode claim.
`docs/contracts/time-cases.json` is the versioned language-neutral contract.
An independent sequential-label oracle checks its values; a counted runner
exercises every row and each available inverse conversion.

Model HH:MM:SS observations remain approximate in `times.json`, Markdown, HTML
and progress lines. Moving them to a timeline retains `precisionMs: 1000` and
`origin: model`; the display uses millisecond decimal strings (ceiling only for
display when the exact offset is fractional), without producing frames, ticks
or timecode. The declared exact offset is emitted separately in every available
form. `--timeline-offset` accepts seconds, `Nf` frames, or timecode at a stated
rate. A seconds offset between frame boundaries is refused with its neighboring
frame numbers, never rounded.

A time-of-day clock is refused: midnight wraps and a date is required to make
it exact. No cut-point input currently needs it. A transcript beginning with
time of day is already aligned by its transcript offset, which remains context
alignment, not a cut point. Revisit only when a concrete input requires it.

## OpenTimelineIO vocabulary and intentional differences

Use its nouns: a value over a rate, and a range as start plus duration. The pure
exports use `RationalTime.1` and `TimeRange.1`; only their floating rate is lossy.
Refuse unsafe integer frame values at this export boundary. OTIO is not a
runtime or CI dependency and its arithmetic is not adopted.

Source read 2026-11-17, commit `bad7ab5a40ac1a95d9d78a87c95a688d8b57cf28`
(dated 2026-11-10):

- [rationalTime.h](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/bad7ab5a40ac1a95d9d78a87c95a688d8b57cf28/src/opentime/rationalTime.h):
  double value/rate storage, truncating frame conversion and inferred DF default.
- [rationalTime.cpp](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/bad7ab5a40ac1a95d9d78a87c95a688d8b57cf28/src/opentime/rationalTime.cpp):
  nearby-rate snapping, permissive fixed-field parsing and 24-hour wrapping.
- [time ranges](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/bad7ab5a40ac1a95d9d78a87c95a688d8b57cf28/docs/tutorials/time-ranges.md):
  a source's own start timecode belongs to its available range.

Our integer/rational arithmetic, lexical refusals, explicit DF choice, skipped
label rejection, unlimited elapsed hours, and separate approximate type are
intentional differences. Nonstandard rational rates such as 11/1 use nominal
labels without claiming SMPTE conformance. The table marks differing rows and
the reason; no claim of running OTIO itself is made.

## Compatibility

`times.json` changes to schema 2 with no dual-write. Model entries have a `time`
object and optional `timeline` object; the exact offset is `timeline.offset`.
`analysis.json` and its digest contract do not change. Manifest schemas 2 and 3
accept optional `clock.timeline.exactOffset`; `timelineOffsetMs` is included
only if it is exactly representable and safe. Legacy manifests with only the
millisecond field still validate and re-import through the website. Older
strict manifest readers need an update before reading the new optional field;
this is forward acceptance of old manifests, not backward acceptance of new
fields. See VERSIONING for consumer migration.

## Implementation update, 2026-11-23

The pinned `exact-time` v0.1.3 release now supplies the exact conversions, types,
validators and case table. Frame of Mind delegates stored time fields to those validators.
