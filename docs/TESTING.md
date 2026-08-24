# Testing

Frame of Mind tests are layered around the product authority boundaries. A
portable run pair remains authoritative; test databases, browser state, and
Worker fixtures are disposable projections.

## Test layers

| Layer | Command | Owns |
|---|---|---|
| CLI/unit | `bun run test` | recipes, providers, contracts, orchestration |
| Web/unit | `bun run test:web` | SQLite/D1, Studio services, UI state modules |
| HTTP contracts | `bun run test:studio-http`, `bun run test:hosted-access-http`, `bun run test:hosted-workflows-http` | built server and Worker request contracts; the hosted Workflow contract also captures its first-user browser UX receipt |
| Smoke E2E | `bun run test:e2e` | the 13 Local Studio browser journeys |
| Hosted E2E | `bun run test:e2e:hosted` | composer → activity → publication → viewer against built Nuxt and Workflows Workers |
| Adversarial E2E | `bun run test:e2e:adversarial` | recurring reviewer regressions tagged `@adversarial` |
| Canary | `bun run test:e2e:canary` | read-only checks for Access compatibility deployments; not the Better Auth reference canary |

`bun run test:e2e:all` selects every project. The canary prints a clear SKIP
when its deployment credentials are absent. `bun run check:e2e` selects hosted
and adversarial projects and is part of `bun run check`. CI uses
`bun run test:e2e:ci`, which adds smoke and fails on flaky retries.

## Gate tiers

The gate follows the nwave mission: minimize tests while maximizing decision
value and reducing feedback time. The fast answer must still preserve the
authority-boundary checks relevant to the change; a shorter tier is not
permission to remove coverage from the complete gate.

| Change class | `check:pr` selection | Reason receipt |
|---|---|---|
| Docs, Markdown, `conductor/**`, `test/**`, or presentation-only Vue/images/icons/fonts under `apps/web/app/**` | fast + local | `all_paths_safe` |
| Stylesheets under `apps/web/app/**` or `apps/web/app.config.*` | fast + local + hosted | `theme_contract_paths` |
| Any other contract-bearing path | fast + local + hosted | `unsafe_path` |

- `bun run check:pr` runs the fast and local lanes only when every changed path
  is explicitly safe: `docs/**`, Markdown, `conductor/**`, `test/**` unit tests,
  or presentation assets under `apps/web/app/**` (`.vue`, images, icons, and
  fonts). Stylesheets and app configuration are excluded because they can
  define the `--ui-*` semantic tokens whose contrast contract runs in hosted.
- `bun run check:sharded` runs fast, local, and hosted lanes for every merge to
  `main` and every nightly gate.
- Every path outside that safe allowlist upgrades `check:pr` to sharded. This
  includes `src/**`, `apps/web/server*/**`, `apps/workflows/**`, `scripts/**`,
  `db/migrations/**`, `package.json`, `bun.lock`, Nuxt configuration, and
  `.github/**`. The default comparison is `origin/main`; override it with
  `FRAME_OF_MIND_GATE_BASE_REF=<ref>` or `--base <ref>`. An unavailable base
  fails closed to the complete tier and prints
  `tier=sharded reason=base_ref_unavailable`.
- `bun run check` remains the serial fallback and retains its original 16-step
  order.

## Gate lanes

The three lanes cover exactly the same 16 logical steps as the serial gate. A
unit test parses `package.json` and rejects omissions or duplicates.

| Lane | Logical checks | Shared build |
|---|---|---|
| fast | repository hygiene, typechecks, CLI/unit tests, web/unit tests | none |
| local | CLI build, node web build, Local Studio HTTP contract, streaming spike | one `node-server` artifact |
| hosted | auth/principal contracts (Better Auth plus Access compatibility), Workflows (two auth modes), media, hosted/adversarial Playwright, release rehearsal | one `cloudflare_module` artifact and one sibling Workflows artifact |

Run one lane directly with `bun run check:lane:fast`,
`bun run check:lane:local`, or `bun run check:lane:hosted`.

`bun run check:sharded` starts the lanes concurrently, prefixes complete output
lines with the lane name, prints per-lane exit codes and wall time, and prints
total wall time. Set `FRAME_OF_MIND_GATE_PARALLELISM=1` to serialize lanes under
load; the default is three.

