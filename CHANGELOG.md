# Changelog

All notable changes to Frame of Mind are documented here. The project follows
Semantic Versioning.

## [Unreleased]

## [0.3.0] - 2026-07-28

### Added

- Added the reusable local analysis orchestrator, durable single-concurrency
  Studio job runtime, Home dashboard, and bounded local context-file staging.
- Added a versioned schema-v3 video-only run pair, recording-only Gemini
  prompts, and provenance-aware Markdown/HTML rendering while preserving the
  existing meeting-backed v2 contract.
- Added explicit `--source none`, `--depth standard|deep`, `--model`, and the
  `communication-coaching` recipe for intent-versus-impact and missed-cue
  review.
- Added `analysis-outcome.json` and sanitized whole-run
  `failure-manifest.json` receipts.

### Fixed

- Regenerate a locally invalid Gemini structured response at most once using
  sanitized corrective feedback while preserving the unchanged Zod contract.
- Print the pass-2 boundary before detail interrogation and remove empty
  failed-attempt meeting containers after cleanup.
- Repair missing/invalid/schema-invalid detail responses once, normalize only
  zero millisecond suffixes, isolate terminal typed failures per candidate, and
  retain independently validated results.

### Changed

- Updated Cloudflare Workers development types to `5.20260727.1`.
- Studio immutable jobs and SQLite/D1 projections now accept v2 and v3 while
  requiring meeting-provider credentials only for context-enriched runs.
- Documented the current two-pass deep profile and the proposed v4
  claim-evidence/artifact-family and role-based multi-model architecture.

### Planned

- Vertex AI backend with private Cloud Storage media staging
- GitHub issue draft/export workflow
- Context-only recipes for meetings without screen recordings
- Optional local search/index over prior analyses
- Read-only local stdio and Cloudflare Streamable HTTP MCP servers

## [0.2.1] - 2026-07-27

### Fixed

- Replaced the Bun-incompatible `@google/genai` upload wrapper with Google's
  documented two-step resumable Files upload while retaining SDK-backed file
  status, generation, and deletion.
- Derived Gemini's supported response-schema subset from Zod while preserving
  strict local validation as the durable contract authority.
- Added concise output and canonical evidence-timestamp instructions for both
  structured model passes.

### Security

- Stream uploads without placing the Gemini API key in a URL, validate the
  exact signed upload host, reject redirects, use a generic remote display
  name, and sanitize provider and local-validation errors.
- Preserve exact remote cleanup whenever a valid file name is known and report
  ambiguous finalization honestly; no meeting content or provider payload is
  emitted by compatibility checks.

### Testing

- Added adapter contract tests for upload, schema sanitization, local Zod
  enforcement, processing failure, and cleanup retry behavior.
- Added `bun run smoke:gemini`, which generates local media and verifies
  upload, index, detail interrogation, and deletion on the configured model.

## [0.2.0] - 2026-07-26

### Security

- Bound cached OAuth client registrations and bearer tokens to the exact HTTPS
  MCP resource URL; custom Bluedot/Granola endpoints use isolated hashed files.
- Moved the immutable prompt-injection guard into Gemini system instructions.
- Added JSON content-type, Fetch Metadata, and same-origin checks to browser
  imports.
- Sanitized video/context mismatch errors so model output cannot enter logs.
- Added bounded streaming reads for Granola API responses and stronger remote
  Gemini cleanup reporting/retries.
- Added per-operation Gemini HTTP deadlines and a monotonic 30-minute file
  processing budget.

### Changed

- Introduced v2 run contracts: shared run ID, canonical analysis SHA-256,
  recipe content hash/revision, strict `HH:MM:SS` coordinates, and bound
  analysis/manifest validation.
- Added signed transcript offsets and SRT/VTT cue normalization.
- Required evidence timestamps to remain inside their indexed candidate.
- Changed run listing to bounded keyset pagination.
- Changed D1 item projection to byte-bounded transactional JSON expansion
  instead of one statement per item, with explicit row/parameter limits.
- Made Granola's nullable note fields compatible with its public API.
- Released with `@google/genai` 2.13.0 and refreshed Cloudflare development
  types.

### Migration

- The v0.2 review workspace rejects v1 bundles. Re-run the source analysis to
  create a v2 cryptographically paired bundle.

## [0.1.0] - 2026-07-25

### Added

- Bluedot MCP browser OAuth, meeting normalization, and signed-media fallback
- Granola MCP browser OAuth with meeting and transcript tools
- Granola REST API-key transport with explicit selection and scoped note fetch
- Quiet local `.env` loading with a committed secret-free example
- Local JSON/text/Markdown/SRT/VTT context adapter
- Gemini Developer API Files upload with `gemini-3.6-flash`
- Two-pass whole-video indexing and focused moment interrogation
- Automatic and explicit clip-to-transcript alignment
- Built-in `issue-review`, `decisions`, `requirements`, `action-items`, and
  `repo-plan` recipes
- Validated custom JSON recipes
- Versioned `analysis.json` and `manifest.json`
- GitHub-friendly Markdown, self-contained HTML, and screenshots
- Private OS-specific default run storage
- Cleanup of temporary downloads and Gemini uploads
- Scoped `AGENTS.md` plus `CLAUDE.md` compatibility links
- Cross-platform Codex/Claude skill installer
- Bun workspace and text lockfile
- Nuxt 4 SSR + Nuxt UI review workspace
- Explicit validated run-bundle imports
- Local Bun SQLite projection with normalized run/item rows
- Cloudflare Workers build target with D1 adapter and migration
- Cloudflare Access JWT verification with issuer and audience checks
- Local, Cloudflare, and future MCP architecture/runbooks
- Architecture, credentials, recipes, skill installation, versioning, and
  operations documentation
- Deterministic offline test suite and GitHub Actions

### Known limitations

- The current video pipeline requires a Gemini Developer API key; Vertex AI ADC
  is not yet a drop-in backend because Files upload is unavailable there.
- A screen recording is required.
- Granola transcript access can depend on plan/workspace policy.
- Bluedot MCP may not return a recording URL and currently has an observed
  duration output-schema inconsistency.
- Automatic transcript alignment is model-derived and should be overridden for
  deterministic high-stakes clip analysis.
- Hosted imports are manual; there is no automatic local-to-cloud sync.
- The MCP server is an explicitly designed next iteration, not part of v0.1.0.
