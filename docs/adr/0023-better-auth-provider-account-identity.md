# ADR 0023: Preserve account ownership through the Better Auth security update

- Status: Accepted
- Date: 2026-11-12

## Invariant

Updating authentication must preserve existing user IDs and their `ba:<userId>`
ownership. Conflicting identities must fail closed instead of being merged.

## Context

Better Auth 1.7.7 fixes high and critical authentication advisories. Its
[upgrade guide](https://github.com/better-auth/better-auth/blob/v1.7.7/docs/content/docs/guides/1-7-upgrade-guide.mdx)
explains that releases after 1.7.2 identify accounts by `providerId` and
`accountId`, and no longer write the required `issuer` introduced in 1.7.0.
Our released migration 0006 requires that column, so a dependency-only update
would reject new OAuth accounts.

## Decision

Append migration 0013. Preserve every existing account column and value,
including legacy issuer metadata, while making issuer nullable and enforcing
uniqueness on `(provider_id, account_id)`. Duplicate legacy provider identities
abort the transaction for operator review. Never delete or merge them to make
the migration succeed. Keep the user foreign key and its deletion behavior.

Remove the retired `accountIssuer` option from the synthetic GitHub provider.
The supported production OAuth provider remains GitHub. Email verification,
membership approval, sessions, and downstream principal scoping retain their
existing contracts. No additional provider or account-linking feature is added.

## Operations and verification

Back up D1 and apply all migrations before deploying the patched application.
An application rollback to 1.7.2 also requires the reviewed pre-upgrade database
backup; the old issuer identity contract is not the upgraded contract.

Migration tests preserve populated rows, accept issuer-free inserts, reject
duplicate and orphan identities, verify cascading deletion, and prove atomic
refusal on ambiguous legacy rows. The built-Worker auth contracts exercise the
patched package with synthetic OAuth and D1.