On a shared host, wrap `check:sharded` in the house `gate-lock`; lanes inside one
invocation are bounded by `FRAME_OF_MIND_GATE_PARALLELISM`.
Concurrent invocations keep fast work parallel while runtime-bearing local and
hosted lanes take the existing machine-wide workerd/Chromium lease as lane
units. Waiting for a lane lease happens outside per-step timers; child contracts
inherit a verified lease token and cannot silently bypass a different owner.

On this machine, the hub-measured pre-sharding serial gate required 75–90
minutes. The same 16-step implementation tree completed with a cold build cache
in 324.47 seconds: fast 20.17 seconds, local 38.81 seconds, and hosted 324.46
seconds. Hosted dominated the wall clock, led by the two Workflows HTTP modes
at 62.61 and 95.19 seconds. A future optimization may overlap the independent
hosted contract processes inside that lane; it is intentionally deferred from
the first sharded-gate landing.

## CI

GitHub Actions separates required branch-protection checks from the advisory
hosted lane:

| Job | Status | Budget | Command and ownership |
|---|---|---:|---|
| `check` | required | 15 minutes | `bun run check:pr --base origin/<base>` with fast and local lanes; production audit follows |
| `browser-e2e` | required | 15 minutes | independently installs Chromium and runs the synthetic Studio browser suite |
| `fresh-clone` (Ubuntu, macOS, Windows) | required | 15 minutes each | frozen Ubuntu/macOS fresh builds plus the Windows install-only contract |
| `hosted-contracts` | advisory (`continue-on-error`) | 40 minutes | needs `check`, installs Chromium, then runs `bun run check:lane:hosted` with 30-minute logical-step bounds, a five-minute Better Auth access-step cap, and gate parallelism 1 |
| `serial-check` | nightly/manual | 120 minutes | serial fallback over the complete logical gate |

