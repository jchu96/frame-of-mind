# Service Agent Instructions

## Pipeline

- Fetch transcript context before video analysis.
- Index the full recording at low media resolution.
- Interrogate only candidate clips at medium resolution.
- Keep nearby transcript slices corroborative; visible claims require video evidence.
- Capture screenshots only for accepted records and video media.

## Artifacts

- Write `analysis.json`, `analysis.md`, `report.html`, and `manifest.json` together.
- Use private file permissions for meeting artifacts.
- Include SHA-256 provenance, model, timestamps, source class, and remote deletion state.
- Never include signed recording URLs or credential values.

## Cleanup

- Delete downloaded recordings even when analysis fails.
- Delete Gemini uploads by default; `--keep-upload` is the only exception.
- Never delete a local recording supplied by the user.
