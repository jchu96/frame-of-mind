# ADR 0020: Separate sign-in from hosted access approval

- Status: Accepted — Jeremy's decision 2026-08-23, option B
- Date: 2026-08-23
- Amends: [ADR 0019](0019-pluggable-auth-modes.md)

## Invariant

Authentication may establish who a person is, but only an explicitly approved
membership may bind the durable principal that can read data, upload media,
start work, or spend provider capacity.

## Context

ADR 0019 used an invitation as both the prerequisite for authentication and
the membership decision. That keeps unknown accounts out, but it also makes
access requests an off-product coordination problem. Registration itself is
free; the costly and sensitive boundary begins only when an authenticated
principal reaches run, hosted-job, media, Gemini, or R2 paths.

An open request flow must not become an email relay. In particular, a request
may send one bounded notification to the configured maintainer and must not
send a message to the requester, accept requester-authored message content, or
contain an approval link.

## Decision

Better Auth sign-in is open. GitHub may create an account and session for any
verified provider identity. Magic-link delivery remains limited to approved,
already-known membership rows so an anonymous caller cannot make the service
email arbitrary recipients.

`hosted_auth_invites` remains the membership authority and gains:

- `state`: `requested`, `approved`, or `revoked`;
- `requested_at`;
- `approved_at`; and
- `decided_by`.

Migration `0010_access_requests.sql` backfills every existing row as approved,
with `approved_at` inherited from `invited_at`. Existing users are therefore
unaffected.

Every Better Auth request still enters the one global authentication
middleware. The middleware resolves membership after validating the session
and binds `frameOfMindPrincipal` only for `state='approved'`. A session without
approved membership may reach only `/api/session`, `/request-access`, and the
idempotent access-request mutation. Protected pages redirect to
`/request-access`; protected APIs return 403. This occurs before run storage,
hosted composer, media, Gemini, Workflow, spend, or R2 code can run.

The request mutation creates one `requested` row claimed by the authenticated
Better Auth user. It is rate-limited by an HMAC-keyed per-IP D1 bucket, and a
row that already exists makes the operation a no-op. Only the first insert may
send one maintainer notification through the configured mailer transport. The
message contains the normalized requester email and the exact local command:

```bash
bun run approve '<email>'
```

There is no clickable approval URL. If `NUXT_ACCESS_REQUEST_NOTIFY` is absent,
or notification delivery fails, the request remains recorded. Approval is an
operator-only D1 state transition through `studio-users.ts`; denial records
`revoked` rather than deleting the audit row. `add` remains the pre-approval
invitation command.

## Consequences

Unknown GitHub identities can authenticate without gaining a data or execution
principal. Revocation and approval are observed on the next request because
membership is checked at middleware rather than trusted from the session
cookie cache. The public Worker stores a small rate-limit projection and may
send one maintainer email per principal request. The internal Workflows Worker
and all downstream principal-scoped contracts remain unchanged.

An email delivery failure can leave a recorded request without a notification;
operators can recover it with `list-requests`. This is preferable to either
rolling back the user's request or allowing repeated notification sends.

## Alternatives considered

Keeping invite-only authentication was rejected because it cannot provide a
self-serve request path. Automatically approving authenticated GitHub users
was rejected because authentication is not authorization and would expose
spend and private projections. Approval links in email were rejected because
they create a second auth-bearing control path. Sending request confirmation
or magic-link email to an unknown requester was rejected because it would make
the public endpoint an outbound-email primitive.
