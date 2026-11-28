# Changelog

All notable changes to Frame of Mind are documented here. The project follows
Semantic Versioning.

## [Unreleased]

- Analyze one recording with either Gemini or Twelve Labs in either role. Preview the recipients and retention, withhold the claim when needed, and read partial coverage and cleanup receipts in the result. Gemini uses the released first-pass request and reply schema at both depths. Its second-pass request also matches the release when the grader receives the claim. Frame of Mind fills the Gemini proposal fields locally. Twelve Labs still receives typed segment definitions. Named libraries, search and whole-shoot analysis do not exist yet.
- A bound in frames or timecode on a sound-only recording answers the reason released in 0.6.8, `Audio bounds use seconds or Nsamp.`, again. `no-video-stream` is used only where no reason existed before.

- Fixed a v0.6.8 regression that refused sound-only recordings in `analyze`. Voice recordings use native sample positions and produce no stills. A failure before media upload starts reports `phase: "prepare"` and `sent: false`.

- Analyze accepts a verified candidates file, previews proposer and grader roles, and writes each candidate’s provenance and resolved start and exclusive end. Measured cuts and speech snaps identify the tool. Claims keep the finder’s radius. The grader receives the claim and optional surface as fenced data on both routes. Items and failure rows retain the full proposal. The effect of showing the claim was measured on one set of screen recordings. [Engine contract](docs/ENGINE_CONTRACT.md)
- CLI usage refusals carry a reason in `error.details.reason` with `--json`. Refusals that exited 1 in plain mode now exit 2. A range scan that cannot verify the cut returns the fixed reason `Range requires a locally verifiable cut.` and reports measured timing in `error.details.frameTiming`.

- Set `FRAME_OF_MIND_KEY_COMMAND='[]'` to skip the account’s key command for one launch. `doctor` explains the opt-out and includes `key.commandDisabledByEnvironment` in JSON.
- `probe --json`, analysis manifests and transcription receipts report the picture rates measured from packet timestamps, their shares and any odd gaps. A probe that refuses the frame grid includes the report in `error.details.frameTiming`.

## [0.6.8] - 2026-11-28

`analyze` and `transcribe` take a time range, and every time the tool writes is an exact position on the recording's own clock. The speech snap no longer lands inside a word under steady room noise without saying so.

**Which surface writes which version.** The command line and local Studio write `analysis.json` version 4 (meeting) and 5 (video-only) and `analysis-outcome.json` version 2, on every run, ranged or not. Hosted Studio keeps writing analysis 2 and 3 and refuses a 4 or 5 bundle with a plain reason. Local Studio and the importers still read older bundles by their old rule. A reader of run files must accept the new versions before it takes this release.

### Added

- `--from` and `--to` on `analyze` and `transcribe`, on the original recording. The tool cuts the range itself and uploads only the cut. A bound in seconds that is off the frame or sample grid is moved to it and reported in `edgeMoved`; every ranged run prints `Range used:` on standard error. `--remote-file` with a range is refused.
- Exact positions. Items, rejected and failed rows, evidence times, still times, transcript lines and the fragment lists carry an exact bound: a whole count of frames, samples or stream ticks at an exact rate, with its origin (`cut`, `snap` or `model`) and its precision. The whole-second text stays beside it for people. A time a model states becomes the first frame, sample or tick at or after that second, so the printed second is the one the model stated at every frame rate; `support` gives every unit the second touches.
- A whole-file run on a clip whose frame times are not evenly spaced answers in the stream's own ticks (`unit: "tick"`, `ticks`, `tick: {num, den}`). The manifest says why in `sourceTiming`: `uneven` or `unproven`.
- An item belongs to the range its start falls in. Pieces cut by an edge are listed in `startFragments` and `endFragments`, so overlapping ranges can be joined.
- Standard SRT cues use source milliseconds. The optional transcript JSON carries exact spans.
- Each speech snap reports `floorDbfs` and `speechAboveFloorDb`; the run summary gains `counts.noisy`.
- Standalone `snap --other-edge <time>` keeps the search inside the pick, so a remark shorter than a second is not handed a neighbour's edge. `analyze` bounds both edges the same way.

### Changed

- The speech snap uses two levels. Speech is still found 10 dB above the local floor; each edge then follows the quieter head or tail of the word outward to 1.5 dB above it. Clean-sound edges do not move.
- A snap states its clean-sound precision (50 or 200 ms) only on clean sound: speech at least 60 dB above the local floor. With noise under the speech it keeps its time but states `precisionMs: 300` and `noisy: true`, in `times.json` and in the exact bound. On a real recording that is nearly always.
- A failure while preparing a cut, before anything is sent, publishes no run folder. The reply carries the `Source coverage:` line and, with `--json`, `error.details` with `phase: "prepare"` and `sent: false`.

### Known limits

- The snap change is proven on made-up sound only: a synthetic voice and tone bursts over steady noise. It has not been run on a real room recording. Under noise an edge can still sit inside a word, and under noise that moves (traffic, a drifting room tone) it can land up to about 175 ms outside the remark; that is not fixed. Every such result says `noisy` and 300 ms. The flag is a level line and is blunt: no level separated right edges from wrong ones on the benches, so a better rule is the next change.
- A ranged run needs a recording whose picture stream proves one frame per packet in display order. Where it cannot, the run prints `whole-file — <reason>` and reads the whole file; it never guesses.
- Hosted Studio does not accept bundles of the new versions.

## [0.6.7] - 2026-11-28

