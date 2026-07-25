# ADR 0001: Keep the analysis pipeline local-first

Status: Accepted

## Invariant

Meeting analysis must remain authorized, inspectable, reproducible, and easy to
delete. A convenience layer must not become an ungoverned archive.

## Decision

`frameofmind` is a CLI, not a hosted archive:

1. Bluedot MCP, Granola MCP, or a local file supplies authorized context.
2. A recording is resolved from MCP output, an explicit signed URL, or a local file.
3. The recording is downloaded to a private temporary directory when necessary.
4. The Gemini Developer API Files service holds it only for the analysis run by
   default.
5. `gemini-3.6-flash` runs a low-resolution whole-video index, then
   medium-resolution clipped interrogations.
6. Versioned JSON, Markdown, HTML, screenshots, and provenance are written locally.
7. The temporary recording and Gemini file are deleted.

The CLI does not duplicate provider search, transcript storage, permissions, or
workspace membership. Live Bluedot contract verification on July 25, 2026 confirmed
`get_meeting(videoId)` returns timestamped transcription and summary data but no
recording URL. A local Bluedot UI download is therefore the verified recording
path; MCP media discovery remains a forward-compatible adapter seam.

## Consequences

- The selected provider remains the meeting-context system of record.
- Analysis run directories can be attached to authorized work items or deleted without database work.
- Signed recording URLs are short-lived inputs and are never written to manifests.
- A meeting can be rerun from its Bluedot ID plus credentials.
- The MCP media field remains an integration seam because Bluedot documents
  `get_meeting` but not a stable download-field contract. `--video` and
  `--recording-url` are explicit escape hatches.
