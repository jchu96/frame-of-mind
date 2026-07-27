# Documentation Agent Instructions

## Sources of Truth

- `README.md`: product overview, quick start, command and artifact reference.
- `docs/ARCHITECTURE.md`: boundaries, contracts, trust model, and extension points.
- `docs/CREDENTIALS.md`: Gemini Developer API and future Vertex authentication.
- `docs/RECIPES.md`: built-in/custom analysis intent.
- `docs/PROVIDERS.md`: Bluedot, Granola MCP/API, and local context contracts.
- `docs/WEB_WORKSPACE.md`: local Nuxt/SQLite projection and import runbook.
- `docs/TESTING.md`: test-layer ownership, browser isolation, and E2E roadmap.
- `docs/CLOUDFLARE_DEPLOYMENT.md`: Workers, D1, Access, verification, rollback.
- `docs/MCP_ROADMAP.md`: deferred local/hosted read-only MCP boundary.
- `docs/RUNBOOK.md`: installation, operations, incident response, and troubleshooting.
- `docs/VERSIONING.md`: release and compatibility policy.
- `docs/project_notes/`: sanitized causal history and gotchas.
- `docs/adr/`: durable architecture decisions and unresolved proposals.

## Rules

- Use GitHub-flavored Markdown and GitHub-supported Mermaid syntax.
- Use real line breaks; never insert literal `\n` strings.
- Keep commands copyable and mark placeholders with angle brackets.
- Do not include real meeting IDs, emails, signed URLs, paths, tokens, or API keys.
- Update diagrams when control flow or trust boundaries change.
- Record current uncertainty explicitly instead of presenting inference as contract.
- Keep setup friendly to macOS, Linux, Windows, Codex, and Claude.
