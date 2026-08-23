# ADR 0019: Make hosted authentication a pluggable perimeter

- Status: Proposed
- Date: 2026-08-23

## Invariant

One trusted middleware binds exactly one durable principal before any hosted
data or execution route runs. Every downstream table remains scoped by
`principal_sub`; provider email is display and membership data, never ownership
authority.

## Context

ADR 0018 assumed Cloudflare Access was both the outer perimeter and identity
provider. The hosted application also needs an app-owned identity option and a
stacked option where Access remains the outer entrance. The downstream data,
Workflow, spend, and publication contracts must not know which perimeter
proved the principal.

## Proposed Decision

`NUXT_AUTH_MODE` is explicit and accepts four modes:

| Mode | Anonymous request semantics | Bound principal |
|---|---|---|
| `off` | local/review behavior only; hosted-enabled routes fail closed | none |
| `cloudflare-access` | Access rejects anonymous traffic before the Worker in production; middleware still rejects a missing assertion | validated Access `sub` |
| `better-auth` | anonymous traffic reaches only the public Worker; auth endpoints may establish a session and every other protected route rejects it | `ba:<Better Auth user id>` |
| `cloudflare-access+better-auth` | Access must admit the request before the Worker and Better Auth must then establish a session | `ba:<Better Auth user id>` |

The stacked mode records the first validated Access `sub` on the Better Auth
user. Later attempts with a different `sub` fail closed. Access remains an
outer perimeter and is not the row owner. Access subjects beginning with
`ba:` are invalid so the Access and Better Auth principal namespaces cannot
overlap. The built-Worker proof records
`HOSTED_AUTH stacked_rebind=PASS mismatch_denied=true` after verifying that a
different Access subject creates neither a cookie nor a second session.

Better Auth uses the public Worker's D1 binding and migration
`0006_better_auth.sql`. Email invitations are principal-independent and are
claimed by the first admitted user ID. Email can admit a user but cannot
transfer an existing `principal_sub` row. A global Better Auth before-hook
checks that a magic-link email has a free invite or the matching claimed user
before the plugin writes verification state or calls the mailer; session
creation checks and claims it again to close the race.

Session cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` on HTTPS.
The session lasts seven days and carries a signed compact five-minute cookie
cache; revocation can therefore take up to five minutes to be observed by a
cached request. OAuth state and Better Auth's trusted-origin checks defend its
auth mutations. Application JSON mutations continue to require the exact
request `Origin` through the existing trusted-mutation guard.

Magic-link verification is the explicit exception to mutation-by-POST:
`GET /api/auth/magic-link/verify?token=...` atomically consumes the one-time
token on its first fetch and mints a session before redirecting. Email link
scanners and prefetchers can therefore consume the link before the person does.
The token expires after five minutes and cannot be replayed, but those controls
do not remove scanner consumption; a scanner-resistant confirmation POST is a
future production-hardening choice, not a property of this proposed design.

Secret custody is mode-specific:

- `cloudflare-access`: Access team domain and audience are public Worker
  configuration; Access policy and identity-provider credentials stay in
  Cloudflare.
- `better-auth`: `BETTER_AUTH_SECRET`, the GitHub OAuth client secret, and the
  mailer key belong only to the public Nuxt Worker. Their corresponding Nuxt
  runtime names are `NUXT_BETTER_AUTH_SECRET`,
  `NUXT_BETTER_AUTH_GITHUB_CLIENT_SECRET`, and
  `NUXT_BETTER_AUTH_MAILER_KEY`.
- stacked mode needs both sets.
- `GEMINI_API_KEY` remains Workflows-Worker-only in every mode.

Production currently has no principal-scoped rows. A future mode change may
therefore start with an empty projection. If rows exist at cutover, there is no
automatic Access-sub-to-Better-Auth migration: an operator must review an
explicit old/new principal assignment migration. Email must not be used as the
ownership join.

## Consequences

The principal seam and all downstream hosted contracts remain unchanged.
Operators gain app-owned, Access-only, and stacked deployment choices. The
public Worker now owns authentication tables and session-secret custody in
Better Auth modes, and D1 load includes session/invite operations. A five-minute
signed cookie cache reduces hot-path D1 reads but creates a bounded revocation
delay.

This ADR is proposed. The spike proves feasibility but does not authorize a
deployment, production migration, or change to the committed Wrangler mode.

## Alternatives Considered

Using email as `principal_sub` was rejected because providers can change or
recycle email and membership must not transfer ownership. Replacing Access
outright was rejected because deployments may still need its pre-Worker
perimeter. Treating Access and Better Auth as two independent principals was
rejected because every downstream record must have exactly one owner.
