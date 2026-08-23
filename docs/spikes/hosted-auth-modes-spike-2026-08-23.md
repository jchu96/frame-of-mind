# Hosted authentication modes spike — 2026-08-23

## Outcome

**GO for a reviewed implementation; no deployment is authorized.** Better Auth
1.7.1 runs in the built Nuxt `cloudflare_module` Worker under workerd with the
direct D1 adapter. The app can preserve its one-principal middleware seam in
Access-only, Better-Auth-only, and stacked modes.

The critical runtime finding is that Nitro must leave `node:async_hooks`
external in Cloudflare builds. Its unenv `AsyncLocalStorage` shim clears the
store before an asynchronous Better Auth handler settles, producing
`No request state found`. With workerd's native module and `nodejs_compat`, the
same built artifact completes OAuth and session work.

## Executable receipts

`bun run check:hosted-auth` completed in under 30 seconds and printed:

```text
HOSTED_AUTH build=PASS cloudflare_module
HOSTED_AUTH migration=PASS range=0001..0006 replay=idempotent
HOSTED_AUTH github=PASS fake_provider browser_session=true
HOSTED_AUTH magic_link=PASS captured_mailer browser_session=true
HOSTED_AUTH magic_link_invite=PASS mailer_calls=0 verification_rows=0
HOSTED_AUTH membership=PASS unknown_email=EMAIL_NOT_INVITED
HOSTED_AUTH principal_seam=PASS namespace=ba two_principals=true
HOSTED_AUTH stacked=PASS access_required=true principal=better_auth access_sub_bound=true
HOSTED_AUTH stacked_rebind=PASS mismatch_denied=true
HOSTED_AUTH fail_closed=PASS hosted_enabled_unset=403 unknown=403
HOSTED_AUTH runtime=PASS workerd_d1=true
HOSTED_AUTH_SPIKE PASSED
```

The fake GitHub authorization/token/user server and captured magic-link mailer
contain no production client secret. Playwright performed both sign-ins against
the built Worker. Unknown email received only the sanitized
`EMAIL_NOT_INVITED` result and no session. Its magic-link request was rejected
before token storage and delivery: the captured mailer remained empty and D1
contained no matching verification row.

Better Auth 1.7.1 verifies a magic link with the session-minting
`GET /api/auth/magic-link/verify?token=...` endpoint and atomically consumes the
token on the first fetch. A mail scanner can therefore consume the link before
the intended browser. The proposed ADR records that residual risk explicitly;
this spike does not claim a scanner-resistant POST confirmation flow.

The existing two-principal contract ran with only its login credential fixture
switched and reproduced every `HOSTED_ACCESS` ownership/conflict/dark-route
receipt. The existing hosted Studio/Workflow/spend contract did the same and
reproduced `HOSTED_WORKFLOW browser=PASS`, principal isolation, cancellation,
retry, provider-crash, spend race, reconciliation, and all three terminal
contract PASS lines.

## Trust and migration findings

- D1 migration `0006_better_auth.sql` is additive and replay-idempotent.
- Invitations are normalized email rows and are claimed once by the created
  Better Auth user. The durable application principal is `ba:<userId>`.
- In stacked mode, Access must validate before any Better Auth endpoint and the
  first session binds the Access `sub` to the user row. A later login for the
  same user under a different Access `sub` returns
  `ACCESS_IDENTITY_MISMATCH`, creates no cookie, and leaves the single original
  session intact.
- Access JWT subjects beginning with `ba:` are rejected before principal
  binding, keeping the Access and Better Auth namespaces disjoint.
- Unset and unknown auth modes reject hosted-enabled routes and are refused by
  the release rehearsal.
- There are no production `principal_sub` rows to migrate. If that changes,
  ownership needs an explicit operator-reviewed ID mapping; email is not an
  ownership key.
- The public Nuxt Worker owns Better Auth, GitHub, and mailer secrets. The
  Gemini key remains only on the internal Workflows Worker.

No live Wrangler configuration was changed, no production row was written,
and no deployment was attempted. The proposed long-lived decision is
[ADR 0019](../adr/0019-pluggable-auth-modes.md).
