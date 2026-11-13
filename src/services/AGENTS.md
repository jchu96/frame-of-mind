# Service Agent Instructions

## Pipeline

- Keep CLI and Studio execution behind the same `AnalysisOrchestrator`; do not
  shell out to the CLI or parse terminal output.
- Emit typed, content-safe progress events. Recording names, transcript text,
  provider payloads, URLs, and credentials do not belong in durable job events.
- Check cancellation between provider/model/render boundaries, but retain an
  exact Gemini file identity long enough to attempt cleanup.
- Fetch transcript context before video analysis. Resolve transcripts through
  the ladder: provider, operator context file, derived from recording audio,
  none. Derive only when the effective transcript is empty and the operator
  has not opted out; the stage is nonfatal and never fabricates meeting
  context (ADR 0015).
- A derived transcript aligns at offset 0 by construction; record
  `derivedTranscript` provenance in the manifest and never persist the
  transcript body in a run bundle. The standalone `transcribe` command may
  write the body only at operator-selected paths outside a run bundle (ADR 0025).
  Analyze deletes remote derived-audio uploads in success and failure paths;
  standalone `transcribe` audio uploads follow operator retention, default
  provider expiry, with immediate visibility. Local `.aac` derivatives are
  removed on every terminal path.
- CLI provider authorization may be interactive; durable Studio jobs must set
  noninteractive provider auth and fail with reconnect guidance instead of
  opening an OAuth callback from the worker.
- When the user scopes a topic or speaker, use timestamped transcript evidence
  to prepare the smallest useful local clip before any Gemini upload. The
  current CLI does not auto-cut source media; this remains an operator step.
- Include the full relevant conversational turn, including collaborators who
  clarify, correct, or complete the request.
- Index the entire operator-selected clip at low media resolution; “entire”
  never expands beyond the requested source window.
- Interrogate only candidate clips at medium resolution.
- Keep nearby transcript slices corroborative; visible claims require video evidence.
- Capture screenshots only for accepted records and video media. The shipped
  extractor invokes `ffmpeg`; screenshot failure remains nonfatal.

## Artifacts

- Write `analysis.json`, `analysis-outcome.json`, `analysis.md`, `report.html`,
  and `manifest.json` together.
- Isolate only typed model-response failures per detail candidate. Keep
  schema-valid rejected records, distinguish them from failures, and record
  indexed candidates omitted by the configured limit.
- Publish only a sanitized `failure-manifest.json` when a whole run fails after
  remote upload. Never persist exception messages or provider payloads.
- Publish the validated staging directory atomically before optional projection.
- Treat projection failure as a warning; the durable run remains successful.
- Use private file permissions for meeting artifacts.
- Include SHA-256 provenance, model, timestamps, source class, and remote
  deletion state. Failure cleanup uses an explicit confirmed/retained/unconfirmed
  state.
- Never include signed recording URLs or credential values.

## Cleanup

- Delete downloaded recordings even when analysis fails.
- CLI recording uploads follow resolved retention: `provider` by default, `run` deletes on success and failure; `--keep-upload` and `--delete-upload` are aliases. Show provider expiry (or unknown) and the 2 GB limit. Studio callers keep their explicit cleanup policy (ADR 0024).
- Never delete a local recording supplied by the user.
