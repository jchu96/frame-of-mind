# Changelog

All notable changes to Frame of Mind are documented here. The project follows
Semantic Versioning.

## [Unreleased]

### Planned

- Vertex AI backend with private Cloud Storage media staging
- GitHub issue draft/export workflow
- Context-only recipes for meetings without screen recordings
- Optional local search/index over prior analyses
- Read-only local stdio and Cloudflare Streamable HTTP MCP servers

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
