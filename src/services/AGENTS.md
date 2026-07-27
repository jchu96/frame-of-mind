# Service Agent Instructions

## Pipeline

- Keep CLI and Studio execution behind the same `AnalysisOrchestrator`; do not
  shell out to the CLI or parse terminal output.
- Emit typed, content-safe progress events. Recording names, transcript text,
  provider payloads, URLs, and credentials do not belong in durable job events.
- Check cancellation between provider/model/render boundaries, but retain an
  exact Gemini file identity long enough to attempt cleanup.
- Fetch transcript context before video analysis.
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

- Write `analysis.json`, `analysis.md`, `report.html`, and `manifest.json` together.
- Publish the validated staging directory atomically before optional projection.
- Treat projection failure as a warning; the durable run remains successful.
- Use private file permissions for meeting artifacts.
- Include SHA-256 provenance, model, timestamps, source class, and remote deletion state.
- Never include signed recording URLs or credential values.

## Cleanup

- Delete downloaded recordings even when analysis fails.
- Delete Gemini uploads by default; `--keep-upload` is the only exception.
- Never delete a local recording supplied by the user.
