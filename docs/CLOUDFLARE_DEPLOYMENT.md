# Cloudflare Deployment and Access Runbook

## Outcome

This runbook deploys the Nuxt SSR workspace to Cloudflare Workers with:

- D1 bound as `DB`;
- a custom hostname;
- Cloudflare Access protecting the whole hostname;
- application-level validation of `Cf-Access-Jwt-Assertion`;
- no public meeting-data route;
- no provider credential returned to browser code; and
- `GEMINI_API_KEY` as the only Tier A secret, installed on both the public
  session-minting Worker and internal Workflows Worker.

The repository does not auto-deploy. Deployment is an operator action.

Status as of 2026-08-23: hosted creation remains dark and undeployed. Phases
1–5 and Phase 6 release-preparation artifacts are contract-tested. ADR 0018
Amendment 2 and direct-upload Tasks 2.1–2.4 are implemented; every production
deployment gate remains pending. The exact checklist lives in the
[Hosted Studio plan](../conductor/tracks/hosted-studio_20260822/plan.md), and
the data handled by any deployment is classified in
[DATA_CLASSIFICATION.md](DATA_CLASSIFICATION.md).

## Hosted Studio (dark release shape)

The proposed [Hosted Studio track](../conductor/tracks/hosted-studio_20260822/)
extends this same hostname and Access boundary with principal-scoped creation,
D1 job state, Cloudflare Workflows, and direct browser-to-Gemini uploads. The
production artifact and binding shape are prepared but not deployed, and the
hosted routes remain 404-dark by default. Tier A adds `GEMINI_API_KEY` as the
only Tier A secret and is installed on both Workers; provider connections and
their separate encryption KEK remain Tier B.

Task 3.0 selected a sibling, internal-only Workflows Worker because pinned
Nitro 2.13.4 has no supported `WorkflowEntrypoint` export seam. The Nuxt Worker
will call it through a service binding while remaining the only public Worker
on the Access hostname. The target Workflows Worker deploys first; the Nuxt
caller binding deploys second. Access context does not propagate over the
binding, so the sibling must revalidate a bounded principal-scoped job receipt.
The passing local/dry-run proof is recorded in
[`docs/spikes/hosted-workflows-spike-2026-08-22.md`](spikes/hosted-workflows-spike-2026-08-22.md).

Tasks 2.1–4 implement that topology behind build and runtime flags. The
production Nuxt artifact contains the hosted implementation, but its runtime
flag defaults to false and hosted creation stays 404-dark. The generated
`hosted-entry.mjs` is a deterministic delegating main; it has no upload
interception or recording-byte logic. Before any future enablement, run:

```bash
bun run test:hosted-workflows-http
bun run test:hosted-media-http
```

The receipts must include `HOSTED_SPEND_CONTRACT PASSED`,
`HOSTED_MEDIA_CONTRACT PASSED`, and end with
`HOSTED_WORKFLOW_CONTRACT PASSED`, and show principal isolation, one provider
invocation across the simulated success-without-receipt crash, terminal
cleanup, linked retry deduplication, cap exhaustion before Workflow creation,
provider-usage reconciliation, and codes/structure-only telemetry rejection.
The media receipt must also contain `HOSTED_RETENTION_CONTRACT PASSED` and
`HOSTED_EVIDENCE_CONTRACT PASSED` with digest mismatch, expiry, delete,
orphan, principal-isolation, and capture-provenance refusals.

### Workflows Worker configuration shape

Copy `apps/workflows/wrangler.jsonc.example` to an ignored operator-owned
`wrangler.jsonc`, then replace only the placeholders with exact infrastructure
values. Never place a secret in either config. For the Phase 6 Tier A shape,
`GEMINI_API_KEY` is the only Tier A secret. Install the same value on the
public Worker (to mint/query/delete Files sessions) and sibling Worker (for
analysis):

```bash
node apps/web/node_modules/wrangler/bin/wrangler.js secret put GEMINI_API_KEY \
  --config apps/workflows/wrangler.jsonc
bunx wrangler secret put GEMINI_API_KEY --cwd apps/web --config wrangler.jsonc
```

The Workflows Worker shape is:

