# ADR 0025: Standalone transcript files

- Status: Accepted
- Date: 2026-11-13
- Amends: ADR 0015 decision 4 and the standalone-command scope of decisions 6–7;
  ADR 0024's derived-audio exception remains in force for analyze.

## Invariant

Full transcript content reaches disk only at paths the operator's explicit
`transcribe` command selects, outside every run bundle. Each audio upload has
visible retention, and the input recording remains operator-owned.

## Decision

Adopt the contributed standalone workflow as `frameofmind transcribe`. It writes
`<stem>.srt` and `<stem>_speakers.txt`, plus `<stem>.transcript.json` only with
`--json`. Outputs default beside the input; `-o` selects another directory.
Analysis bundles, manifests and analyze's transcript ladder remain unchanged.
There is no analyze export flag.

Files carry full speech content and are private: mode `0600` before content is
written, newly created output directories requested with `0700`, and OS disk
encryption controlled by the operator. The operator owns local retention;
exports are not automatically expired or removed. Never commit these files or
attach them to issues. An existing target requires `--force`; publication is
atomic per file, not over the whole output set. No transcript body is printed.

Standalone transcription audio uploads follow explicit retention flags, then
`FRAME_OF_MIND_UPLOAD_RETENTION`, then `provider`. Provider mode keeps every
returned upload and immediately reports its name and expiry, or unknown expiry,
before attempting transcription. Run mode attempts deletion on every terminal
path, including each retry; failure is reported as unconfirmed. Unsuccessful
upload processing retains the adapter's cleanup guarantee. Analyze's derived
audio continues to be deleted on success and failure. Both commands remove
local audio derivatives; neither deletes an operator-supplied recording.

Transcription uses the shipped extraction, window constants, Gemini prompt and
schema, offset and merge helpers. A window gets one retry after 20 seconds;
a second failure produces no exports. Cancellation stops after the current
window and prevents publication.

Times use the recording's source clock and are reference-grade whole seconds.
SRT uses its required millisecond notation; speaker lines use whole-second
bracketed times; JSON uses numeric seconds. SRT flattens newlines, neutralises
arrows, skips/counts blank cues and adjusts nonpositive durations. The context
reader intentionally strips markup-like spans; literal fidelity lives in the
speaker text and JSON. The speaker header and JSON state origin, model, clock
and timing grade; the command labels the SRT path's clock.

## Consequences

An operator can transcribe once and reuse context across recipes. Explicit
exports introduce local speech retention beyond the run, and default remote
audio retention lasts until provider expiry. Private permissions, OS encryption,
visible upload state and deliberate output paths make those decisions explicit.
The original adopted script remains private and is not shipped.
