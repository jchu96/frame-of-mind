# Script Agent Instructions

- Keep installers cross-platform and non-interactive.
- Resolve exact targets and refuse to overwrite unmanaged directories unless `--force` is explicit.
- Never read or copy provider tokens, API keys, meeting data, or generated runs.
- Add offline tests for argument parsing and target safety when installer behavior changes.
- Keep repository-owned skill source under `.agents/skills/frame-of-mind`.
- Use `FRAME_OF_MIND_SKILL_HOME` only for isolated installer tests; normal installs use the OS home directory.
- Keep Playwright workers, browsers, Nuxt builds, and test servers behind the
  explicit E2E environment allowlist; never pass provider or workspace secrets.
- Keep Bun automatic dotenv loading disabled throughout the synthetic E2E
  process tree.
- The outer Playwright runner owns its exact OS-temp directory and must remove
  it after both passing and failing runs.