The provider key can come from a command you name once, so no key sits in a file. A key that is present is used on every launch: the refusal "Credential source unknown" that 0.6.6 gave a job start is gone. The local media commands no longer give up on a long recording because a fixed clock ran out. Everything added is optional on contract version 1.

### Added

- Key command. On macOS and Linux, ordinary commands can get the provider key from a command you choose: `keyCommand` in a per-user settings file (macOS `Library/Application Support/frameofmind/settings.json`, Linux `.config/frameofmind/settings.json`), or `FRAME_OF_MIND_KEY_COMMAND` in the environment the tool is started with. The order of sources is: the environment, the key command, the folder's `.env`. The command is started directly with no shell, in your home folder, with the environment the tool was started with; it has 30 seconds and must print one key and nothing else. A script is allowed. The settings file must be yours, mode 0600, in a directory of mode 0700, and not a link. A command that fails ends the lookup with `Key command unavailable.`; it never falls back to the folder's `.env`. Jobs keep using a key from the environment only. Native Windows does not offer the key command. The README gives the lines that create the file and a macOS keychain recipe.
- `doctor` with a key command: `ok GEMINI_API_KEY (key command, not run by doctor)`, `key.source: "command"`, `key.state: "unverified"`, `key.present: true`, exit 0. `doctor` never runs the command, so `unverified` means set up, not tried. An unsafe settings file or command is `state: "unavailable"`, exit 1, with one line that fixes it. `doctor --json` gains optional `settingsPath`.
- With `--json`, a failed or unavailable key command carries `error.details.reason: "key-command"`, so a caller can tell it from a key the provider refused, which carries no `reason`. Code and exit status are the same for both (`KEY_REFUSED`, 10).
- Local Studio's review export keeps each item's `stillTimes` and `screenTextNotFromStill`. It dropped both before.

### Changed

- A key present in the environment is used on every launch and for every command, a job start included. Under a launcher that merges a folder file before the tool runs (Bun without `--no-env-file`, Node with `--env-file`), 0.6.6 refused a job start with "Credential source unknown. Start with a clean launcher." That refusal is removed. `doctor` there reports the key as present with source `unknown`, exits 0 and prints no next-step line; with no key it exits 1 and prints one next step.
- Under such a launcher no key command runs, from the environment or from the settings file: the folder's file has already written into the environment the command would run in. With no key in the environment there, a command that needs the key answers `Key command unavailable.` when a key command is configured and `KEY_MISSING` when none is. The installed command and the release file are not such launchers.

### Fixed

- `slice`, `proxy`, `probe --decode-check`, `verify` and `--timecode-rate from-media` could fail with "ffprobe timed out" on a long recording when the machine was busy. The frame-timing scan decodes every frame and had a fixed 60-second limit. The limit is now 60 seconds plus half a second per second of recording.
- The decode check and the encode of `slice`, `proxy`, `probe --decode-check` and `verify` had a fixed 600-second limit, so a proxy of a long recording could be cut off by the clock. The limit is now 600 seconds plus two seconds per second of recording.

### Known limits

- Speech snapping under room noise. With `--snap speech`, or the `snap` command, an edge reported as `snapped` can sit inside the first or last word by up to about a third of a second when the recording has steady room noise. Check a snapped edge by ear before cutting on it. Not fixed in this release.
- Node's own debug switches can print the key command's arguments and environment to standard error. They never print the key.

## [0.6.6] - 2026-11-28

Screen text a record quotes is now read from a full-size picture, and a quotation the tool cannot tie to one is removed. The transcript recheck is gone. `doctor` says where the provider key came from. Everything added is optional on contract version 1.

### Added

- Full-size stills. Each detail request of `analyze` and local Studio carries up to three full-size stills of the moment: the midpoint for a moment under 10 seconds, and for longer moments also the frames two seconds inside either end. The model is told to quote screen words only from one labelled still. Each item carries `stillTimes`, the recording times actually sent, even with `--no-screenshots`. When a record cites a still, the saved screenshot is that exact frame. The stills of one request total at most 15 MB once encoded; a still that does not fit is not sent and is never scaled down, and when none fits the record's confidence notes say "Full-size frame unavailable. Treat any quoted screen text as unverified." Job runs and hosted Studio do not send stills.
- A screen quotation is kept only when it was read from an attached still. When an accepted record carries `evidence.verbatimUiText` and cites a time that is not one of its `stillTimes`, `analyze` removes the quotation, sets the new optional item field `screenTextNotFromStill: true` and adds "Screen text was not read from a still." to the record's confidence notes. The record stays accepted, its times do not move and the frame saved at the cited time is kept.
- `doctor` names the source of the provider key and never shows the key: `(process environment)`, the quoted path of the folder's `.env`, `(none)`, or `(unknown: ...)`. The `key` object in `doctor --json` gains optional `source`, `path`, `state` and `lowerSourcesSkipped`. The provider check's `detail` is unchanged. `doctor` ends with one next-step line when the key is missing or its source failed. `key set` prints the absolute path it wrote and says that anyone who can read that folder has the key.

### Changed

- The folder's `.env` is read as data and is no longer merged into the process environment. The order is: the environment the tool was started with, then the folder's `.env`. The two are never compared. Settings you keep in `.env` still apply; no value from it reaches a helper process.
- A launch that had already merged a file before the tool ran (Bun without `--no-env-file`, or Node with `--env-file`) reports the key's source as unknown. Ordinary commands still run there with an inherited key; a job start answers `USAGE` (exit 2) with "Credential source unknown. Start with a clean launcher." The installed command and the release file are not affected. The `dev` and `start` package scripts now pass `--no-env-file`.

### Removed

