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

`bun run check:pr` always runs fast and local, for every changed path and even
when the comparison base is unavailable. `--base` still passes the commit
validation base to those lanes; it does not select hosted coverage. The output
states `CHECK_PR hosted=excluded runs=nightly,manual,check:deploy`.

`bun run check:sharded` explicitly runs all three lanes. `bun run check`
remains the complete 16-step serial fallback. The complete hosted lane is
quarantined from the default PR gate, not deleted: see the
[issue and return rule](HOSTED_GATE_QUARANTINE.md).

For release validation, run `gate-lock bun run check:deploy`. This runs the
default gate followed by the whole hosted lane without deploying. Deploy with
`gate-lock bun run deploy:hosted web` (or `workflows`): each invocation runs both
gates itself and calls Wrangler only after they pass with unchanged HEAD and
source inputs. Previous runs and hand-written success files cannot authorize
a deployment. See
[deployment](CLOUDFLARE_DEPLOYMENT.md#7-build-and-deploy).

## Gate lanes

The three available lanes cover exactly the same 16 logical steps as the serial gate. A
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
| `auth-contract` | required | 15 minutes | `bun run check:auth-contract`; built Worker, ephemeral local D1, and synthetic GitHub OAuth prove the minimum Better Auth authorization boundary without secrets |
| `browser-e2e` | required | 15 minutes | independently installs Chromium and runs the synthetic Studio browser suite |
| `fresh-clone` (Ubuntu, macOS, Windows) | required | 15 minutes each | frozen Ubuntu/macOS fresh builds plus the Windows install-only contract |
| `serial-check` | nightly/manual | 120 minutes | default gate, then the whole hosted lane even if the default gate failed; cancellation stops both |

The `check` job runs fast and local lanes, like the local default gate.
`auth-contract` separately requires the hosted
identity and authorization invariant: migrations apply and replay, missing and
unapproved sessions cannot reach protected routes, approved sessions own only
their `ba:<userId>` rows, foreign detail is 404, the admin surface is dark to a
non-maintainer, and revocation is enforced on the next request. Every identity,
secret, OAuth provider, and D1 database in that job is synthetic and run-local;
the workflow references no GitHub secret, so public-fork pull requests exercise
the same contract.

The advisory `hosted-contracts` PR job has been removed: unchanged-tree
failures would otherwise leave a repeatedly red job on pull requests. Its
whole lane runs in nightly/manual `serial-check`, with a nonzero result still
failing that job. The six required PR contexts are unchanged.

`check:e2e` uses the browser runner's existing retries when `CI` is set, so it
can pass after a retried journey. In the 2026-11-13 baseline measurement this
happened twice in four reached runs. Its lane-level `retry=0` only describes
the lane runner, not Playwright retries. The required `browser-e2e` job runs
`test:e2e:ci`, whose own `--fail-on-flaky-tests` flag fails on a flaky test.
Retries and browser specs have not changed.

When CI is red, start with the owning job. A `check` failure belongs to hygiene,
types, unit tests, local builds/contracts, or the production audit. An
`auth-contract` failure belongs to the built Better Auth/D1 identity,
membership, principal-isolation, or revocation boundary; it is not repaired by
adding a CI secret. A hosted-step failure in nightly/manual
`serial-check` belongs to the Cloudflare/Workflows contracts,
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

### Accepted integration risks outside pull requests

Moving the whole hosted lane removes its integration execution from the default
PR gate and the former advisory PR job. The required `browser-e2e` job runs the
smoke suite; it does not replace the hosted or adversarial browser projects.
A change that leaves partial publication rows in D1 can therefore pass PR
checks: the test that forces a database failure and verifies publication
rollback now runs nightly and before deployment.

The following risks are accepted for this quarantine. Every row runs in the
nightly/manual **`serial-check`** job's `check:lane:hosted` step and in each
`deploy:hosted` invocation (also in check-only `check:deploy`). The lane stops
on failure, so earlier failures can prevent later assertions from being reached.
A passing unit test is not equivalent to these Worker/browser integration checks.

| Hosted command / nightly owner | Integration behavior no longer exercised on PRs | Coverage still required on PRs |
|---|---|---|
| `test:hosted-access-http` / `serial-check` | Access-authenticated ownership across two users for import, list, detail and conflicts; service callers denied browser routes; missing assertions; session projection; disabled hosted routes and admin HTTP operations. | Access JWT policy and D1 isolation unit checks; required migrations. Better Auth exercises a different auth mode. |
| `test:hosted-access-http:better-auth` (full scope) / `serial-check` | Notification contents and deduplication, magic-link refusal, capacity/rate limits, full admin list/approve/deny/revoke/idempotency/no-mail behavior, and maintainer CLI transitions. | Required auth scope retains migrations and replay, synthetic GitHub sessions, unapproved-route denials, access-request/replay state without mail, two-user ownership, session projection, disabled hosted/admin routes, principal mapping and next-request revocation. Auth/admin/rate-limit unit checks are narrower. |
| `test:hosted-workflows-http` / `serial-check` | Actual two-Worker execution, publication and cleanup; disabled routes; janitor/replay; spend overruns, caps and races; legacy/missing activity data; every built-in recipe; foreign job/media/run/review/support access and foreign-media creation; missing hashes; cancellation, retry, crash recovery and replay; immutable attempts; provider/adapter timeouts. Browser checks cover hydration, contrast, icons, layout, keyboard, clipboard, composer, viewer and copying. | Schema, admission, spend, maintenance, telemetry, UI-state and projection unit checks; basic run ownership in required auth. |
| `test:hosted-workflows-http:better-auth` / `serial-check` | All preceding Workflows and browser behavior with Better Auth sessions connected to real Workflow execution. | The same narrower unit and ownership checks. Required auth does not start a Workflows worker. |
| `test:hosted-media-http` / `serial-check` | Upload byte limits, hashes, sealing, failure cleanup and foreign-user denial; opaque/encrypted capabilities; retained R2 multipart uploads, concurrency, abort/delete/in-use/expiry/orphan handling and evidence provenance; janitor/seal races. Browser checks cover resume, tab locking, pagehide/discard/recovery, and retained versus ephemeral review. | Media-domain, seal/provider-budget, retention, evidence and range unit checks. |
| `check:hosted-auth` / `serial-check` | Real mail binding and HTTP fallback; magic-link cooldown/no-mail; uninvited mail/verification refusal; sign-in browser UX; stacked Access subject binding and rebind denial; misconfigured auth modes refusing hosted routes; shared workerd rate-limit warnings. | GitHub login, approved/unapproved sessions and basic ownership in required auth; policy and client-IP rate-limit unit checks. |
| `check:e2e` hosted projects / `serial-check` | Access and Better Auth composer publication journeys; database-trigger-induced publication rollback across registry/run/item tables; validation before projection. Partial publication can escape the PR checks. | Required browser smoke; D1/SQLite projection and migration tests. |
| `check:e2e` adversarial project / `serial-check` | Foreign-user denial for every hosted ID; service callers denied browser routes; uninvited sign-in/mail boundaries; recurring upload byte-limit probes; adversarial maintenance preservation, spike-matcher and support-trap fixtures. | Some pure support-format, middleware-matcher and maintenance unit checks, without equivalent hosted/browser execution. |
| `rehearse:hosted-release` / `serial-check` | Emitted entry determinism/delegation and no body reads; required/forbidden bundle markers; Worker bindings, configuration, auth mode and secret shape; both module dry-runs and absence of error 100329; previous-artifact rollback dry-run and rollback documentation. | Required migration application/replay; SQLite import byte stability and migration cases (including provider identity and legacy protection); real local D1 projection tests. Generic migration failure detection remains required. |

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

Zod is bundled through Nuxt's `build.transpile` option so cached SSR chunks do
not import locale files from a checkout's Bun package store. To test relocation,
use two checkouts with identical sources and one private cache under the home
directory. Invoke `bun --no-env-file scripts/run-check-lane.ts local build:cli
build:web test:studio-http spike:studio-streaming` from each with the same
`PATH`, `HOME`, `TMPDIR`, and `CI`; require `build=CACHED` on the second run.
The `bun run` wrapper adds checkout-specific entries to `PATH`, which can make
two otherwise identical checkouts build different cache entries.

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
