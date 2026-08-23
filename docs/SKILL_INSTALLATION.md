# Codex and Claude Skill Installation

Frame of Mind includes one canonical repository-owned skill:

```text
.agents/skills/frame-of-mind/
```

That directory is the one real project skill. Do not create a second wrapper or
activation shim.

Its portable `references/meeting-to-issue.md` incorporates the durable parts
of the document-coauthoring and GitHub issue-authoring workflows used during
live validation. Runtime-specific browser automation was intentionally not
copied: it is optional, changes by agent host, and is not part of the analysis
contract. See the skill's `PROVENANCE.md`.

It also vendors two unmodified Google-owned companion skills:

```text
.agents/skills/gemini-api-dev/
.agents/skills/gemini-interactions-api/
```

Their `PROVENANCE.md` files pin
[`google-gemini/gemini-skills`](https://github.com/google-gemini/gemini-skills)
and their Apache-2.0 license. Agents operating inside the clone discover these
companions directly. Do not edit their upstream `SKILL.md` or `references/`
files; refresh the vendor copy and update provenance instead.

The installer copies that skill into the discovery directory for Codex, Claude,
the shared agents convention, or all three. “That skill” means the
Frame of Mind product skill; the Google companions remain repository-local so
the public project does not overwrite a colleague's global Gemini guidance.

## Maintainer direct-symlink mode

On macOS or Linux, a maintainer who keeps the repository at
`~/repos/frame-of-mind` may expose the canonical skill directly:

```bash
ln -s "$HOME/repos/frame-of-mind/.agents/skills/frame-of-mind" \
  "$HOME/.agents/skills/frame-of-mind"
ln -s "$HOME/repos/frame-of-mind/.agents/skills/frame-of-mind" \
  "$HOME/.codex/skills/frame-of-mind"
ln -s "$HOME/repos/frame-of-mind/.agents/skills/frame-of-mind" \
  "$HOME/.dotfiles/claude/skills/frame-of-mind"
```

If `~/.claude` already resolves to the dotfiles Claude directory, the final
link exposes the same canonical skill to Claude. No activation shim is needed.
Use the copy installer below for colleagues, CI, containers, and native Windows
where that repository path or symlink support is not guaranteed.

The installer intentionally refuses an existing unmanaged symlink. Choose one
mode: direct local symlinks or managed copies.

When switching an existing managed-copy installation to direct links, verify
each exact `.frame-of-mind-managed.json` marker and move the old directories to
a recoverable location outside every skill-discovery root before running
`ln -s`. Never remove or overwrite an unmarked skill directory.

To install Google's current companions globally outside this repository, use
their official package:

```bash
npx skills add google-gemini/gemini-skills --skill gemini-api-dev --global
npx skills add google-gemini/gemini-skills --skill gemini-interactions-api --global
```

## Agent skills used to build and operate this repo

These skills informed development and operations, but only the first group is
part of this repository. They are agent guidance, not application runtime
dependencies.

### Vendored official Google skills

- **`gemini-api-dev`** — current Gemini SDK, Files API, model, and multimodal
  guidance used around the production analysis adapter.
- **`gemini-interactions-api`** — current Interactions, structured-output,
  multimodal, and migration contracts used to keep the deferred API path
  explicit.

Both are unmodified, repository-vendored copies from Google's official
[`google-gemini/gemini-skills`](https://github.com/google-gemini/gemini-skills).
Each companion's `PROVENANCE.md` pins the upstream commit and license.

### Cloudflare official marketplace skills

- **`cloudflare`** — Workers, D1, R2, Workflows, bindings, and platform-boundary
  guidance.
- **`cloudflare-email-service`** — Email Service bindings, local-versus-remote
  behavior, delivery, and mailer operations.
- **`wrangler`** — configuration, local emulation, migrations, secrets,
  deployment, and resource operations.

These Cloudflare-owned skills come from the official
[`cloudflare/skills`](https://github.com/cloudflare/skills) marketplace. They
are **not vendored in this repository**. The marketplace README gives these
exact Claude Code installation commands:

```text
/plugin marketplace add cloudflare/skills
/plugin install cloudflare@cloudflare
```

Other Agent Skills-compatible runtimes can use the installation method listed
in that marketplace README.

### Maintainer house skills not shipped

- **`nuxt`** — covered Nuxt 4/Nitro boundaries, SSR-safe state, server routes,
  build targets, and test-layer separation; substitute current Nuxt framework
  guidance.
- **`nuxt-ui`** — covered accessible Nuxt UI composition, semantic theming,
  responsive layouts, and form behavior; substitute current component-library
  and accessibility guidance.
- **`playwright-skill`** — covered browser-flow, responsive, screenshot, and
  interaction validation; substitute a Playwright browser-automation workflow.
- **UI designer review agent** — provided visual hierarchy, responsive,
  accessibility, and cold-read review of screenshot passes; substitute an
  independent product-design and accessibility review.

These house tools are maintainer-owned and intentionally not shipped or
required by the public project.

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

Requirements are Bun 1.3.14+, Node.js 22+, and Git. GitHub CLI is optional;
without it:

```bash
git clone https://github.com/jchu96/frame-of-mind.git
cd frame-of-mind
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
- Conductor track synchronization;
- adapters;
- services;
- recipes;
- tests;
- docs;
- CI;
- scripts;
- shared web contracts;
- local Studio, API, storage, middleware, UI, and web tests;
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