- The transcript recheck and `transcribe --recheck`. On a real recording, none of the guards evaluated removed every invented line while keeping a confirmed real line. New output omits `outcome`, `rechecks`, `belowCutoff` and the per-line `recovered` mark; files written by 0.6.4 that carry them still import. A machine call passing `--recheck` returns `USAGE` (exit 2). A transcription window whose reply stops early can still leave speech out of a transcript that looks whole: nothing detects or repairs that in this release.

### Not checked

- Screen words inside titles, summaries and other prose. In a record carrying `screenTextNotFromStill`, distrust them. `candidate.summary` in `analysis.json` is the first pass's note, made from a reduced picture; it can carry wrong screen words and must not be quoted.

## [0.6.5] - 2026-11-26

**If you ran `transcribe` or `analyze` on 0.6.4: its transcript recheck could add lines that are not in the recording.** On a real two-hour recording it merged invented speech into near-silent stretches and reported `complete`. In a transcript made with 0.6.4, check every line marked `recovered: true` in the transcript JSON against the recording, or make the transcript again with this release. This release turns the recheck off.

### Changed

- The transcript recheck is off by default. `transcribe` asks the model again about quiet stretches only with the new flag `--recheck`, which is experimental and can add lines that are not in the recording. `analyze` never asks again for the transcript it derives.
- Without `--recheck`, no second request is made and `outcome`, `rechecks`, `belowCutoff`, `recovered` and the recheck notes and warnings are not written. Transcript output is as in 0.6.3, plus the quiet-line mark below. With `--recheck`, behaviour and fields are as in 0.6.4.
- A build that is not a release bundle prints its version with `+source`, for example `0.6.5+source`, in `--version`, `doctor`, the `version` document, run manifests (`toolVersion`), the local MCP server and local Studio. A release file prints the plain version, as before, and so does hosted Studio. A linked checkout runs the files in `dist/`: rebuild after every pull, or it keeps running the old code under the new number.

### Added

- Quiet-line mark. A transcript line whose own span holds no measured sound at all carries `quiet: true` in the transcript JSON. The `transcribe --json` success document and the transcript JSON carry `quietLines`, the number marked, whenever the local sound measure ran. When the number is above zero, `transcribe` prints `note: <n> line(s) sit where no sound was measured.` and `analyze` records the same sentence as a run warning. No request is added. The mark proves nothing: it catches a line written into true silence, and a line invented in a room with any noise is not marked. Optional on contract version 1.

## [0.6.4] - 2026-11-26

A transcription reply can stop early and leave speech out of a transcript that otherwise looks whole. From this release the tool asks again about quiet-looking stretches before the transcript is written. Everything added is optional on contract version 1.

### Added

- Transcript recheck, in `transcribe` and in the transcript `analyze` derives. After the first pass the tool measures sound over the whole first audio track, locally. Each stretch of 20 seconds or more with no transcript line and at least 5 seconds of measured sound is sent to the model again on its own, once. Lines returned inside the stretch are merged; lines already held are never changed, dropped or duplicated. Measured sound only picks the stretches to ask about. It is never reported as missing speech: keys and murmurs measure as sound too.
- Budget for the recheck: one request per first-pass window (at least 3) and at most a quarter of the recording's length in audio, most measured sound first. A stretch longer than a window is asked in pieces of at most 600 seconds. Each re-ask is one more upload and one more model request; its tokens are counted under `transcript`.
- New optional output, in the `transcribe --json` success document, the transcript JSON, and `derivedTranscript` in the `analyze` manifest:
  - `rechecks`: one row per stretch asked about, with `start`, `end`, `measuredSeconds`, `status`, `addedLines` and, when lines were added, `addedSpans`. `status` is `linesAdded`, `noNewLines`, `failed` or `skipped`.
  - `belowCutoff`: `{stretches, seconds}`, the line-free stretches of 20 seconds or more that measured under the cutoff and were not asked about.
  - `outcome` (the `transcribe` success document and the transcript JSON; not the `analyze` manifest): `complete` when there was nothing to ask about or every stretch got a valid reply; `unchecked` when the sound measure could not run, or a re-ask failed or was skipped for budget. `complete` does not mean the recording holds no other words.
  - `recovered: true` on each merged line in the transcript JSON. Its speaker label comes from a separate request and may not match its neighbours.
- New lines on standard error: `note: asking again for <n> stretch(es), <s> s of audio.` before the re-asks; `note: recovered <n> line(s) at <start> to <end> s.` for each recovery; one summary note counting stretches asked about with nothing found; and `warning: <start> to <end> s was not checked again (<reason>); it holds <n> s of measured sound.` for each failed or skipped stretch. When the outcome is `unchecked` the speakers file's header gains one line naming those stretches. The SRT changes only by the recovered cues.
- A warning when a transcription window drops more than 600 characters of text as lead-in.

### Changed

- A re-ask whose reply carries a time past its clip is discarded and that stretch is marked `failed`. The transcript already held is still written and the exit status is 0.
- `analyze` reports recoveries and unchecked stretches as run warnings. Its analysis status does not change. Sources of unknown duration and hosted transcription are not rechecked.

## [0.6.3] - 2026-11-26

Everything added here is optional on contract version 1: a caller that ignores the new fields sees no change.

### Added

