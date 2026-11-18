# Specification: Command-Line Tool v0.6.0

**Track ID:** `cli-v06_20261113`

The detailed lane specifications are not yet in the repository. This page
summarises them and is updated with them.

## Lanes in priority order

| Order | Lane | What a user gets |
| ----- | ---- | ---------------- |
| 1 | Declared clocks | Every time the tool writes is labelled with its clock (source file, reel or timeline), and conversions between clocks are named. Model times keep their real precision (whole seconds). Optional exact timecode at a declared frame rate. Clip runs stop spending calls on candidates past the end of the video (issue #120). |
| 2 | Word-accurate times | Opt-in snapping of each record's start and end to the nearest speech edge in the audio, to 10 ms, reporting how far each edge moved or that it could not snap. |
| 3 | Ask again without uploading again | Part A: upload retention becomes an operator setting (wave 0). Part B: a kept upload is reused for a revised recipe and for follow-up questions, with its provider expiry shown. |
| 4 | ffmpeg helpers | Local `probe`, proxy with a size warning, exact `slice`, joining clips into a reel with a map back to source, frame grab, and `verify`. No network calls; inputs are never modified. |
| 5 | Transcribe and its formats | A `transcribe` command that writes an SRT context transcript (not subtitles) and a speaker file for use as `analyze` context, and never prints transcript text. |
| 6 | Parallel detail pass | A bounded number of detail requests at once, with output identical to a sequential run. |
| 7 | Small fixes | `--version` through a linked install, hidden key entry, the most important N candidates instead of the first N, per-run notes. |
| last | Local MCP server | The command-line tool reachable as a local MCP server. |

Lanes 6 and 7 and Part A of lane 3 were built in wave 0 (PR #147) because
they change no time value and clear the files the feature lanes share.

## Non-goals

The tool does not choose, order or trim the cut; write the final subtitle
file; read burned-in timecode; judge sharpness, colour or loudness; give
pixel-exact reframing positions; drive an editing application or change a
timeline; sync, level or master audio; detect beats; replace a dense local
frame scan; or delete anything by default.

## Deferred beyond v0.6.0

Typed output fields declared by a recipe (a change to the `analysis.json`
contract), clip boundaries as input with a count check, building a proxy from
an editing project, quality-control checks, repeatable labels across takes,
scoring a run against a finished cut, off-camera speech detection, a
long-recording split-and-merge path, and a cost estimate.

## Candidate, not scheduled: cut rhythm

A read-only measure of picture pacing for a draft or finished cut, so that a
note such as "make it pacier" can be compared with a cut the editor names as
the reference. It reports and never changes the cut. It gives no verdict on
taste.

- **Input.** A cut list exported from the editing application, with its
  sequence rate. The tool reads none today, so the first step is one reader
  for one format that carries more than one video track. A rendered file
  alone gives only approximate cuts through ffmpeg scene scores (lane 4). It
  cannot tell the speaker from a cutaway, so that path is a later fallback,
  labelled approximate.
- **Output.**
  - Shot count.
  - Shot lengths as a distribution: median, median absolute deviation and
    percentiles, rather than a mean.
  - The shortest and longest shots with their positions.
  - A rolling median across the cut.
  - Uncovered and covered speaker time, where the tracks say which is which.
  - With a reference cut, the same figures side by side, with no verdict
    words.

  Times are whole frames in the sequence's timecode with the rate named,
  through the exact time module (ADR 0027).
- **Cost.** No model call, no upload, and no new dependency for a text
  format. One reader, the statistics and one renderer: about one builder
  pass and one review.
- **Falsifier, checked before it ships.** Take pairs of cuts an editor has
  already ranked by pace. If the measure orders them differently, it is not
  a pacing measure. Known blind spots:
  - the same lengths in another order;
  - pace carried by motion or speech rate inside a shot;
  - sound-led edits.
- **Fit.** After lane 4's `probe`, built on the exact time module, and
  outside the v0.6.0 waves unless the owner moves it in. Open decision: which
  cut-list format comes first.

## Open decisions

- The local MCP server needs an ADR first: `docs/MCP_ROADMAP.md` excludes
  analysis, upload and raw-transcript tools from the first MCP release.
- Settled 2026-11-13: every time the tool computes or stores is seconds to
  the millisecond, labelled with its clock; a timeline clock is a declared
  offset in seconds. Exact timecode is an opt-in output rendering at a rate
  the caller gives or the media reports, never assumed; fractional rates are
  exact or refused.
- Word-level alignment inside continuous speech would need a new dependency;
  until it is decided, such edges are reported as not snapped.
