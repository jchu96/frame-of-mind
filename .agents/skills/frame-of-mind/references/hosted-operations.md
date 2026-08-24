# Hosted Operations Routing

Load this reference for access review, hosted status, spend controls, retained
media, deployment, migrations, or rollback. Repository runbooks remain the
authority; this file is a routing checklist.

## Before acting

1. Work from a clean authorized checkout.
2. Read the named runbook section for the task.
3. Confirm the target account, Worker configuration, D1 database, principal,
   and requested mutation without printing their private values.
4. Separate observation from mutation. Status inspection does not authorize
   approval, cap changes, purge, migration, or deployment.
5. Keep receipts structural: command, status code, stage, sanitized code, and
   cleanup state only.

## Access operations

The reference instance uses Better Auth. A verified GitHub identity may sign
in, but only an approved D1 membership binds a downstream principal. Magic
links are limited to approved members.

```bash
bun scripts/studio-users.ts --mode better-auth list
bun scripts/studio-users.ts --mode better-auth list-requests
bun scripts/studio-users.ts --mode better-auth add "<email-address>"
bun run approve "<email-address>"
bun scripts/studio-users.ts --mode better-auth deny "<email-address>"
bun scripts/studio-users.ts --mode better-auth remove "<email-address>"
```

- `add` pre-approves an email.
- `approve` moves requested or revoked membership to approved.
- `deny` moves a request to revoked.
- `remove` revokes an approved membership while preserving audit history.
- Membership changes are checked on the next request.

Read `docs/RUNBOOK.md` sections **Hosted authentication** and **Hosted access
administration**. Commands default to remote D1; confirm the ignored operator
configuration and database before mutation.

## Browser administration

`NUXT_MAINTAINER_EMAILS` is the only maintainer discriminator. It is a
deploy-time, normalized email allowlist, not a D1 role. The session must also
have approved membership. An empty allowlist keeps `/admin/access` and
`/api/admin/*` indistinguishable from unknown routes.

The page uses the same transition oracle as the CLI. It can approve, deny,
revoke, and re-approve; it cannot edit the maintainer allowlist or email a
requester. Changing maintainers requires operator configuration and a deploy.

## Hosted status

Use the authenticated **Activity** page to inspect durable stage, ordered
events, permitted actions, cleanup, and sanitized support code. Use
**Results** for published output. Do not infer progress or inspect D1 as a
routine status shortcut.

There is no agent-facing hosted API token or production API. Without the
authorized browser session, ask for a sanitized visible status or support
receipt. Never copy hosted analysis content into repository notes.

## Spend and retained media

Read `docs/RUNBOOK.md` section **Hosted spend and telemetry controls** before
changing caps or invoking janitors. Reservation is per principal and happens
before dispatch. Each real transport retry requires an atomic incremental D1
extension; cap exhaustion prevents the retry. Incomplete usage receipts settle
the full reservation rather than understating spend.

Retained media and evidence sidecars use private R2 with opaque,
principal-owned keys. Browser code receives no R2 credentials. Read
`docs/CLOUDFLARE_DEPLOYMENT.md` sections **Private retained-media R2 shape**
and **Hosted retention and exact-run purge** before retention or purge work.

## Deploy, migrate, and roll back

Follow, in order:

1. `docs/CLOUDFLARE_DEPLOYMENT.md` — **1. Verify the source tree**.
2. **5. Apply the D1 migration**; export D1 privately before schema change.
3. **7. Build and deploy**; deploy the internal Workflows Worker before the
   public Worker.
4. **8. Verify fail-closed behavior**.
5. `docs/RUNBOOK.md` — **Hosted release enablement and canary**.
6. `docs/CLOUDFLARE_DEPLOYMENT.md` — **Rollback** on any failed condition.

Run the relevant gate through `gate-lock`. Never deploy from a build command
alone, invent a down migration, expose a bucket publicly, or use `remote: true`
in a checked-in/test Wrangler configuration.

## Never include in receipts

Secrets, tokens, cookies, signed URLs, emails, IPs, transcripts, recordings,
analysis content, local paths, or principal/media/job/Workflow/Gemini/run IDs.
