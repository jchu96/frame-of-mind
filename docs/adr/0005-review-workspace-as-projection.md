# ADR 0005: Review workspace as a replaceable projection

- Status: Accepted
- Date: 2026-07-25

## Context

Frame of Mind produces portable run bundles. Colleagues also need a simple way
to browse runs without opening individual HTML files. The application must work
on one laptop and may later be hosted for a controlled group.

Making a database the only source would weaken portability and create a new
retention dependency. Automatically synchronizing every local run would also
cross a privacy boundary without an explicit operator decision.

## Decision

Add an optional Nuxt 4 SSR workspace with two build-time storage adapters:

- Bun SQLite for local use;
- Cloudflare D1 for hosted use.

The database is a projection of validated `analysis.json` and `manifest.json`.
Imports are explicit. The run bundle remains authoritative.

Hosted mode uses Cloudflare Workers and fails closed behind:

1. a Cloudflare Access application on the complete custom hostname;
2. application-level verification of the Access JWT signature, issuer, and
   audience.

The application does not store recording or screenshot bytes.

The first Frame of Mind MCP server is deferred. Its design will reuse the
read-only projection core through local stdio and a separate Cloudflare
Streamable HTTP Worker.

## Consequences

Positive:

- local operation needs no cloud account;
- hosted operation uses SQLite-compatible D1 semantics;
- loss of SQLite/D1 does not lose the only run copy;
- uploads into a team workspace are deliberate;
- UI and future MCP can share normalized query contracts;
- direct Worker routes remain denied without a valid Access assertion.

Costs:

- schema SQL has a local bootstrap and migration representation;
- hosted operators must configure D1, a custom hostname, Access, and audience;
- screenshots stay in the local bundle;
- there is no automatic local-to-cloud synchronization in v0.1.0;
- MCP remains a documented next iteration.

## Rejected alternatives

### Store all artifacts in D1

D1 is not blob storage, and embedding screenshots or recordings would create
cost, size, and retention problems.

### Auto-sync every completed run

This would convert local analysis into an implicit publishing action.

### Trust only the Cloudflare-injected email header

Headers can be spoofed on a bypass route. The Worker validates the signed JWT.

### Put local and hosted database drivers in one runtime bundle

`bun:sqlite` is not available in Workers. Build-time adapter selection keeps
each target free of the other runtime's dependency.

### Ship MCP in the first public release

The tool and authentication contracts need dogfooding. A narrow documented seam
is safer than an unverified public agent interface.
