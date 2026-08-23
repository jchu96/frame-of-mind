# Testing

Frame of Mind tests are layered around the product authority boundaries. A
portable run pair remains authoritative; test databases, browser state, and
Worker fixtures are disposable projections.

## Test layers

| Layer | Command | Owns |
|---|---|---|
| CLI/unit | `bun run test` | recipes, providers, contracts, orchestration |
| Web/unit | `bun run test:web` | SQLite/D1, Studio services, UI state modules |
| HTTP contracts | `bun run test:studio-http`, `bun run test:hosted-access-http`, `bun run test:hosted-workflows-http` | built server and Worker request contracts without browser control |
| Smoke E2E | `bun run test:e2e` | the 13 Local Studio browser journeys |
| Hosted E2E | `bun run test:e2e:hosted` | composer → activity → publication → viewer against built Nuxt and Workflows Workers |
| Adversarial E2E | `bun run test:e2e:adversarial` | recurring reviewer regressions tagged `@adversarial` |
| Canary | `bun run test:e2e:canary` | read-only checks against a deployed Access hostname |

`bun run test:e2e:all` selects every project. The canary prints a clear SKIP
when its deployment credentials are absent. `bun run check:e2e` selects hosted
and adversarial projects and is part of `bun run check`. CI uses
`bun run test:e2e:ci`, which adds smoke and fails on flaky retries.

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

The HTTP contract scripts retain their request assertions. They do not launch
or drive a browser.

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
mailer, and fake Gemini port. Provider calls remain offline.

Better Auth has a named Playwright project and a `HostedAuthMode` fixture seam.
When `apps/web/server/utils/better-auth.ts` is absent, that project skips with
the PR #75 reason rather than pretending the mode ran.

## Principals and sessions

Tests obtain identities from the hosted fixture:

```ts
const principalA = await hosted.session("a");
const principalB = await hosted.session("b");
const service = await hosted.session("service");
```

In Access mode these are short-lived RS256 JWTs signed by the fixture JWKS.
The session method is the single seam for adding Better Auth cookies when that
adapter lands. Never print the returned headers. Principal A and B deliberately
use different subjects so ID-sweep tests can distinguish ownership without
using real participant data.

## Click through hosted Studio locally

Run the long-lived local topology and leave it open while you drive the browser:

```bash
bun run hosted:local
```

It prints `HOSTED LOCAL http://127.0.0.1:<port>` and the synthetic GitHub user
`tester@example.test`, then stays up until Ctrl+C. It uses Better Auth, seeds
that invite, starts fake GitHub and Gemini services, and prints captured
fixture magic links. On a base where the Better Auth PR is not present, the
same command prints a clear skip reason and falls back to the Access helper so
the hosted Studio remains human-driveable. To select that path explicitly:

```bash
bun run hosted:local -- --mode cloudflare-access
```

The printed Access helper URL is a loopback reverse proxy that injects only the
generated principal-A assertion. Removing the `tester@example.test` invite
from the Better Auth seed is discriminating: the fake GitHub sign-in must end
with `EMAIL_NOT_INVITED`.

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
- the dark upload spike must retain slow-sink, over-length, and short-part
  receipts.

Review briefs should link this file and the exact spec rather than reconstruct
the boot sequence in prose.

## Deployed canary

The canary is read-only and not part of `bun run check`. Configure it only in a
release shell:

```bash
FRAME_OF_MIND_CANARY_URL="https://<hostname>" \
CF_ACCESS_CLIENT_ID="<service-token-id>" \
CF_ACCESS_CLIENT_SECRET="<service-token-secret>" \
bun run test:e2e:canary
```

It emits only `CANARY <check>=PASS|FAIL` receipts. Never commit or paste the
service-token values.
