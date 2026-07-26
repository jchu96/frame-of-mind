# ADR 0008: Keep new API secrets environment- or session-scoped

- Status: Accepted
- Date: 2026-07-26

## Invariant

A convenient settings page must not quietly turn a public local application
into a plaintext credential vault.

## Context

The CLI already reads Gemini and Granola API keys from the environment and
stores provider OAuth state in private exact-resource files. Studio needs to
show connection health and may accept a key interactively. A cross-platform OS
credential-vault integration would add native dependencies and materially
different macOS, Linux, and Windows behavior.

Writing a raw API key to a new JSON or SQLite setting would be easier but would
create an undocumented at-rest secret store.

## Decision

Phase A resolves credentials in this order:

1. approved environment or `.env` input loaded by the existing secret path;
2. a session-only value submitted through an authenticated local Studio route;
3. provider OAuth state through the existing exact-resource token store.

New Gemini and Granola API keys submitted in Studio live only in Bun process
memory:

- the server never returns the value;
- process restart removes it;
- logs and errors redact it;
- status reports only presence, source, and last verification outcome;
- disconnect clears only the session value unless the UI explicitly identifies
  an existing provider OAuth connection.

The Settings UI links to the documented environment setup for persistence.
There is no plaintext filesystem or SQLite fallback for new API keys.

A future OS credential-vault adapter requires its own cross-platform evaluation
and ADR. Existing OAuth token files remain governed by exact-resource binding,
private permissions, and provider refresh behavior.

## Consequences

Positive:

- Studio offers an interactive key path without inventing a plaintext vault;
- the current CLI and automation environment remain compatible;
- credential source and lifetime are understandable;
- a compromised run database contains no new API key material.

Costs:

- users who do not configure an environment key must re-enter it after restart;
- session-only validation and clearing need explicit UI;
- persistent GUI storage waits for a native credential-vault design.

## Alternatives Considered

### Store keys in SQLite or application JSON

Rejected because file permissions are not equivalent to a credential vault and
the database is a projection/runtime store.

### Require environment variables only

Rejected because it prevents a useful local configuration experience.

### Implement native OS vaults immediately

Deferred because macOS Keychain, Windows Credential Manager, and Linux Secret
Service need separate packaging, availability, migration, and recovery work.
