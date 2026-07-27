# Key Facts

- The canonical Bluedot MCP endpoint is `https://app.bluedothq.com/api/v1/mcp`.
- The canonical Granola MCP endpoint is `https://mcp.granola.ai/mcp`; it uses browser OAuth and Streamable HTTP.
- Granola MCP advertises `get_meetings` and paid-plan `get_meeting_transcript` tools.
- Granola also documents `GET https://public-api.granola.ai/v1/notes/{note_id}?include=transcript` for API-key automation.
- Frame of Mind exposes Granola REST only through explicit `--granola-transport api`; MCP remains the default.
- As verified on 2026-07-27, the repository and npm latest both use the
  official `@google/genai` 2.13.0 package; the analyzer defaults to
  `gemini-3.6-flash`.
- Version 0.2.1 uses Google's documented two-step resumable Files upload
  protocol under Bun and retains `@google/genai` for polling, stable
  `generateContent`, and deletion.
- The production adapter derives an allowlisted Gemini schema from Zod and
  always applies the complete originating Zod schema locally. The provider
  subset never becomes the durable contract.
- Google's current Interactions API uses top-level `response_format` and
  remains Beta. Frame of Mind intentionally retains stable `generateContent`
  for production generation until a later architecture decision changes it.
- The repository vendors Google's official `gemini-api-dev` and
  `gemini-interactions-api` skills at upstream commit
  `47d75caf3bfce63d83ea2c7ed9618d82bff06335`.
- `bun run smoke:gemini` uses generated video to verify production upload,
  index, detail interrogation, and exact deletion without printing payloads or
  remote identifiers.
- Topic-scoped work uses timestamped transcript evidence to select bounded
  operator-owned media derivatives. Semantic scope includes all relevant
  speakers and distinguishes direct request, collaborative clarification, and
  analyst inference.
- The validated two-window run retained nine timestamped screenshots generated
  by the shipped ffmpeg-backed screenshot extractor.
- Each clip's current index request still transfers the full normalized
  transcript unless the operator uses a bounded local context file.
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
- The accepted Studio Phase A direction uses an authenticated local Bun process
  with concurrency one; hosted execution is a separate Phase B track.
- Studio media sessions, analysis jobs, and durable runs have separate
  lifecycles and authority boundaries.
- New Studio API keys are environment- or process-session-scoped; Phase A adds
  no plaintext API-key store.
- Local Studio media uses server-advertised fixed-size parts, exact
  `Upload-Offset` receipts, streamed SHA-256/MIME verification, and private
  per-user application-data storage outside the checkout.
- The local Nitro plugin reconciles interrupted media writes, seals, expiry,
  and retryable cleanup at startup, then performs a non-overlapping expiry
  sweep once per minute until Nitro closes; Cloudflare builds exclude the
  entire implementation.
- Periodic expiry skips sessions owned by an active writer, revisits them on
  the next sweep, and automatically retries durable `cleanup_failed` receipts.
- The local Recording page keeps the selected `File` component-local, stores
  only an opaque media ID in session storage, and verifies a complete
  bounded-part fingerprint before a refresh-resume sends missing parts.
- Ephemeral and retained media both carry a server-owned expiry; the seal and
  delete paths share per-session writer exclusion.
