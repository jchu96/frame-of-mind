# Documentation Agent Instructions

## Sources of Truth

- `README.md`: product overview, quick start, command and artifact reference.
- `docs/ARCHITECTURE.md`: boundaries, contracts, trust model, and extension points.
- `docs/CREDENTIALS.md`: Gemini Developer API and future Vertex authentication.
- `docs/RECIPES.md`: built-in/custom analysis intent.
- `docs/VIDEO_UNDERSTANDING.md`: Gemini video/prompt behavior and deep-analysis boundaries.
- `docs/ARTIFACT_COMPOSITION.md`: evidence-to-issue/SOP/explainer/coaching/Q&A quality contract.
- `docs/PROVIDERS.md`: Bluedot, Granola MCP/API, and local context contracts.
- `docs/WEB_WORKSPACE.md`: local Nuxt/SQLite projection and import runbook.
- `docs/TESTING.md`: gate tiers, test-layer ownership, browser isolation, and E2E roadmap.
- `docs/CLOUDFLARE_DEPLOYMENT.md`: Workers, D1, Better Auth, verification, rollback.
- `docs/SKILL_INSTALLATION.md`: portable Codex and Claude skill installation.
- `docs/adr/0019-pluggable-auth-modes.md`: historical auth-mode decision record.
- `docs/MCP_ROADMAP.md`: deferred local/hosted read-only MCP boundary.
- `docs/RUNBOOK.md`: installation, operations, incident response, and troubleshooting.
- `docs/MEETING_TO_ISSUE_RUNBOOK.md`: transcript-scoped analysis, repository grounding, BI synthesis, and authorized issue publication.
- `docs/VERSIONING.md`: release and compatibility policy.
- `docs/project_notes/`: sanitized causal history and gotchas.
- `docs/adr/`: immutable architecture history; supersede decisions instead of rewriting them.

## Rules

- Use GitHub-flavored Markdown and GitHub-supported Mermaid syntax.
- Use real line breaks; never insert literal `\n` strings.
- Keep commands copyable and mark placeholders with angle brackets.
- Do not include real meeting IDs, emails, signed URLs, paths, tokens, or API keys.
- Update diagrams when control flow or trust boundaries change.
- Record current uncertainty explicitly instead of presenting inference as contract.
- Keep setup friendly to macOS, Linux, Windows, Codex, and Claude.
