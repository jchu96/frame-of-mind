# ADR 0021: Gate the admin approval surface with a deploy-time maintainer allowlist

- Status: Accepted
- Date: 2026-08-24

## Invariant

The web application may exercise reviewed membership transitions, but it must
never acquire the authority to decide who is a maintainer. Maintainer identity
stays in operator-controlled deployment configuration, outside D1 and outside
every browser mutation.

## Context

ADR 0020 separated authentication from hosted membership and kept approval in
the operator CLI. That boundary is safe but makes routine request review
unnecessarily dependent on terminal access. A small deployment may expose the
same state machine to known maintainers without introducing roles, permissions
tables, invitations to an admin role, or another identity authority.

The access-request rule from ADR 0020 remains unchanged: approval does not send
email to the requester.

## Decision

`NUXT_MAINTAINER_EMAILS` is the sole maintainer discriminator. It is a
comma-separated deployment variable parsed by trimming entries, lowercasing
them, removing empty entries, and comparing exact normalized email strings.
Unset, empty, or whitespace-only configuration yields zero maintainers and a
dark admin surface.

The global `00.auth` middleware may bind `frameOfMindMaintainer` only after a
Better Auth session has resolved to an approved `frameOfMindPrincipal`, and
only when that session's normalized email appears in the allowlist. It never
binds the capability for an unapproved session, an Access-only identity, or a
service principal. The web surface contains no route that changes the
allowlist. Changing who is a maintainer requires an operator configuration
change and deployment; the CLI remains the authoritative recovery path and
the only application workflow involved in that operator change.

Requests without `frameOfMindMaintainer` receive the same 404 representation
as an unknown route for `/admin/access` and every `/api/admin/*` method. The
session DTO exposes only `maintainer: true` to an allowlisted maintainer so the
hosted navigation can add the link; non-maintainers receive neither the flag
nor the link.

The bounded admin surface is:

- `GET /api/admin/access`, returning at most 500 membership rows grouped as
  requested, approved, and revoked with invitation and approval timestamps;
- `POST /api/admin/access/approve`, permitting requested or revoked to become
  approved;
- `POST /api/admin/access/deny`, permitting requested to become revoked; and
- `POST /api/admin/access/revoke`, permitting approved to become revoked while
  refusing the last approved member.

Replays that already have the requested final state are successful and report
that they were idempotent. The CLI and HTTP handlers call one shared transition
oracle. Conditional updates preserve the last-member refusal under concurrent
requests. The page additionally disables self-revocation; the server enforces
the same rule. Migration `0011_admin_access.sql` adds `actioned_by` and
`actioned_at`. HTTP actions record the normalized maintainer email and current
timestamp; CLI actions record `cli`. Existing `decided_by` remains populated
for compatibility.

Admin mutations require JSON plus both an exact same-origin `Origin` and
`Sec-Fetch-Site: same-origin`. Missing headers fail closed. The current Better
Auth configuration was confirmed as `HttpOnly`, `SameSite=Lax`, `Path=/`, and
`Secure` on HTTPS. SameSite=Lax is defense in depth, not the admin CSRF oracle;
the explicit origin and Fetch Metadata checks remain mandatory.

No approve, deny, revoke, or re-approve path calls the mailer. ADR 0020's
maintainer-only request notification is unchanged and no requester email is
introduced.

## Consequences

Maintainers can review ordinary access changes in the hosted UI while the
deployment remains the only source of maintainer authority. An empty or
mistyped allowlist deliberately makes the admin surface disappear; recovery is
an operator config/deploy correction or the existing CLI. Membership actions
gain a durable actor/timestamp audit, but D1 still does not contain roles.

The allowlist must be kept synchronized with approved membership. Revoking an
allowlisted person's ordinary membership removes the principal and therefore
their maintainer capability even though the deployment value remains present.

## Alternatives Considered

A D1 role or maintainer table was rejected because a compromised admin surface
could then mint another maintainer. Reusing approved membership as maintainer
authority was rejected because it grants every member administrative power.
Keeping all transitions CLI-only was safe but did not meet the routine review
need. Sending approval email was rejected by ADR 0020's explicit privacy and
product decision.
