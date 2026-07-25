# Adapter Agent Instructions

## Contracts

- Bluedot MCP endpoint defaults to `https://app.bluedothq.com/api/v1/mcp`.
- Granola MCP endpoint defaults to `https://mcp.granola.ai/mcp`.
- Persist OAuth state under the OS user config directory with mode `0600`.
- Discover MCP tool input keys from `inputSchema`; do not hard-code undocumented fields.
- Treat context and media as independent; use local video by default.
- Validate signed Bluedot URLs against the exact HTTPS host and every redirect.
- Normalize Granola absolute transcript times to meeting-relative timestamps.
- Use Gemini Developer API mode; the Files API is not available through Vertex mode here.

## Failure Behavior

- Fail with an actionable fallback: local video, local context, or provider reauthorization.
- Keep provider-specific enums and response normalization inside adapters.
- Redact secret-bearing URLs and payloads from errors.
- Close transports, callback listeners, and remote files in `finally` paths.

## Tests

- Mock network/provider boundaries.
- Test parsing and selection rules separately from live OAuth.
