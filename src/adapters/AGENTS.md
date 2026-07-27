# Adapter Agent Instructions

## Contracts

- Bluedot MCP endpoint defaults to `https://app.bluedothq.com/api/v1/mcp`.
- Granola MCP endpoint defaults to `https://mcp.granola.ai/mcp`.
- Persist OAuth state under the OS user config directory with mode `0600`.
- Discover MCP tool input keys from `inputSchema`; do not hard-code undocumented fields.
- Treat context and media as independent; use local video by default.
- Preserve Bluedot transcript ownership as `[time] speakerTag: following text`;
  never attach a segment to the preceding speaker.
- Preserve the raw speaker tag even when diarization appears wrong. Any derived
  correction must use audio/video plus adjacent-turn evidence and remain
  explicit.
- Validate signed Bluedot URLs against the exact HTTPS host and every redirect.
- Normalize Granola absolute transcript times to meeting-relative timestamps.
- Use Gemini Developer API mode; the Files API is not available through Vertex mode here.
- Read the vendored official Google Gemini skills and their required hosted
  task documentation before changing Files, video, or structured-output code.
- Direct resumable upload is the shipped v0.2.1 transport. Keep it isolated,
  typed, streaming, redirect-disabled, exact-host validated, and
  cleanup-equivalent.
- Treat Interactions `response_format` as a verified Beta diagnostic path, not
  shipped behavior. A production migration requires a separate decision and
  the same upload, generation, validation, timeout, and cleanup guarantees.
- Decode every model response as `unknown` and validate with the stricter
  originating Zod contract, even when the provider accepted its schema subset.
- A structured-output repair may regenerate the complete response once; its
  added corrective feedback may contain sanitized issue paths/codes only.
  Never echo rejected values, retry more than once, coerce output, or weaken
  the originating Zod contract.

## Failure Behavior

- Fail with an actionable fallback: local video, local context, or provider reauthorization.
- Keep provider-specific enums and response normalization inside adapters.
- Redact secret-bearing URLs and payloads from errors.
- Close transports, callback listeners, and remote files in `finally` paths.

## Tests

- Mock network/provider boundaries.
- Test parsing and selection rules separately from live OAuth.
