# CLI output notes (v0.6.2 to v0.6.7)

Load this reference before reading `transcribe` or `analyze` output, or when a
run stops with a code you do not recognise. Everything here is optional on
contract version 1 unless it says otherwise. `CHANGELOG.md` holds the full text.

## Before a run

- **Length limit.** `analyze` accepts a recording of at most 7260 seconds (two
  hours and one minute of grace). A longer one stops with `RECORDING_TOO_LONG`,
  exit 4; `error.details` gives `durationSeconds` and `limitSeconds`. Cut a
  part first (see "Part of a recording today" in `SKILL.md`).
- **Retention line.** `analyze` and `transcribe` print `retention: provider` or
  `retention: run` on standard error before any upload, and the `--json`
  success document carries `retention`. Report it; do not change it unasked.
- **Key source.** `frameofmind doctor` names where the provider key came from
  and never shows it: `(process environment)`, the quoted path of a folder
  `.env`, `(none)`, or `(unknown: ...)` when the launch had already merged a
  file. Jobs can use that key. Doctor prints no next step when the key is present.
  If a reader is configured and the key is missing, the CLI reports `KEY_REFUSED`
  because the reader would inherit the merged environment. Use the installed Node command.
- **Two kinds of `KEY_REFUSED`.** With `--json`, a failed or unavailable key
  command carries `error.details.reason: "key-command"`. A key the provider
  refused carries no `reason`. Code and exit status (10) are the same.
- **Source builds.** A build that is not a release file prints its version with
  `+source`, for example `0.6.7+source`, in `--version`, `doctor`, the manifest
  `toolVersion` and the local MCP server. A linked checkout runs `dist/`:
  rebuild after every pull, or it runs old code under the new number.

## Transcripts

- **Window time check.** Each transcription window's reply is checked: every
  time must lie within that window's audio plus 2 seconds. A reply that fails
  is asked again once. If it fails again, `transcribe` writes no files and
  prints `Transcription failed on window N after M attempt(s); no transcript
  files written.` and a second line, `A transcript time fell outside audio
  window N.` `analyze` continues without a derived transcript and says so.
- **`windowStarts`.** The transcript JSON lists the first second each window
  owns, for example `[0, 600, 1200]`.
- **Speaker labels** are generic and given per window. The same label in two
  windows need not be the same person. Do not join speakers across a window
  start without listening.
- **Quiet lines.** A line whose own span holds no measured sound carries
  `quiet: true`; `quietLines` counts them, and a note says `<n> line(s) sit
  where no sound was measured.` The mark proves nothing either way: it catches
  a line written into true silence, and a line invented over any room noise is
  not marked. An unmarked line is not thereby real.
- **No recheck.** The tool does not ask the model again about quiet stretches.
  `--recheck` is gone (`USAGE`, exit 2) and new output has no `outcome`,
  `rechecks`, `belowCutoff` or `recovered`. In a transcript made with 0.6.4,
  check every line marked `recovered: true` against the recording.
- **Known gap.** A window's reply can stop early and leave speech out of a
  transcript that looks whole. Nothing detects or repairs this today. Say so
  when a transcript is used as the record of what was said.

## Analysis

- **Token counts.** The manifest carries `tokenUsage` per pass (`transcript`,
  `index`, `detail`, `calibration`, `other`), each with `promptTokens`,
  `outputTokens` and `totalTokens`; `--json` success documents carry `tokens`.
  A pass that did not run is absent, never zero. There is no money figure.
- **Full-size stills.** Each detail request carries up to three full-size
  stills of the moment. Each item's `stillTimes` lists the recording times
  actually sent. The model is told to quote screen text only from one labelled
  still, and when its citation matches a still the saved screenshot is that
  exact frame.
- **A quotation that cites no still is removed.** When an accepted record's
  `evidence.verbatimUiText` cites a time that is not in its `stillTimes`, the
  tool removes it, sets `screenTextNotFromStill: true` on the item and adds
  "Screen text was not read from a still." to the confidence notes. The record,
  its times and its saved frame stay.
- **What that does not prove.** Screen words inside titles and prose are not
  checked: in a record carrying that field, distrust them. Never quote
  `candidate.summary`; it is the first pass's note from a reduced picture.
- **Size limit.** The stills of one request total at most 15 MB; a still that
  does not fit is not sent, and when none fits the item's confidence notes say
  the full-size frame was unavailable.
