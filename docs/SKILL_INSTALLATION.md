# Codex and Claude Skill Installation

Frame of Mind includes one canonical repository-owned skill:

```text
.agents/skills/frame-of-mind/
```

The installer copies that skill into the discovery directory for Codex, Claude,
the shared agents convention, or all three.

## Why copy

A public clone must work on:

- macOS;
- Linux;
- native Windows without Developer Mode;
- machines where Codex and Claude use different home directories.

Repository-internal `CLAUDE.md` files are relative symlinks to `AGENTS.md`.
Installed skills are copied because outward symlinks are fragile across clones,
Windows, containers, and removable worktrees.

The repository remains the source. Rerun the installer after pulling updates.

## Install the CLI first

```bash
gh repo clone jchu96/frame-of-mind
cd frame-of-mind
bun install --frozen-lockfile
bun run check
bun run build
bun link
```

Verify:

```bash
frameofmind --version
frameofmind recipes
frameofmind doctor
```

## Install for both agents

```bash
bun run install:skill -- --target all
```

Targets:

| Target | Destination |
|---|---|
| `agents` | `~/.agents/skills/frame-of-mind` |
| `codex` | `~/.codex/skills/frame-of-mind` |
| `claude` | `~/.claude/skills/frame-of-mind` |
| `all` | all three |

Restart the agent after installation so it refreshes skill discovery.

## Install one target

Codex:

```bash
bun run install:skill -- --target codex
```

Claude:

```bash
bun run install:skill -- --target claude
```

Shared agents directory:

```bash
bun run install:skill -- --target agents
```

## Overwrite behavior

The installer writes:

```text
.frame-of-mind-managed.json
```

inside each installed skill.

If a destination already exists:

- a prior managed installation is safely replaced;
- an unmanaged directory is refused;
- `--force` replaces an unmanaged exact destination.

Use `--force` only after reviewing the target:

```bash
bun run install:skill -- --target codex --force
```

The installer never removes a parent skills directory and never reads provider
tokens, API keys, recordings, transcripts, or analysis runs.

## Verify installation

Inspect the exact skill:

```bash
test -f "$HOME/.codex/skills/frame-of-mind/SKILL.md"
test -f "$HOME/.claude/skills/frame-of-mind/SKILL.md"
```

On PowerShell:

```powershell
Test-Path "$HOME\.codex\skills\frame-of-mind\SKILL.md"
Test-Path "$HOME\.claude\skills\frame-of-mind\SKILL.md"
```

Then start a new agent session and ask:

```text
Use the Frame of Mind skill to list the available recipes.
```

The agent should route to:

```bash
frameofmind recipes
```

## Updating

```bash
git pull --ff-only
bun install --frozen-lockfile
bun run check
bun run build
bun run install:skill -- --target all
```

Restart agent sessions after update.

## Maintainer isolated test

Set `FRAME_OF_MIND_SKILL_HOME` to a temporary directory to test without touching
real agent configuration:

```bash
FRAME_OF_MIND_SKILL_HOME="<temporary-directory>" \
  bun run install:skill -- --target all
```

This variable is for installer testing, not normal installation.

## Repository-local agent behavior

The repository includes scoped `AGENTS.md` files for:

- root architecture and security;
- adapters;
- services;
- recipes;
- tests;
- docs;
- CI;
- scripts;
- the skill itself.

Each scoped directory has:

```text
CLAUDE.md -> AGENTS.md
```

This keeps Codex and Claude guidance aligned.

On Windows, git may check symlinks out as plain text unless Developer Mode and
`core.symlinks=true` are enabled. The installed skill itself is copied and does
not rely on those symlinks.

## Uninstall

Confirm the marker before removal:

```bash
test -f "$HOME/.codex/skills/frame-of-mind/.frame-of-mind-managed.json"
test -f "$HOME/.claude/skills/frame-of-mind/.frame-of-mind-managed.json"
```

Remove only the exact Frame of Mind skill directories through your normal file
manager or approved uninstall workflow. Do not recursively delete
`~/.codex/skills`, `~/.claude/skills`, or `~/.agents/skills`.

Uninstalling the skill does not remove:

- the CLI link;
- provider OAuth tokens;
- Gemini environment variables;
- local analysis runs;
- the repository clone.

See the main runbook for complete removal.
