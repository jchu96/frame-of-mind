# GitHub Automation Agent Instructions

## Workflows

- Use Bun 1.3.14 and `bun install --frozen-lockfile`.
- Run `bun run check` on pushes and pull requests.
- Fail CI for high or critical production dependency advisories.
- Keep workflows read-only unless a separate release process is approved.
- Never expose repository, Bluedot, or Gemini secrets to pull-request code.

## Dependency Updates

- Keep Google Gen AI and MCP SDK updates in separate reviewable changes.
- Review official API contracts before accepting provider major versions.
- Run the live maintainer matrix after provider-boundary changes.
