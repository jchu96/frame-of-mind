# Bugs and Failure History

## 2026-07-25 — Bluedot tool output rejects its own duration value

- Symptom: the MCP SDK's high-level `callTool` path rejects `get_meeting` even though the tool returned meeting data.
- Cause: the server advertised a per-tool output schema whose duration format did not accept the ISO-8601 duration returned by the live endpoint.
- Workaround: call `tools/call` through `client.request` and validate the MCP envelope with `CallToolResultSchema`.
- Prevention: keep an offline contract test and retry the high-level path only after the provider schema is verified fixed.

## 2026-07-25 — Bluedot context had no recording URL

- Symptom: `get_meeting` returned metadata, summary, and transcript but no downloadable media field.
- Impact: analysis cannot assume the context provider is also a media provider.
- Prevention: require `--video` as the normal path and treat signed Bluedot URLs as an explicitly validated fallback.

## 2026-07-25 — Short clip received the wrong transcript window

- Symptom: an 8:54 clip from the middle of a longer meeting was paired with transcript lines from meeting time zero.
- Cause: candidate video timestamps were used directly against a full-meeting transcript.
- Fix: model and manifest a transcript offset, support `--transcript-offset`, and apply it before slicing nearby transcript evidence.
- Prevention: test non-zero clip alignment and retain alignment method, confidence, and rationale in `manifest.json`.

## 2026-07-25 — Gemini returned 429 before analysis

- Symptom: valid API keys failed with resource-exhausted or prepaid-credit messages.
- Cause: provider billing/quota, not authentication or media format.
- Prevention: distinguish missing credentials, invalid credentials, quota, and billing in troubleshooting; do not keep retrying a billing failure.

## 2026-07-25 — Quoted dotenv extraction produced an invalid key

- Symptom: a key copied with surrounding shell quotes failed authentication.
- Cause: ad hoc shell parsing treated dotenv syntax as the secret value.
- Prevention: use a dotenv-aware loader or export the value through the shell; never document `grep | cut` credential extraction.