- `analyze` and `transcribe` print `retention: provider` or `retention: run` on standard error before any upload, and their `--json` success documents carry `retention`. The default retention does not change; pass `--retention run` to delete uploads when the run ends.
- The transcript JSON written by `transcribe --json` carries `windowStarts`: the first second of the recording each transcription window owns, for example `[0, 600, 1200]` for a 1,500-second recording. The SRT and speakers files are unchanged.
- Token counts. The `analyze` run manifest carries optional `tokenUsage`, with measured counts under `transcript`, `index`, `detail` (including repairs), `calibration` and `other`, each as `promptTokens`, `outputTokens` and `totalTokens`. The `analyze --json` and `transcribe --json` success documents carry `tokens` with the totals. A pass that did not run or reported no usage is absent, never zero. There is no money figure: multiply by your provider's prices. Command line only; manifests written by hosted Studio do not carry `tokenUsage`.
- Error code `RECORDING_TOO_LONG`, exit 4, when a recording is longer than the analysis limit. `error.details` gives `durationSeconds` and `limitSeconds`. A `--json` caller previously received `COMMAND_FAILED` for this.

### Changed

- The default analysis limit is 7260 seconds: two hours with one minute of grace (was 7200). A two-hour recording that measures a fraction of a second over is now accepted. A limit set with `FRAME_OF_MIND_MAX_VIDEO_SECONDS` is still applied exactly.
- The message a person sees for a recording over the limit now gives the length and the limit in seconds and says to split the recording.
- The built-in `issue-review` recipe tells the model to report what is visible when a window disappears, and to give a cause such as closing or crashing only if the recording shows it. The recipe id is unchanged; its revision is `builtin-2026-11-26.1`.

## [0.6.2] - 2026-11-26

### Fixed

- A transcript time outside the audio it was heard in is never written. On a long recording, one window's reply could carry times far past the end of the file (minutes and seconds written in the hours and minutes fields), and they were written as given. Now each window's reply is checked before its times are placed on the recording: every start and end must be at or below the length of that window's audio plus 2 seconds. A reply that fails the check is a failed attempt for that window. `transcribe` asks again once, then fails and writes no files; `analyze` continues without a derived transcript and says so. A bad reply is never clamped, trimmed or reinterpreted.
- When `transcribe` fails for this reason, the existing line `Transcription failed on window N after M attempt(s); no transcript files written.` is unchanged, and a second line on standard error says `A transcript time fell outside audio window N.` Error codes and exit statuses are unchanged.
- A last transcription window shorter than 30 seconds is no longer sent on its own; the window before it runs to the end of the recording. A recording of 7200.6 seconds is now 12 windows, not 13.

### Changed

- Each transcription request now states the length of the audio sent and that no time may pass it.
- Not covered: where the length of the audio is unknown (`analyze` on a source whose duration cannot be read), there is no check.

## [0.6.1] - 2026-11-24

### Added

- `--thinking-level <low|medium|high>` on `analyze` and `analyze start`. When given, every model request of that run carries the level and the run manifest records it as `thinkingLevel`. When omitted, nothing is sent and requests are unchanged. Example: `--model gemini-4-hydrogen --thinking-level medium`.
- Experimental: job commands for `analyze` and `transcribe` (`start`, `status`, `result`, `cancel`, and `analyze dry-run`), all with `--json`. They may change or be removed in a later release.
  - Every start names its own grant: the read and write folders (`--roots-file`, or `--media-root` and `--output-root`), `--max-media-seconds`, `--max-provider-requests`, `--max-file-bytes`, `--allowed-models` and `--retention`. All are required and none is read from the environment.
  - `start` prints the job document at admission and keeps running as the worker; `status`, `result` and `cancel` work from another process and answer from the job record on disk.
  - A lost provider reply is recorded as `outcome_unknown` and the same input starts again only when the caller names that job with `--after-unknown`. A request ID belongs to its `--out` folder.
  - A failed job reports the provider's specific code where one applies. A missing `--out` folder or input file answers `NOT_FOUND` and names the argument in `details.argument`; the `--out` folder must already exist.
  - Job analysis runs without screenshots, clip-clock calibration or the derived transcript.

### Changed

- The default model id is now `gemini-3.8-flash` (was `gemini-3.7-flash`). The provider has deprecated `gemini-3.7-flash` and already routes requests for it to `gemini-3.8-flash`, so the model that answers a default run does not change. Runs that pass `--model` or set `GEMINI_MODEL` are unaffected. New manifests record `gemini-3.8-flash`.

## [0.6.0] - 2026-11-24

First full release of the 0.6 line. The code is the same as `0.6.0-beta.4`; the four pre-release sections below list every change since `0.5.0`. In short:

- A machine contract for the command line, frozen at version 1: `--json` output as one versioned JSON document, one error document, fixed error codes and exit statuses, and JSON Schema files shipped with the release (`docs/MCP_TOOLS.md`).
- Times an editor can cut on: declared clocks and timecode, speech-edge proposals (`snap`, `analyze --snap speech`), and `map`, which traces a time in an exported sequence back to its source file and frame through the timeline export (`docs/EDITING_WORKFLOW.md`).
- Local media commands: `probe`, `verify`, `proxy`, `slice` and `frame`.
- `transcribe`, with subtitle and transcript exports.
- `doctor` reports what each command needs from ffmpeg and lists and removes what a killed run left behind.
- The standalone CLI is published with checksums and third-party notices on each release.
- An experimental local MCP server with four read tools; it runs under Bun only.

## [0.6.0-beta.4] - 2026-11-24

Pre-release.

- Machine contract, frozen at version 1. With `--json`, a command prints exactly one JSON document carrying `schemaVersion`; a failure prints one error document with a fixed `code` and exits with the status listed for that code. `docs/MCP_TOOLS.md` is the contract for the command line and the MCP tools. JSON Schema files for each command's output ship with the release and are listed in `SHA256SUMS`.

