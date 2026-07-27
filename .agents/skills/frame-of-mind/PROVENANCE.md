# Skill provenance

The Frame of Mind skill is original project documentation maintained in this
repository under the repository's MIT license.

This directory is the canonical real skill. On the maintainer workstation,
dotfiles, Codex, Claude, and shared-agent discovery resolve here through direct
symlinks. There is no activation shim. The repository installer may still copy
the directory for portable colleague and Windows installations.

The meeting-to-issue workflow was informed by:

- the repository's live, sanitized Frame of Mind operating experience;
- GitHub CLI's official issue commands;
- GitHub's documented Markdown and issue-attachment behavior;
- an externally installed document-coauthoring workflow derived from
  Anthropic's public skill examples;
- externally installed local GitHub issue-authoring guidance.

No browser-control skill or runtime-specific automation was copied into this
package. Browser automation is optional; the durable workflow requires a
reviewed issue body and documented GitHub interfaces, not a particular agent
runtime.

Google's unmodified companion skills live beside this project skill in
`.agents/skills/gemini-api-dev/` and
`.agents/skills/gemini-interactions-api/`, with their own pinned provenance and
Apache-2.0 licenses.