The `check` job sets `FRAME_OF_MIND_GATE_HOSTED_LANE_SEPARATE=1`, so CI runs
fast and local lanes there while `hosted-contracts` reports the hosted lane
separately. Hosted remains advisory because the Workflows contract exceeds its
budget on the 2-core runner; [issue #96](https://github.com/jchu96/frame-of-mind/issues/96)
tracks restoring a reliable required hosted check. Local `check:pr` calls retain
the fail-closed adaptive tier selection described in [Gate tiers](#gate-tiers),
and `bun run check:sharded` remains the repository's complete pre-merge gate.

When CI is red, start with the owning job. A `check` failure belongs to hygiene,
types, unit tests, local builds/contracts, or the production audit. A
`hosted-contracts` failure belongs to the Cloudflare/Workflows contracts,
hosted browser projects, or release rehearsal; confirm the Chromium install
step before diagnosing application authentication. A `fresh-clone` failure is
an install/lockfile/portable-build failure—never weaken `--frozen-lockfile`.
Windows workspace-key drift specifically means checking whether the harness
kept its temporary clone on the checkout drive.

Each logical step has a 20-minute hard timeout by default. Override it with the
positive integer `FRAME_OF_MIND_STEP_TIMEOUT_SECONDS`; the 2-core hosted CI job
uses 30 minutes except for `test:hosted-access-http:better-auth`, whose
`FRAME_OF_MIND_HOSTED_ACCESS_STEP_TIMEOUT_SECONDS` cap is five minutes. A timeout prints
`exit=step_timeout` and terminates only the detached process group created for
that step. The historically intermittent Better Auth Workflow contract receives
one automatic retry only after `step_timeout`; CI extends that single-receipted
retry to the standard Workflow contract as well. Local runs remain Better
Auth-only. Retries print `retry=1`; deterministic non-zero exits and all other
steps are not retried.

### Prebuilt artifact contract

The local and hosted contract runners accept
`FRAME_OF_MIND_PREBUILT_OUTPUT=<absolute-directory>`. Hosted Workflows consumers
also accept the sibling
`FRAME_OF_MIND_PREBUILT_WORKFLOWS=<absolute-directory>`. Each directory must
contain `.frame-of-mind-build.json` with the required preset
(`node-server`, `cloudflare_module`, or `cloudflare-workflows`). A missing,
invalid, or wrong marker fails closed with `prebuilt_preset_mismatch`. Without
these variables, every script retains its prior build behavior.

Lane builds use isolated Nuxt build and output directories, never
`apps/web/.nuxt` or `apps/web/.output`. Outputs are cached by a SHA-256 over the
Git-tracked tree plus untracked, non-ignored files. Documentation (`docs/**`,
`conductor/**`, and `*.md`) and `apps/web/e2e/__screenshots__/**` are excluded;
generated and dependency trees remain excluded because Git ignores them. This
conservative input set covers `src/**`, `scripts/**`, both app trees, lockfiles,
package manifests, TypeScript configuration, and configuration import seams.

Build children inherit only `PATH`, `HOME`, `TMPDIR`, and `CI`, plus the lane's
explicit build settings and run-owned destination paths. Ambient `NUXT_*` and
`FRAME_OF_MIND_*` variables cannot leak into an artifact. The sorted
content-bearing environment pairs are part of the cache key; run-owned output
locations are deliberately destination-only. The default cache is
`~/.cache/frame-of-mind/builds`; override it with
`FRAME_OF_MIND_BUILD_CACHE=<directory>` or disable it with
`FRAME_OF_MIND_BUILD_CACHE=off`. Only the five newest entries are retained. A
hit prints `build=CACHED <hash8>` and is copied into the run-owned temporary
tree before consumers start.

The quarantine file is
[`apps/web/e2e/flaky-quarantine.json`](../apps/web/e2e/flaky-quarantine.json).
It must remain an explicit JSON array; zero entries is the normal state.

## Browser layout

Playwright projects map directly to these folders:

- `apps/web/e2e/smoke/`: Local Studio bootstrap and 13 existing journeys;
- `apps/web/e2e/hosted/`: hosted browser journey and publication atomicity;
- `apps/web/e2e/adversarial/`: reviewer-derived security and preservation probes;
- `apps/web/e2e/canary/`: deployed, read-only checks;
- `apps/web/e2e/support/`: boot, identity, fixtures, and isolation.

The HTTP contract scripts retain their request assertions. The hosted Workflow
contract additionally drives the #83 first-time-user journey against the same
built, isolated two-Worker topology; the other HTTP contracts remain
browser-free.

## Boot the built Workers

A reviewer boots and exercises the complete synthetic hosted topology with one
command:

```bash
bun run test:e2e:hosted
```

The shared hosted fixture builds the Nuxt `cloudflare_module` artifact, dry-runs
the Workflows Worker, applies migrations to a unique local D1 name, seeds
principal-bound sealed-media receipts, then starts both Workers under workerd.
It also starts a fake Access JWKS issuer, fake GitHub OAuth endpoint, captured
HTTP mailer, Wrangler's local `send_email` simulator, and a fake Gemini port.
The auth spike proves both mailer paths without `remote: true`; provider calls
remain offline.

Better Auth has a named Playwright project and a `HostedAuthMode` fixture seam.
The complete hosted lane runs it alongside the Access compatibility contract.

## Principals and sessions

Tests obtain identities from the hosted fixture:

```ts
const principalA = await hosted.session("a");
const principalB = await hosted.session("b");
const service = await hosted.session("service");
```

In Better Auth mode these are fixture sessions bound to `ba:` principals; in
Access compatibility mode they are short-lived RS256 JWTs signed by the fixture
JWKS. Never print the returned headers. Principal A and B deliberately
use different subjects so ID-sweep tests can distinguish ownership without
using real participant data.

## Click through hosted Studio locally

Run the long-lived local topology and leave it open while you drive the browser:

```bash
bun run hosted:local
```

It prints `HOSTED LOCAL http://127.0.0.1:<port>` and a synthetic invited user,
then stays up until Ctrl+C. It uses Better Auth, seeds the invite, starts fake
GitHub and Gemini services, and prints captured fixture magic links. To test
the Access compatibility path explicitly:

```bash
bun run hosted:local -- --mode cloudflare-access
```

The printed Access helper URL is a loopback reverse proxy that injects only the
generated principal-A assertion. Removing the `tester@example.test` invite
from the Better Auth seed is discriminating: the fake GitHub sign-in must end
with `EMAIL_NOT_INVITED`.

The hosted-auth contract also submits the same invited magic-link address
twice within 60 seconds. The second request must return 429 with
`MAGIC_LINK_COOLDOWN`, while Wrangler's local email simulator must still
contain exactly one captured message.

Run the hosted two-Worker, two-principal contract and its first-time-user
browser journey:

```bash
bun run test:e2e:hosted
```

The Access compatibility pass refreshes desktop (1280×900) and mobile (390×844)
visual receipts in the current reviewed `apps/web/e2e/__screenshots__/ux-pass-*`
directory. Pass 3 covers Intent, Recording empty and ready states, Review and
start, Activity running/detail/list views, the published viewer, hosted review
workspace, Results, Import, and the branded not-found state. The same contract
also proves own-principal review and support access plus foreign-principal 404
denial. The Better Auth variant runs in the full `bun run check` gate without
replacing the Access screenshots.

Verify the live Gemini upload, index, detail, and cleanup boundary separately
with generated media:

```bash
bun run smoke:gemini
```

This command requires a locally configured `GEMINI_API_KEY`, is intentionally
outside CI, prints no provider payload or remote identifier, and removes its
temporary local and remote files.

## Fixtures

`apps/web/e2e/support/fixtures.ts` owns public-safe fixture families:

- sealed media receipts for principals A and B;
- schema-valid run pairs with distinct run IDs;
- adversarial transcript/path/URL/token/email/provider-error trap strings.

The built-Worker fixture seeds only opaque media metadata and generated
digests. No recording, transcript, provider credential, signed URL, or real
analysis is loaded.

## Isolation

`apps/web/e2e/support/isolation.ts` is required by every E2E harness and the
hosted HTTP/release scripts. Each invocation receives:

- random free listener ports;
- a unique `mkdtemp` root under the OS temp directory;
- a private Wrangler persistence directory;
- a unique local D1 database name and UUID.

The outer runner removes its exact temporary tree on success and failure.
Playwright reports remain under ignored, run-ID-specific `test-results/` and
`playwright-report/` directories so concurrent gates do not overwrite one
another.

Top-level local E2E runners also hold one machine-wide runtime lease for their
complete workerd/Chromium lifetime. Per-run paths isolate state, but they do
not isolate CPU and process capacity: overlapping hosted gates can make local
Workflow dispatch return 503 or terminate a Chromium context. Nested hosted
fixtures reuse their outer runner's lease. A dead owner is detected by PID and
reaped, so an interrupted gate does not leave the machine permanently locked.
Wrangler Worker, service, and Workflow names are also derived from the run ID;
fixed names can collide with stale entries in Wrangler's local service registry
even after the prior child process exits. Concurrent HTTP fixtures must consume
their admitted responses and wait for the resulting Workflows to settle before
starting a later scenario in the same emulator lifetime.

On shared fleet machines that provide `gate-lock`, invoke the outer gate through
that wrapper too (for example, `gate-lock bun run check`). It coordinates this
repository with other worktrees and repositories before the in-process lease
exists.

## Discriminating regressions

These tests are intentionally coupled to named failure modes:

- foreign sealed media must map to 404;
- `/api/__studio-spike/` must remain in the local session matcher;
- hosted publication must validate its pair and D1 partial writes must roll
  back registry, run, and item rows together;
- support receipts must remain a closed projection;
- maintenance must preserve an old queued sibling while any worker heartbeat
  is recent;
- the direct-upload spike must retain slow-sink, over-length, and short-part
  receipts.

Review briefs should link this file and the exact spec rather than reconstruct
the boot sequence in prose.

## Access compatibility canary

The current deployed canary is read-only, not part of `bun run check`, and
supports only Access compatibility deployments. Do not present it as coverage
for the Better Auth reference instance. Configure it only in a release shell:

```bash
FRAME_OF_MIND_CANARY_URL="https://<hostname>" \
CF_ACCESS_CLIENT_ID="<service-token-id>" \
CF_ACCESS_CLIENT_SECRET="<service-token-secret>" \
bun run test:e2e:canary
```

It emits only `CANARY <check>=PASS|FAIL` receipts. Never commit or paste the
service-token values.