- Added `--json` to `analyze` and `transcribe`. `analyze --json` reports the absolute run folder, run id, outcome, accepted count and any retained upload. `transcribe --json` still writes `<stem>.transcript.json` and lists every file it wrote. Text output keeps its wording.

- Added `frameofmind capabilities --json`, `recipes --json` and `--version --json`.

- `snap --json` on an input file that does not exist returns `NOT_FOUND` and exits 20.

- `doctor` reports the ffmpeg and ffprobe versions and what each command needs from them, and a media command refuses up front when a capability it needs is missing. `doctor --scratch` lists what a killed run left behind and `--remove` removes only leftovers the tool can prove it created. `doctor --json` prints one report with a top-level `ok` and exits 0 whenever the report was produced.

- Added `frameofmind map`: from the timeline file (`.otio`) exported with a sequence, find the source file, frame and timecode shown at a sequence time, or every sequence time that shows a source frame. See `docs/EDITING_WORKFLOW.md`.

- Added an experimental local MCP server with four read tools, `frameofmind mcp --database <file>`. It runs under Bun only.

- `failure-manifest.json` gains `errorCode`, the contract's code for that failure. Existing codes inside run files are unchanged.

- Fixed: `report.html` from a default run in `0.6.0-beta.3` had one extra whitespace-only line per record compared with `0.6.0-beta.2`. The earlier bytes are restored.

- Uses `exact-time` 0.1.4, which reads timeline-interchange times.

## [0.6.0-beta.3] - 2026-11-24

Pre-release.

- REST requests, the web app’s public configuration, and local Studio error telemetry now report the version printed by `frameofmind --version`.

- Added `frameofmind snap` for local speech-edge searches and `analyze --snap speech` for measured cut proposals. Outward proposals stay within the speech group containing the request. Targets use a 10 ms grid with about ±50 ms accuracy for source audio at 32 kHz or higher, or ±200 ms for lower or unknown rates. Opted-in analyses write `times.json` schema 3 alongside the original model readings. Default runs continue to write schema 2.

- Concurrent check lanes can now prune the shared build cache while another lane releases a lease or copies a build.

- Added local `probe`, `verify`, `proxy`, `slice` and `frame` commands for measured frame counts, upload preparation, exact cuts and full-resolution frame extraction.

## [0.6.0-beta.2] - 2026-11-23

Pre-release.

- Standalone CLI releases include a checksummed third-party notices file for redistribution. The release job marks pre-release tags automatically and keeps them out of Latest.

- Success and failure manifests now record the tool version printed by `frameofmind --version`.

## [0.6.0-beta.1] - 2026-11-23

Pre-release. First release that publishes the standalone CLI with checksums.

Known limit: `manifest.json` written by `analyze` still records `toolVersion` as `0.3.0`; use `frameofmind --version` or `release.json` for the real version.

- Stored rate and timecode specification refusals now carry the `exact-time` error code and message.

- Adopted `exact-time` v0.1.3 for exact frame, tick and timecode conversions and stored rate and media-clock validation.

- Tagged releases now include a standalone Node CLI, its build commit and tool versions, and SHA-256 checksums.

- Removed the intermittent Better Auth access and Workflows lane steps, composer journey, and duplicate uninvited-sign-in probe. The required Better Auth access and revocation contract remains. The hosted composer journey runs only under Cloudflare Access.

- The CLI no longer infers whether it is the entry point: loading `dist/cli.js` runs the command, so a linked or launched install can no longer exit 0 with no output. A library import opts out by setting the global `Symbol.for("frameofmind.cli.libraryImport")` flag before loading it. The upgrade steps now rebuild the linked checkout and check `frameofmind --help`.

- `analyze --label <text>` records a human label for the run (for example the source title) as optional `label` in manifest schema 2 and 3, uses it as the video-only report heading, and prints it after the run path. It is never sent to the model or telemetry. Roll readers forward before importing labelled bundles.

- Run bundles with screenshots gain `contact-sheet.png`: up to the first 100 moment screenshots tiled in one image, labelled with record number and cited time, listed in the manifest's `artifacts`. The run warns when screenshots are left off the sheet or the sheet cannot be built, and completes either way. Labels are drawn in-process, so ffmpeg builds without `drawtext` work.

- `teaching-points` screenshots prefer a settled frame: ffmpeg samples within one second of the cited time, inside the candidate range, and prefers the steadiest frame over one caught mid-transition. It can miss a low-contrast cut and show the neighbouring shot. Every other recipe keeps the frame at the cited time, unchanged.

