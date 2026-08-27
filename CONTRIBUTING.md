# Contributing

Thanks for considering a contribution to Frame of Mind. This document covers
the repository layout, local setup, the quality gates every pull request must
keep green, and what maintainers expect from issues and pull requests.

## Repo tour

- `src/` — the CLI, domain contracts, recipes, provider adapters, analysis
  services, and renderers. Context providers, media I/O, recipes, Gemini
  analysis, and renderers remain independent.
- `apps/web/` — the Nuxt application for local review, Local Studio, and the
  hosted Studio surfaces.
- `apps/workflows/` — the Cloudflare Workflows worker used by hosted analysis.
- `test/` and `apps/web/test/` — CLI/domain and web test suites, respectively.
- `scripts/` — repository gates, release rehearsals, smoke tests, and local
  tooling.
- `docs/` — architecture, operations, testing, security, and decision records.

The run bundle is authoritative. SQLite and D1 implementations stay behind the
same `RunStore` projection contract, and provider or media content must never
enter logs, fixtures, or repository history.

## Dev setup

Install Bun 1.3.14 or newer, then install the locked workspace and the local
commit hook:

```bash
bun install --frozen-lockfile
bun run hooks:install
```

The hook installer refuses to replace a different existing `core.hooksPath`.
Migrate those hooks or unset the repository setting explicitly before retrying.

Run the CLI in development mode with `bun run dev`. Use `bun run web` for the
Nuxt workspace. Some media and browser tests also require `ffmpeg`; provider
smoke tests require explicit local credentials and are not part of CI.

## Quality gates

Use the focused commands while developing, then run the pull-request gate
before requesting review. The full sharded gate is the pre-merge and nightly
check across fast, local, and hosted lanes.

```bash
bun run typecheck       # CLI, web, and workflows type checking
bun run test            # Vitest CLI and domain suite
bun run check:pr        # required pull-request gate
bun run check:sharded   # complete sharded gate
```

The PR gate selects the necessary lanes from the diff. See `docs/TESTING.md`
for web, browser, hosted-contract, and change-class-specific commands.

## Writing issues

Search open and closed issues first, then file one actionable problem or
request per issue. Write the title as the condition and consequence, not a
category such as “bug” or “feature request.”

For a bug report:

- Start with the causal summary: what input or workflow triggers the problem,
  what the system does, and why that matters to a user.
- Quantify the impact when evidence permits. Include exact versions, recipe or
  surface, relevant options, and the smallest reliable reproduction.
- Separate observed evidence from root-cause inference and from a proposed fix.
  Exact file and line pointers are useful when verified, but are not required.
- Include expected versus actual behavior and any safe workaround already in
  use. Attach only the minimal logs or output needed to establish the failure.

For a feature request, lead with the user problem and desired outcome. Explain
who encounters it, the current workaround or cost, the proposed behavior, and
alternatives considered. Call out changes to authentication, retention, data
ownership, provider boundaries, or durable contracts so reviewers can route
the design work correctly.

Issue [#120](https://github.com/jchu96/frame-of-mind/issues/120) is the house
example for an evidence-led bug: its title names the failure and consequence;
the body quantifies impact, distinguishes root cause from proposal, gives a
minimal reproduction and workaround, and records the environment. Do not paste
credentials, signed URLs, transcripts, recordings, participant data, or
generated analyses into a public issue.

## Pull request expectations

- Keep diffs focused: one logical change per PR.
- Add or update tests for any behavior change. Prefer real assertions with
  descriptive messages over asserting on shape alone.
- Match the existing code style; do not reformat or refactor unrelated code in
  the same PR.
- Describe what changed and why in the PR description. Link any related issue.
- Make sure the applicable quality gates above pass locally before requesting
  review.
- Use plain Conventional Commit subjects with no emoji. Subjects must use
  `type(scope): lowercase description` (the scope is optional) and must not end
  in a period. The local `commit-msg` hook provides fast feedback, and
  `check:repo-hygiene` enforces the same rule in CI.
- When a PR is substantially agent-authored, say so in the PR body and name the
  human or machine review that checked it. Machine-assistance disclosure is the
  normal case in this repository, not an exception.