```json
{
  "name": "<INTERNAL_WORKFLOWS_WORKER>",
  "main": "src/index.ts",
  "workers_dev": false,
  "d1_databases": [{
    "binding": "DB",
    "database_name": "<D1_DATABASE_NAME>",
    "database_id": "<D1_DATABASE_ID>"
  }],
  "workflows": [{
    "binding": "HOSTED_WORKFLOW",
    "name": "<WORKFLOW_NAME>",
    "class_name": "HostedAnalysisWorkflow"
  }]
}
```

`workers_dev` must stay `false`: Wrangler defaults it to `true` when a Worker has
no routes, which would publish the Workflows Worker on `*.workers.dev`. The
Workflows Worker has no Access check of its own and must only be reachable
through the Nuxt Worker's `HOSTED_WORKFLOWS` service binding. The release
rehearsal fails if either committed example config drops this setting.

The committed `apps/web/wrangler.jsonc.example` remains the predeployment base
shape, including module entry, Workers Assets, D1, and the service binding:

```json
{
  "main": ".output/server/hosted-entry.mjs",
  "assets": {
    "directory": ".output/public",
    "binding": "ASSETS"
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "<D1_DATABASE_NAME>",
    "database_id": "<D1_DATABASE_ID>"
  }],
  "services": [{
    "binding": "HOSTED_WORKFLOWS",
    "service": "<INTERNAL_WORKFLOWS_WORKER>"
  }],
  "vars": {
    "NUXT_HOSTED_WORKFLOWS_ENABLED": "false"
  }
}
```

The public Worker accepts these non-secret media policy variables. Omit them
to use the defaults:

| Variable | Default | Purpose |
|---|---:|---|
| `NUXT_HOSTED_MEDIA_OPEN_SESSION_CAP` | `2` | maximum unsealed sessions per principal |
| `NUXT_HOSTED_MEDIA_MAX_BYTES` | `2147483648` | declared per-recording ceiling (2 GiB) |
| `NUXT_HOSTED_MEDIA_SESSION_TTL_SECONDS` | `3600` | pending capability lifetime; cannot exceed seven days |
| `NUXT_HOSTED_MEDIA_RETENTION_DAYS` | `30` | visible retained-media lifetime; maximum 365 days |

### Private retained-media R2 shape

Task 5.1 adds one private R2 binding to the public Nuxt Worker. Keep the bucket
without a public custom domain or `r2.dev` exposure. The operator-owned config
uses placeholders only:

```json
{
  "r2_buckets": [{
    "binding": "RETAINED_MEDIA",
    "bucket_name": "<PRIVATE_RETAINED_MEDIA_BUCKET>"
  }]
}
```

Configure the bucket lifecycle outside Git with a deletion rule matching the
application `NUXT_HOSTED_MEDIA_RETENTION_DAYS` value (30 days by default) and
an incomplete-multipart abort rule no longer than seven days. R2 lifecycle is
a storage backstop and may apply asynchronously; the application janitor and
explicit owner delete route remain the user-visible deletion mechanism. Verify
the rules with `wrangler r2 bucket lifecycle list <bucket>` without pasting the
bucket identifier into repository receipts.

The browser never receives R2 account credentials. For retained mode the
Worker creates a multipart upload through the binding and returns a random,
principal-authenticated capability whose SHA-256—not plaintext—is stored in
D1. Each request is fixed-length streamed to R2, and completion consumes the
capability. Before R2 reads a part, one conditional D1 update reserves its
`Content-Length` against both the session's cumulative uploaded bytes and the
declared/configured ceilings; concurrent parts therefore cannot overshoot.
A failed R2 write releases that reservation. Seal then reads the completed
object and requires its complete size and SHA-256 to match the browser
declaration and Gemini file. Object keys use a hashed principal prefix plus a
random UUID and are never returned by a public API. Evidence PNGs use the same
private bucket and a separate random key; D1 stores only the evidence digest
and manifest/recording/timestamp provenance.

The browser receives no key. It receives one provider-scoped capability only
after the D1 cap reservation commits. D1 stores that URL as principal/media-
bound AES-GCM ciphertext.

Deploy order is deliberate: apply migrations through
`0008_hosted_retention_evidence.sql`,
deploy the sibling Workflows Worker, verify its bindings, then deploy the Nuxt
caller with the service binding. Enabling hosted routes is a later reviewed
release task; do not set its flags during this dark Phase 3 deployment shape.

