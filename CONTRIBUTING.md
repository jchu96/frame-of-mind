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

Install Bun 1.4.4 or newer, then install the locked workspace and the local
commit hook:

```bash
bun install --frozen-lockfile
bun run hooks:install
```

The hook installer refuses to replace a different existing `core.hooksPath`.
Migrate those hooks or unset the repository setting explicitly before retrying.

Run the CLI in development mode with `bun run dev`. Both `dev` and `start` pass
`--no-env-file` so Bun leaves the folder’s dotenv assignments for the CLI to read
as application settings. Under bare Bun 1.4.4, an inherited `PATH` wins, but
the folder file can supply `PATH` or desktop and locale settings that were
unset. Media tools and openers receive those allowed settings. Use a clean
launch when the origin of helper settings matters.

Node preloads and loaders, including those set in `NODE_OPTIONS`, are clean
launches. Node’s `--env-file` and `--env-file-if-exists` put the CLI in the same
mode as bare Bun. Ordinary commands run, doctor reports unknown key provenance,
and a job start requires restarting without the Node env-file option.

Use `bun run web` for the
Nuxt workspace. Some media and browser tests also require `ffmpeg`; provider
smoke tests require explicit local credentials and are not part of CI.

## Quality gates

Use the focused commands while developing, then run the pull-request gate
before requesting review. Run the full sharded gate across fast, local, and
hosted lanes when the machine is unloaded; required CI at the exact PR head is
the merge oracle.

```bash
bun run typecheck       # CLI, web, and workflows type checking
bun run test            # Vitest CLI and domain suite
bun run check:pr        # required pull-request gate
bun run check:sharded   # complete gate when the machine is unloaded
```

The PR gate always runs the fast and local lanes, whatever the diff touches. On a busy machine,
defer the full run or set `FRAME_OF_MIND_GATE_PARALLELISM=1` to serialize lanes.
The only required Better Auth integration check on PRs is `auth-contract`,
which covers HTTP access and revocation. The hosted lane covers Cloudflare Access
HTTP and Workflows, media, auth modes, the Access browser journey and
adversarial tests, and release rehearsal. That lane runs nightly, on
manual dispatch, and before every deploy (`gate-lock bun run check:deploy`
checks without deploying; `deploy:hosted` runs the same checks first);
its known failures are tracked in
[#113](https://github.com/jchu96/frame-of-mind/issues/113) and
[#96](https://github.com/jchu96/frame-of-mind/issues/96). A change the
pull-request gate cannot see, such as an update to `wrangler`, a Workers
runtime package, or an authentication library, needs one local run of
`bun run check:lane:hosted` before it merges, with the result in the pull
request. See [Testing](docs/TESTING.md#ci) for the required contexts and the
web, browser, hosted-contract, and change-class-specific commands.

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
  in a period. Release commits use `release: vX.Y.Z`. The local `commit-msg`
  hook provides fast feedback, and
  `check:repo-hygiene` enforces the same rule in CI.
- Review matches what the change can break. A code change gets one independent
  review at the exact head that will merge, by someone or something other than
  its author; a second commit after review is checked on its own. A change
  to prose documents only (Markdown, text, the licence) needs the automatic
  checks and no review. Agent instruction files (`AGENTS.md`, `CLAUDE.md`)
  and data files such as JSON are reviewed like code, because agents and
  tools act on them. A change to
  a merge gate, to secret handling, or to anything that deletes or uploads a
  user's recording also needs a written list of the faults it must catch, each
  shown failing.
- A maker's report that the gate passed is a claim. Required CI at the exact
  head is the receipt.
- Working papers for a change (briefs, status notes, review notes) are never
  committed; `.gitignore` covers the usual names.
- When a PR is substantially agent-authored, say so in the PR body and name the
  human or machine review that checked it. Machine-assistance disclosure is the
  normal case in this repository, not an exception.