- Added the built-in `teaching-points` charter recipe for instructional and explainer videos, with a fixed detail-label vocabulary (Teaching point, Narrator's words, Numbers, Reason given, On screen, Picture says more than words, Maker-specific), accepted and rejected exemplars, and rejection of title cards, branding and calls to subscribe.

- Added exact decimal-to-frame snapping with explicit range edges and round-trip Premiere subtitle milliseconds at video rates up to 1000 fps (ADR 0028).

- Both `transcribe` and `analyze` accept `--transcript-language <tag>` as a spoken-language hint for transcription only. Speech stays in its original language. The speakers header, transcript JSON and derived-transcript manifest provenance record the requested tag when used. On `analyze`, `--note language=<path>` guides analysis prompts only. Live transcription fidelity is untested.

- Transcription now requests the original spoken languages and preserves mid-sentence language switches in its instructions.

- 2026-11-18: Temporarily accept the unpatched picomatch production advisory in CI, with an automatic failure after its 2026-12-18 review deadline; other high and critical advisories still fail.

- 2026-11-17: Store exact times as rational frame counts; add frame/timecode timeline offsets and a language-neutral contract. `times.json` schema 2 preserves model precision without frame/timecode claims and emits exact offsets separately (ADR 0027).

- 2026-11-13: Limit media tools and OAuth browser openers to explicit runtime environment variables so CLI and local Studio credentials stay in the parent process.

- 2026-11-13: Adopted a contributed standalone `transcribe` workflow with private SRT/speaker files, optional source-clock JSON, visible audio retention, one window retry and cue-safe rendering.

- 2026-11-13: Treat contradictory HTTP/JSON provider statuses as other across SDK calls and direct uploads without parsing message text or changing retries.

- 2026-11-13: Classify CLI provider failures as refused, not_found, rate_limited, or other using HTTP status; include optional classification in version 1 failure manifests.

- Run fast/local checks for every pull request; retain the complete hosted lane
  nightly, on demand, and before deployment. Add `check:deploy` and a
  `deploy:hosted` wrapper that runs both gates successfully in the same
  invocation before calling Wrangler; writable receipts cannot authorize deploys.
  Required auth, browser, and fresh-clone CI jobs are unchanged.

- 2026-11-13: Added opt-in parallel detail analysis, adopted from a field contribution, with ordered results and a completion-time breaker spend bound.

- 2026-11-13: Fixed linked CLI execution and package version reporting; added hidden key entry, best-N selection, full indexed coverage with `--max-moments all`, per-run notes, and ffmpeg in the CI check job. The tool's run-note projection
  contains only names, digests and byte counts; model findings may quote or
  paraphrase notes and should be treated as possibly containing note content
  when sharing a bundle.

- 2026-11-13: CLI recording uploads now default to provider expiry, with explicit run cleanup and visible expiry/size limit (ADR 0024).

## [0.5.0] - 2026-09-08

### Added

- Self-serve hosted access requests with clear submission feedback, followed
  by maintainer approval before Studio access (#99).
- A maintainer-only `/admin/access` surface to review requests and approve,
  deny, or revoke membership, with revocation enforced on the next request
  (#109).
- Content-free AI-agent tracing behind a second, explicit telemetry opt-in;
  spans cover analysis phases and report sanitized failure codes without
  recordings, transcripts, prompts, or model output (ADR 0022; #119).

### Fixed

- Refuse local CLI/Studio recordings above the configured duration limit
  before transcription, upload, or run creation; the default is 7,200 seconds
  and `FRAME_OF_MIND_MAX_VIDEO_SECONDS` can override it (commit 374229c;
  landed directly without a pull request). Limit-truncated analyses now report
  `partial`; candidate coverage outcomes
  survive SQLite/D1 projection, Studio views, re-import, and exports instead
  of presenting omitted work as complete (#111).
- Renumbered the run-outcome projection migration to `0012` to avoid the
  access-administration migration collision (#114).
- Corrected hosted light/dark contrast and hydration mismatches across
  sign-in and composer pages (#105, #118).
- Reserve hosted spend for the initial generation chain and extend it
  atomically before transport retries; corrected allowance feedback,
  access-request capacity handling, and local composer replay (#107).
- Bounded hosted access-contract waits and restored CLI SIGINT handler
  compatibility with current Bun types (#116, #108).

### Changed

- Refreshed hosted operations, credentials, deployment, and repository-skill
  guidance; documented truncation and hosted-test lessons (#106, #110, #115).
- Added contribution templates and commit conventions with isolated hook
  self-tests and explicit PR gate base handling (#121, #122).
- Required a secret-free Better Auth/D1 authorization contract in CI and
  installed Chromium in the serial-check job (#123, #100). Updated hosted
  fixtures to use run-relative expiry and current approval copy (direct
  commits 81d0436, d81f467).
- Dependencies: updated `@google/genai` to 2.18.0, Vue to 3.5.41, `jose` to
  6.2.9, and grouped development dependencies (#101, #102, #103, #104). Raised
  the patched `fast-uri` override floor to 3.1.6, resolving 3.1.7, to clear
  high-severity production advisories (direct commit 7a57ad5).

## [0.4.0] - 2026-08-24

### Added

- Hosted Studio went live at the maintainer's reference instance: sign-in with
  GitHub or an email magic link (Better Auth on Workers + D1), browser-direct
  recording upload to Gemini with sealed SHA-256 receipts, capped
  per-principal spend with atomic reservations, durable Workflows-based
  analysis, published results, and codes-only telemetry (ADRs 0017-0019;
  first production analysis completed 2026-08-23).
- Magic-link email delivery through the Cloudflare Email Service binding with
  a fail-closed mailer, per-email cooldown, and per-client-IP rate limiting;
  the HTTP mailer remains a no-binding fallback.
- Retained-media mode: a private, principal-owned R2 copy with visible
  lifecycle, digest-bound multipart uploads with per-part byte reservations,
  and client-canvas evidence provenance.
- A sharded repository gate: `check:sharded` runs the same 16 steps as the
  serial `check` in three concurrent lanes with build-once artifacts and a
  content-hash cache (~5 minutes instead of 75-90), `check:pr` as the PR
  tier, and per-step timeouts.
- Public-repository hygiene detectors for cloud resource identifiers, and a
  scheme-aware light/dark theme with enforced WCAG AA contrast.
- Long recordings now derive a transcript in bounded windows. Audio beyond ten
  minutes is extracted, uploaded, and transcribed one window at a time, each
  window after the first starting fifteen seconds early for boundary context,
  then stitched back onto recording time with overlap segments dropped. A
  single request could not emit a verbatim transcript of a 30-50 minute
  meeting, so derived transcription previously failed outright on every long
  recording (issue #40). Each window's upload is deleted on its own success and
  failure paths, a failed window discards the whole transcript rather than
  publishing one with a silent gap, and an unprobeable duration degrades to the
  previous single-window behavior.
- Added a derived transcript rung to the analyze pipeline. When neither a
  provider nor a context file supplies a transcript, ffmpeg strips the
  recording's first audio stream into a private AAC derivative, the run's own
  model transcribes it into diarized segments with generic speaker labels, and
  the remote audio upload is deleted immediately. The transcript corroborates
  both model passes at zero alignment offset and is never persisted.
- Added `--no-derived-transcript` to opt out of that step.
- Added optional `derivedTranscript` manifest provenance (`origin`, model, and
  SHA-256 of the formatted transcript) to schema 2 and schema 3.
- Added `--remote-file <name>` to reuse a retained Gemini upload for the same
  recording. The run verifies the remote file is `ACTIVE` and, when the
  provider reports a digest, that it matches the local recording's SHA-256; it
  treats the file as operator-owned and never deletes it. A `--keep-upload`
  run now prints the retained file name and its provider expiration for reuse.
- Added the `generation_failed` candidate failure code. A detail-phase
  generation failure (transport error, quota, provider 5xx) is now isolated
  per candidate like validation failures: the run records the failure,
  continues with remaining candidates, and publishes a `partial` outcome
  instead of aborting and discarding validated candidates (issue #41).
- Added bounded transport retry (four retries with exponential backoff capped
  at 16 seconds, on HTTP 429/500/502/503/504) before any generation attempt is
  declared failed. Non-retryable errors, including billing failures, still fail
  immediately. The budget is sized from a live probe that hit two consecutive
  `503 UNAVAILABLE` capacity errors before succeeding; the original two-retry
  linear budget could not outlast that burst and was the real reason derived
  transcription kept failing on long recordings.
- Added a systematic-failure circuit breaker: when the first three selected
  candidates all fail at generation with nothing validated, the run aborts
  with a run-scoped failure instead of spending a provider call per remaining
  candidate.

### Security

- Cleared all nine high-severity production advisories. Nuxt moves 4.5.0 →
  4.5.2, resolving the SSR payload-cache cross-user disclosure, the mixed-case
  route-rule auth bypass, the island OOM and CPU-exhaustion vectors, and the
  island-props RCE. Root `overrides` lift four transitive dependencies onto
  patched releases: `brace-expansion` ≥5.0.9, `fast-uri` ≥3.1.5, `nanoid`
  ≥3.3.18, and `undici` ≥8.10.0 (raising Miniflare's exact 7.28.0 pin, which
  the advisory range covers). `bun audit --production --audit-level=high` now
  exits clean.

### Fixed

- `--remote-file` digest verification now accepts the Files API's live
  `sha256Hash` encoding — base64 of the lowercase hex digest string — in
  addition to the documented raw-bytes base64 and plain hex. The first live
  reuse attempt was rejected because only the documented encodings were
  accepted, making every genuine match fail.
- `doctor` now detects ffmpeg on Windows by probing `ffmpeg.exe`/`.cmd`/`.bat`
  in PATH; previously it only looked for an extensionless `ffmpeg` file and
  always reported ffmpeg missing even though analysis spawns resolved it.

### Changed

- GitHub CI runs the lane-based jobs and is green again; a red required check
  now blocks merges via branch protection.
- Hosted access is invite-gated today; self-serve access requests (ADR 0020)
  are in progress.
- Bumped the prompt revision to `2026-07-28.3`.
- On schema-2 manifests a derived transcript changes the referent of two
  existing fields: `transcriptSha256` records the derived text's digest and
  `transcriptAlignment` is pinned to explicit offset 0; a schema refinement
  enforces both whenever `derivedTranscript` is present. Consumers must check
  `derivedTranscript` before attributing transcript provenance.
- Derived transcription defaults to on for programmatic
  `AnalysisOrchestrator`/`analyzeMeeting` embedders as well as the CLI; pass
  `derivedTranscript: false` to keep prior behavior. `--transcript-offset` is
  ignored (with a warning) when the transcript is derived, because a derived
  transcript is zero-aligned by construction.
- The `doctor` ffmpeg check now reports that it serves screenshots and derived
  transcription; both remain optional and nonfatal.

## [0.3.0] - 2026-07-28

### Added

- Added the reusable local analysis orchestrator, durable single-concurrency
  Studio job runtime, Home dashboard, and bounded local context-file staging.
- Added a versioned schema-v3 video-only run pair, recording-only Gemini
  prompts, and provenance-aware Markdown/HTML rendering while preserving the
  existing meeting-backed v2 contract.
- Added explicit `--source none`, `--depth standard|deep`, `--model`, and the
  `communication-coaching` recipe for intent-versus-impact and missed-cue
  review.
- Added `analysis-outcome.json` and sanitized whole-run
  `failure-manifest.json` receipts.

### Fixed

- Regenerate a locally invalid Gemini structured response at most once using
  sanitized corrective feedback while preserving the unchanged Zod contract.
- Print the pass-2 boundary before detail interrogation and remove empty
  failed-attempt meeting containers after cleanup.
- Repair missing/invalid/schema-invalid detail responses once, normalize only
  zero millisecond suffixes, isolate terminal typed failures per candidate, and
  retain independently validated results.

### Changed

- Updated Cloudflare Workers development types to `5.20260727.1`.
- Studio immutable jobs and SQLite/D1 projections now accept v2 and v3 while
  requiring meeting-provider credentials only for context-enriched runs.
- Documented the current two-pass deep profile and the proposed v4
  claim-evidence/artifact-family and role-based multi-model architecture.

### Planned

- Vertex AI backend with private Cloud Storage media staging
- GitHub issue draft/export workflow
- Context-only recipes for meetings without screen recordings
- Optional local search/index over prior analyses
- Read-only local stdio and Cloudflare Streamable HTTP MCP servers

## [0.2.1] - 2026-07-27

### Fixed

- Replaced the Bun-incompatible `@google/genai` upload wrapper with Google's
  documented two-step resumable Files upload while retaining SDK-backed file
  status, generation, and deletion.
- Derived Gemini's supported response-schema subset from Zod while preserving
  strict local validation as the durable contract authority.
- Added concise output and canonical evidence-timestamp instructions for both
  structured model passes.

### Security

- Stream uploads without placing the Gemini API key in a URL, validate the
  exact signed upload host, reject redirects, use a generic remote display
  name, and sanitize provider and local-validation errors.
- Preserve exact remote cleanup whenever a valid file name is known and report
  ambiguous finalization honestly; no meeting content or provider payload is
  emitted by compatibility checks.

### Testing

- Added adapter contract tests for upload, schema sanitization, local Zod
  enforcement, processing failure, and cleanup retry behavior.
- Added `bun run smoke:gemini`, which generates local media and verifies
  upload, index, detail interrogation, and deletion on the configured model.

## [0.2.0] - 2026-07-26

### Security

- Bound cached OAuth client registrations and bearer tokens to the exact HTTPS
  MCP resource URL; custom Bluedot/Granola endpoints use isolated hashed files.
- Moved the immutable prompt-injection guard into Gemini system instructions.
- Added JSON content-type, Fetch Metadata, and same-origin checks to browser
  imports.
- Sanitized video/context mismatch errors so model output cannot enter logs.
- Added bounded streaming reads for Granola API responses and stronger remote
  Gemini cleanup reporting/retries.
- Added per-operation Gemini HTTP deadlines and a monotonic 30-minute file
  processing budget.

### Changed

- Introduced v2 run contracts: shared run ID, canonical analysis SHA-256,
  recipe content hash/revision, strict `HH:MM:SS` coordinates, and bound
  analysis/manifest validation.
- Added signed transcript offsets and SRT/VTT cue normalization.
- Required evidence timestamps to remain inside their indexed candidate.
- Changed run listing to bounded keyset pagination.
- Changed D1 item projection to byte-bounded transactional JSON expansion
  instead of one statement per item, with explicit row/parameter limits.
- Made Granola's nullable note fields compatible with its public API.
- Released with `@google/genai` 2.13.0 and refreshed Cloudflare development
  types.

### Migration

- The v0.2 review workspace rejects v1 bundles. Re-run the source analysis to
  create a v2 cryptographically paired bundle.

## [0.1.0] - 2026-07-25

### Added

- Bluedot MCP browser OAuth, meeting normalization, and signed-media fallback
- Granola MCP browser OAuth with meeting and transcript tools
- Granola REST API-key transport with explicit selection and scoped note fetch
- Quiet local `.env` loading with a committed secret-free example
- Local JSON/text/Markdown/SRT/VTT context adapter
- Gemini Developer API Files upload with `gemini-3.6-flash`
- Two-pass whole-video indexing and focused moment interrogation
- Automatic and explicit clip-to-transcript alignment
- Built-in `issue-review`, `decisions`, `requirements`, `action-items`, and
  `repo-plan` recipes
- Validated custom JSON recipes
- Versioned `analysis.json` and `manifest.json`
- GitHub-friendly Markdown, self-contained HTML, and screenshots
- Private OS-specific default run storage
- Cleanup of temporary downloads and Gemini uploads
- Scoped `AGENTS.md` plus `CLAUDE.md` compatibility links
- Cross-platform Codex/Claude skill installer
- Bun workspace and text lockfile
- Nuxt 4 SSR + Nuxt UI review workspace
- Explicit validated run-bundle imports
- Local Bun SQLite projection with normalized run/item rows
- Cloudflare Workers build target with D1 adapter and migration
- Cloudflare Access JWT verification with issuer and audience checks
- Local, Cloudflare, and future MCP architecture/runbooks
- Architecture, credentials, recipes, skill installation, versioning, and
  operations documentation
- Deterministic offline test suite and GitHub Actions

### Known limitations

- The current video pipeline requires a Gemini Developer API key; Vertex AI ADC
  is not yet a drop-in backend because Files upload is unavailable there.
- A screen recording is required.
- Granola transcript access can depend on plan/workspace policy.
- Bluedot MCP may not return a recording URL and currently has an observed
  duration output-schema inconsistency.
- Automatic transcript alignment is model-derived and should be overridden for
  deterministic high-stakes clip analysis.
- Hosted imports are manual; there is no automatic local-to-cloud sync.
- The MCP server is an explicitly designed next iteration, not part of v0.1.0.

- 2026-11-13: Added declared clocks, exact optional timeline timecode, synthetic clip-clock calibration, and pre-limit out-of-range candidate filtering (#120).

- 2026-11-13: Clock review fixes retain legacy model alignments with an unverified label, require full frame timing for media-derived rates, and settle upload streams before deleting calibration scratch.

- 2026-11-13: Preserve explicit numeric transcript offsets that cannot be windowed exactly; retain context and label the clock unverified instead of aborting before indexing.
