# Key Facts

- The canonical Bluedot MCP endpoint is `https://app.bluedothq.com/api/v1/mcp`.
- The canonical Granola MCP endpoint is `https://mcp.granola.ai/mcp`; it uses browser OAuth and Streamable HTTP.
- Granola MCP advertises `get_meetings` and paid-plan `get_meeting_transcript` tools.
- Granola also documents `GET https://public-api.granola.ai/v1/notes/{note_id}?include=transcript` for API-key automation.
- Frame of Mind exposes Granola REST only through explicit `--granola-transport api`; MCP remains the default.
- The analyzer uses the official `@google/genai` SDK and defaults to `gemini-3.6-flash`.
- The analysis contract is `analysis.json`; execution provenance is `manifest.json`; Markdown and self-contained HTML are renderings.
- Full provider payloads and full transcripts are processed in memory but are not persisted in a normal run.
- Local output files and provider token files are created with user-only permissions where the platform supports POSIX modes.
- Embeddings are intentionally absent from the initial release; structured analyses remain useful without a vector service.
- The Nuxt review workspace stores only validated run contracts in SQLite/D1;
  it does not store recording or screenshot bytes.
- The Cloudflare target uses Nitro's `cloudflare` preset, Workers Assets, a D1
  binding named `DB`, and Cloudflare Access JWT validation.
- Schema v2 binds `analysis.json` to `manifest.json` with a shared run ID and
  canonical analysis SHA-256; import and hydration fail closed on divergence.
- MCP OAuth credentials are bound to the exact HTTPS resource URL, and custom
  endpoints use isolated origin-hashed token files.
- D1 item import uses transactional `json_each` expansion; list APIs use
  bounded keyset pagination and summary-only selects.
