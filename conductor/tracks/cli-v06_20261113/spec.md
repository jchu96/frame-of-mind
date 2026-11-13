# Specification: Command-Line Tool v0.6.0

**Track ID:** `cli-v06_20261113`

The detailed lane specifications are not yet in the repository. This page
summarises them and is updated with them.

## Lanes in priority order

| Order | Lane | What a user gets |
| ----- | ---- | ---------------- |
| 1 | Declared clocks | Every time the tool writes is labelled with its clock (source file, reel or timeline), and conversions between clocks are named. Model times keep their real precision (whole seconds). |
| 2 | Word-accurate times | Opt-in snapping of each record's start and end to the nearest speech edge in the audio, to 10 ms, reporting how far each edge moved or that it could not snap. |
| 3 | Ask again without uploading again | Part A: upload retention becomes an operator setting (wave 0). Part B: a kept upload is reused for a revised recipe and for follow-up questions, with its provider expiry shown. |
| 4 | ffmpeg helpers | Local `probe`, proxy with a size warning, exact `slice`, joining clips into a reel with a map back to source, frame grab, and `verify`. No network calls; inputs are never modified. |
| 5 | Transcribe and its formats | A `transcribe` command that writes a caption file and a speaker file for use as `analyze` context, and never prints transcript text. |
| 6 | Parallel detail pass | A bounded number of detail requests at once, with output identical to a sequential run. |
| 7 | Small fixes | `--version` through a linked install, hidden key entry, the most important N candidates instead of the first N, per-run notes. |
| last | Local MCP server | The command-line tool reachable as a local MCP server. |

Lanes 6 and 7 and Part A of lane 3 are built in wave 0 because they change no
time value and clear the files the feature lanes share.

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

## Open decisions

- The local MCP server needs an ADR first: `docs/MCP_ROADMAP.md` excludes
  analysis, upload and raw-transcript tools from the first MCP release.
- Every time the tool computes or stores is seconds to the millisecond,
  labelled with its clock; a timeline clock is a declared offset in seconds
  (owner ruling, 2026-11-13). Whether exact timecode at a declared frame rate
  is offered as an opt-in output rendering awaits the owner's confirmation.
- Word-level alignment inside continuous speech would need a new dependency;
  until it is decided, such edges are reported as not snapped.