Hosted telemetry remains disabled for the Tier A release shape because adding
`SENTRY_DSN` would violate the one-secret gate. Never set a telemetry secret
on the public Nuxt Worker. Spend-policy runtime values and their safe defaults
are documented in
[RUNBOOK.md](RUNBOOK.md#hosted-spend-and-telemetry-controls-dark).

The Cloudflare build uses Nitro's module-format `cloudflare_module` preset.
The legacy `cloudflare-worker` service-worker preset is incompatible with
module-bound D1 and produced Wrangler deploy error 100329. Verified Wrangler
output for this deployment shape identifies the module entrypoint, Workers
Assets, and the D1 `DB` binding; hosted implementation must additionally show
the Nuxt service binding and the sibling Workflows binding in separate dry-run
receipts before release. Neither may report 100329.

Run the complete local release rehearsal before any operator action:

```bash
bun run rehearse:hosted-release
```

It builds the previous review-only and current hosted artifacts, applies D1
migrations `0001` through `0008` to an isolated local clone and replays them as
an idempotent no-op, validates both Worker binding graphs, scans the boundary,
runs the local byte-stability import regression, and dry-runs both the current
and previous artifacts. Success ends with `HOSTED_RELEASE_REHEARSAL PASSED`.
The 2026-08-22 baseline completes in under 60 seconds on the maintainer
workstation, so it is part of `bun run check`.

### Direct-upload ceiling

The recording request body goes browser → Gemini, so the Cloudflare zone
request-body ceiling does not bound recordings. Record and review the
application `NUXT_HOSTED_MEDIA_MAX_BYTES` value instead. Stop if it exceeds
the current provider Files API limit or the product policy approved for the
tenant.

## Security model

```mermaid
sequenceDiagram
    actor User
    participant Access as Cloudflare Access
    participant Worker as Nuxt Worker
    participant JWKS as Access JWKS
    participant D1

    User->>Access: Request custom hostname
    Access->>User: Identity challenge
    User->>Access: Approved identity
    Access->>Worker: Request plus Cf-Access-Jwt-Assertion
    Worker->>JWKS: Resolve rotating signing key
    JWKS-->>Worker: JWK set
    Worker->>Worker: Verify signature, issuer, audience, RS256
    Worker->>D1: Read or import validated projection
    D1-->>Worker: Run data
    Worker-->>User: SSR/API response
```

Access is the identity-aware proxy. The Worker still validates the JWT.
Cloudflare explicitly recommends validating the header because a Worker may
also be reachable through another route.

References:

- [Nuxt on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/nuxt/)
- [D1 bindings](https://developers.cloudflare.com/d1/worker-api/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
- [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

## Prerequisites

- Bun 1.3.14 or newer;
- a Cloudflare account with Workers and D1;
- a domain in the same account or a routable custom hostname;
- a Cloudflare Zero Trust organization;
- an identity provider configured in Zero Trust;
- Wrangler authentication for the intended account;
- authority to create a D1 database, Worker, DNS route, and Access application.

Do not reuse an unrelated account token. Confirm the active account before
creating resources.

## 1. Verify the source tree

From the repository root:

```bash
bun install --frozen-lockfile
bun run test:web
bun run typecheck:web
bun run build:web:cloudflare
```

The expected Worker entrypoint is:

```text
apps/web/.output/server/hosted-entry.mjs
```

The expected static assets are:

```text
apps/web/.output/public
```

## 2. Authenticate Wrangler

```bash
bunx wrangler whoami
```

If necessary:

```bash
bunx wrangler login
```

Verify the account name and ID before continuing.

## 3. Create the D1 database

```bash
bunx wrangler d1 create frame-of-mind
```

Record the returned database ID. It is infrastructure metadata, not an API
secret, but do not invent or truncate it.

## 4. Create the local Wrangler configuration

```bash
cp apps/web/wrangler.jsonc.example apps/web/wrangler.jsonc
```

`apps/web/wrangler.jsonc` is ignored so each operator can use a separate account
and hostname.

Edit these values:

| Field | Value |
|---|---|
| `routes[0].pattern` | dedicated custom hostname |
| `database_id` | exact ID returned by D1 create |
| `NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` |
| `NUXT_CLOUDFLARE_ACCESS_AUD` | Access application audience from step 6 |
| `services[0].service` | exact internal Workflows Worker name |

Keep:

```json
"NUXT_AUTH_MODE": "cloudflare-access",
"NUXT_HOSTED_WORKFLOWS_ENABLED": "false"
```

If the audience or team domain is missing, the application fails closed.

Proposed ADR 0019 also permits `better-auth` or
`cloudflare-access+better-auth`. These modes are spike-proven but not the
committed production default. They additionally require:

- migration `0006_better_auth.sql` on the public Worker's D1 database;
- `NUXT_BETTER_AUTH_URL` set to the exact HTTPS custom origin;
- GitHub client ID and the HTTPS mailer origin as Worker variables; and
- `NUXT_BETTER_AUTH_SECRET`, `NUXT_BETTER_AUTH_GITHUB_CLIENT_SECRET`, and
  `NUXT_BETTER_AUTH_MAILER_KEY` set with `wrangler secret put` on the public
  Nuxt Worker only.

Use at least 32 random bytes for the Better Auth secret. Never put these
secrets in Wrangler JSON, the browser, or the internal Workflows Worker. The
stacked mode retains the Access domain/audience and policy in addition to all
Better Auth settings. The release rehearsal rejects unset and unknown hosted
auth modes.

## 5. Apply the D1 migration

Migration `0003_principal_scope.sql` is a fail-closed table rebuild. It adds
`principal_sub` and display-only `principal_email` to both run tables, both
item tables, and the registry, then installs composite ownership keys and
indexes. Wrangler supplies the migration transaction; D1 does not allow an
explicit `BEGIN`/`COMMIT` inside the migration file.

Before applying it, confirm the projection tables are empty. If any legacy row
exists, the migration intentionally stops with:

```text
CHECK constraint failed: principal_scope_requires_empty_legacy_tables
```

That message means ownership must be reviewed by an operator. Do not delete
rows, substitute email for `sub`, or bypass the guard. Restore the pre-migration
state if needed, produce a reviewed old-sub/new-sub ownership receipt, and only
then prepare a separate assignment migration. Production is expected to be
empty for Slice 1, but the migration never assumes that fact.

Test against Wrangler's local D1 first:

```bash
bunx wrangler d1 migrations apply frame-of-mind \
  --local \
  --config apps/web/wrangler.jsonc
```

Inspect migration status:

```bash
bunx wrangler d1 migrations list frame-of-mind \
  --local \
  --config apps/web/wrangler.jsonc
```

Apply to the remote database only after the local command succeeds:

```bash
bunx wrangler d1 migrations apply frame-of-mind \
  --remote \
  --config apps/web/wrangler.jsonc
```

Wrangler defaults have changed historically. Always spell out `--local` or
`--remote`.

Run the built-Worker two-principal stop/go before the remote apply:

```bash
bun run test:hosted-access-http
```

The final receipt must include `HOSTED_ACCESS_CONTRACT PASSED`, isolated list
and 404 detail lines for both principals, a 409 `run_principal_conflict`, and
403 denials for both a service principal and a missing assertion. The contract
also applies all migrations twice against an empty local D1 and proves hosted
creation remains 404-dark.

After migration, verify no sentinel survived:

```bash
bunx wrangler d1 execute frame-of-mind \
  --remote \
  --config apps/web/wrangler.jsonc \
  --command "SELECT (SELECT count(*) FROM analysis_runs WHERE principal_sub = '__legacy_unclaimed__') + (SELECT count(*) FROM analysis_items WHERE principal_sub = '__legacy_unclaimed__') + (SELECT count(*) FROM analysis_run_registry WHERE principal_sub = '__legacy_unclaimed__') + (SELECT count(*) FROM video_analysis_runs WHERE principal_sub = '__legacy_unclaimed__') + (SELECT count(*) FROM video_analysis_items WHERE principal_sub = '__legacy_unclaimed__') AS sentinel_rows"
```

Stop unless `sentinel_rows` is exactly `0`. Then verify with two real allowlisted
user sessions: each list contains only its own imported run, foreign detail is
404, a reused foreign run ID is 409 `run_principal_conflict`, and
`GET /api/session` exposes display email but no `sub` or principal.

## 6. Create the Access application

In Cloudflare Zero Trust:

1. Open **Access controls → Applications**.
2. Create a **Self-hosted** application.
3. Enter the exact custom hostname from Wrangler.
4. Protect the root path so every page and API route is covered.
5. Add a narrow **Allow** policy:
   - specific email addresses, or
   - a controlled identity-provider group.
6. Add Require rules such as device posture when appropriate.
7. Do not add an Everyone Bypass policy.
8. Save the application.
9. Open its additional settings.
10. Copy the exact Application Audience (AUD) tag into the local
    `wrangler.jsonc`.

An email-domain Allow rule is broader than a named group. Choose the smallest
population that needs meeting-derived analyses.

## 7. Build and deploy

Build from the repository root:

```bash
bun run build:web:cloudflare
```

That command sets `NITRO_PRESET=cloudflare_module`; do not substitute the
legacy `cloudflare-worker` preset. It also emits `hosted-entry.mjs`
deterministically and runs the AD-11 artifact gate.

Before a deploy, produce both module dry-run receipts without contacting the
deployment API:

```bash
bunx wrangler deploy --dry-run --outdir "<PRIVATE_TEMP_DIRECTORY>/fom-public-bundle" \
  --cwd apps/web --config wrangler.jsonc
node apps/web/node_modules/wrangler/bin/wrangler.js deploy \
  --dry-run --outdir "<PRIVATE_TEMP_DIRECTORY>/fom-workflow-bundle" \
  --config apps/workflows/wrangler.jsonc
```

The public receipt must name `hosted-entry.mjs`, `ASSETS`, `DB`, and
`HOSTED_WORKFLOWS`; the sibling receipt must name `DB` and `HOSTED_WORKFLOW`.
Stop if either includes error `100329`.

Deploy from `apps/web` so Wrangler paths match the configuration:

```bash
bunx wrangler deploy --cwd apps/web --config wrangler.jsonc
```

Neither Worker bundle contains a secret literal. The public and internal
Workers each receive the same `GEMINI_API_KEY` through Wrangler's secret store;
Granola, Bluedot, Asana, and telemetry secrets remain absent in Tier A.

## 8. Verify fail-closed behavior

### Direct unauthenticated request

```bash
curl -i "https://frame-of-mind.example.com/api/health"
```

Expect an Access redirect or denial, not JSON run data.

### Browser identity

1. Open the custom hostname in a private browser window.
2. Complete the configured identity challenge.
3. Verify the header shows the authenticated email.
4. Open Runs and Import.
5. Import a non-sensitive test fixture.
6. Verify the run list and detail page.

### Wrong audience

Temporarily use an invalid audience in a non-production test deployment. An
otherwise valid Access token must receive 403 from the application.

### Direct Worker route

If a `workers.dev` route exists, request it directly. The in-application JWT
gate must return 403 because Access did not add a valid assertion.

## 9. Import production data deliberately

Use the browser import page after authentication. Import only reviewed bundles
that are approved for the hosted workspace.

Do not bulk-upload a local runs directory. The absence of automatic sync is a
privacy feature in the current release.

## 10. Operations

### Logs

Worker logs may include route, status, and sanitized errors. Do not add request
body logging, JWT logging, analysis logging, or D1 row logging.

### Key rotation

The application uses the Access JWKS endpoint through `jose`; it does not pin a
single certificate. Cloudflare rotates signing keys, so remote JWKS resolution
prevents manual certificate drift.

### Database backup

Before a migration:

```bash
bunx wrangler d1 export frame-of-mind \
  --remote \
  --output "/private/backup/frame-of-mind.sql" \
  --config apps/web/wrangler.jsonc
```

Treat the export as sensitive meeting-derived data. Store it outside the
repository.

### Hosted retention and exact-run purge

D1 stores the complete validated `analysis.json` projection, including accepted
and rejected summaries, UI excerpts, and meeting quotes. It does not store the
recording, transcript, screenshots, provider payload, or credentials.

Imports enforce the v2 analysis/manifest digest and same-origin JSON mutation
policy before touching D1. Item rows use one or more byte-bounded
`json_each(?)` parameters, so the atomic batch uses a bounded number of
statements rather than one query per finding. The projected run row is capped
at 1.8 MB and each expansion parameter at 900 KB. Run browsing selects summary
columns and uses a maximum page size of 100 with a stable keyset cursor; it
never scans every JSON blob into Worker memory.

Before deploying, the workspace owner must choose and document a retention
period. Thirty days is the recommended starting point for a review workspace
unless policy or an active work item requires less or more. The current
release does not automate completed-projection expiry.

To purge one reviewed run, first copy its exact route-safe run ID from the UI
and resolve the owning `principal_sub` privately from D1. Display email may
help select the candidate but is never ownership authority. Validate and
preview the composite key before deletion:

```bash
FOM_PRINCIPAL_SUB="<EXACT_ACCESS_SUB>"
FOM_RUN_ID="<EXACT_RUN_ID>"
case "$FOM_PRINCIPAL_SUB" in
  ""|*[!a-zA-Z0-9._:@/-]*)
    echo "Refusing an empty or unsafe principal" >&2
    exit 1
    ;;
esac
case "$FOM_RUN_ID" in
  ""|*[!a-zA-Z0-9._:-]*)
    echo "Refusing an empty or unsafe run ID" >&2
    exit 1
    ;;
esac

bunx wrangler d1 execute frame-of-mind \
  --remote \
  --config apps/web/wrangler.jsonc \
  --command "SELECT principal_sub, run_id, schema_version FROM analysis_run_registry WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID';"
```

Stop if the preview does not identify exactly the intended run. Export a backup
when policy requires recovery, then delete both possible child families, the
registry row, and both possible parent families for that composite key:

```bash
bunx wrangler d1 execute frame-of-mind \
  --remote \
  --config apps/web/wrangler.jsonc \
  --command "DELETE FROM analysis_items WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID'; DELETE FROM video_analysis_items WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID'; DELETE FROM analysis_run_registry WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID'; DELETE FROM analysis_runs WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID'; DELETE FROM video_analysis_runs WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID';"
```

Verify that all five counts sum to zero:

```bash
bunx wrangler d1 execute frame-of-mind \
  --remote \
  --config apps/web/wrangler.jsonc \
  --command "SELECT (SELECT COUNT(*) FROM analysis_runs WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID') + (SELECT COUNT(*) FROM video_analysis_runs WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID') + (SELECT COUNT(*) FROM analysis_items WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID') + (SELECT COUNT(*) FROM video_analysis_items WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID') + (SELECT COUNT(*) FROM analysis_run_registry WHERE principal_sub = '$FOM_PRINCIPAL_SUB' AND run_id = '$FOM_RUN_ID') AS remaining_rows;"
```

Do not interpolate meeting titles, email addresses, or arbitrary strings into
these commands. D1 Time Travel or a reviewed export is the recovery path.

### Dependency updates

Before upgrading Nuxt, Nuxt UI, Wrangler, `jose`, Bun, or Workers types:

1. read current official documentation;
2. run local tests and typechecks;
3. build both Nitro targets;
4. verify JWT denial and success paths;
5. run a local D1 migration;
6. inspect the generated Worker entrypoint and asset paths.

## Rollback

Application rollback:

1. identify the last known-good Git tag or commit and recover its previous
   known-good artifact from the release receipt;
2. dry-run that exact artifact with its matching configuration;
3. deploy that exact output only after the dry-run names the expected module
   entry, Assets, D1, and service bindings without `100329`;
4. verify Access and API denial before importing data.

Database rollback:

- D1 has no down migrations; prefer a reviewed forward repair migration;
- before every remote migration, create a sensitive backup with
  `wrangler d1 export` as shown above and record its checksum outside the
  repository;
- when a schema rollback is unavoidable, create a replacement D1 database,
  restore the reviewed export into that empty database with
  `wrangler d1 execute <REPLACEMENT_DATABASE> --remote --file <EXPORT.sql>`,
  verify sentinel and row counts, then repoint both Worker `DB` bindings in one
  reviewed release; D1 Time Travel is the alternative when its recovery window
  covers the incident;
- never delete the D1 database as an application rollback;
- preserve the portable run bundles independently.

## Common failures

### Every request returns 403 after Access login

Check:

- exact team-domain origin, including `https://`;
- exact application AUD;
- custom hostname is attached to the same Access application;
- Worker variables use the `NUXT_` names in the template;
- system clock and Access session are valid.

### D1 binding is missing

Confirm the binding name is exactly `DB` and the Cloudflare build command was
used. The hosted adapter fails with 503 instead of silently creating local
storage.

### Tables do not exist

Apply all pending migrations through `0006_better_auth.sql` to the
same database ID bound to both Workers.
Check `wrangler d1 migrations list ... --remote`.

### Import is rejected

422 means contract or cross-file identity validation failed. 413 means the
payload exceeded 2 MiB. Do not raise limits until the retention and abuse model
is reviewed.

### Assets load but data routes fail

Static Workers Assets do not contain meeting data. Inspect Worker logs and the
D1 binding. Confirm the request reached the Worker and carried a validated
Access assertion.

## Managing who can sign in

Access membership lives in one Access **group** ("Frame of Mind testers") that
the application policy points at. Adding or removing a tester never edits the
policy. Use the compatibility CLI or the mode-aware CLI instead of the
dashboard:

```bash
export FRAME_OF_MIND_ACCESS_ENV=~/secrets/frameofmind/access.env   # token, account id, group id — never committed
bun scripts/access-users.ts list
bun scripts/access-users.ts add someone@example.com
bun scripts/access-users.ts remove someone@example.com
bun scripts/studio-users.ts --mode cloudflare-access list
```

The token needs `Access: Organizations, Identity Providers, and Groups: Edit`.
The CLI refuses to remove the last member. Login methods (Google, One-time PIN,
GitHub) are configured once as identity providers; membership is by email,
which works for any provider that returns a verified email.

Better Auth membership is an email invitation in D1, claimed by the first
successful user ID. It is membership authority, not row ownership:

```bash
export FRAME_OF_MIND_WRANGLER_CONFIG=apps/web/wrangler.jsonc
export FRAME_OF_MIND_D1_DATABASE=frame-of-mind
bun scripts/studio-users.ts --mode better-auth list
bun scripts/studio-users.ts --mode better-auth add someone@example.com
bun scripts/studio-users.ts --mode better-auth remove someone@example.com
```

These commands target remote D1 by default. In stacked mode, a person must be
present in both the Access group and the D1 invite list. Removing an invitation
does not reassign or delete existing `ba:<userId>` rows and is not by itself a
session revocation; account/session removal needs a separately reviewed
operator action.

## Cutover to `better-auth` with GitHub login (ADR 0019, accepted 2026-08-23)

Prerequisites already applied to production on 2026-08-23: migration
`0006_better_auth.sql`, the `NUXT_BETTER_AUTH_SECRET` Worker secret, and
invites for the maintainer's emails (`bun scripts/studio-users.ts --mode
better-auth add <email>`).

1. **GitHub OAuth App** (maintainer, GitHub → Settings → Developer settings →
   OAuth Apps → New): Homepage `https://fom.flickerventures.com`,
   Authorization callback URL
   `https://fom.flickerventures.com/api/auth/callback/github`. Put the values
   in an uncommitted file, e.g. `~/secrets/frameofmind/github-oauth.env`:
   `GITHUB_CLIENT_ID=…` and `GITHUB_CLIENT_SECRET=…`.
2. **Secrets + vars** (operator): `wrangler secret put
   NUXT_BETTER_AUTH_GITHUB_CLIENT_SECRET`; in `wrangler.jsonc` vars set
   `NUXT_BETTER_AUTH_GITHUB_CLIENT_ID`, `NUXT_BETTER_AUTH_URL=https://fom.flickerventures.com`,
   and `NUXT_AUTH_MODE=cloudflare-access+better-auth` (stacked) for the first deploy.
3. **Deploy stacked** and verify: Access still 302s anonymous traffic; behind
   Access, `/sign-in` shows "Continue with GitHub"; a sign-in with an invited
   email lands on the viewer with `GET /api/session` showing a `ba:` principal
   and the Access `sub` bound; an uninvited account is refused with
   `EMAIL_NOT_INVITED`.
4. **Flip**: set `NUXT_AUTH_MODE=better-auth`, deploy, then set the Access
   application policy to *bypass* (or delete the app) so anonymous traffic
   reaches the Worker's own sign-in page. Re-verify: anonymous `/api/runs`
   → 401/redirect to `/sign-in`, GitHub sign-in works, `access-users.ts` is
   no longer authoritative (membership is the D1 invite table).
5. Record the cutover in `work_log.md`.
