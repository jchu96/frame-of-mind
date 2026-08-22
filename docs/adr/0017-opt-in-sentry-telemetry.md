# ADR 0017: Make Sentry telemetry opt-in and codes-only

- Status: Accepted
- Date: 2026-08-22

## Invariant

Operational visibility must not turn private analysis inputs or outputs into a
second outbound data path.

## Context

Frame of Mind can fail in a long-running local Studio worker or in the CLI
after the terminal has scrolled past the relevant stage. Error telemetry can
make those failures visible, but ordinary Sentry defaults may include error
messages, stack-frame paths, request metadata, breadcrumbs, user data, and
other context that violates the local-first privacy contract.

## Decision

Sentry error telemetry is disabled unless the operator sets `SENTRY_DSN`.
Setting it opts the current Studio or CLI process in; leaving it empty is the
default. The Connections page shows **Telemetry — Off** or **On (Sentry)** and
links to the operating disclosure.

The only application metadata sent is:

- a sanitized error code;
- Studio job stage and opaque job ID when applicable;
- recipe ID and revision;
- model ID;
- elapsed duration;
- Studio or CLI version and mode;
- the SDK/runtime platform field.

Frame of Mind never sends transcripts, recordings, analysis output or
findings, file paths, filenames, provider meeting IDs, API keys or OAuth
tokens, request or response bodies, URLs with query strings, user email
addresses, or IP addresses.

Both SDKs use `sendDefaultPii: false`, `tracesSampleRate: 0`, no Replay,
profiling, feedback, or logs integration, and a shared `beforeSend` scrubber.
The scrubber accepts only code-shaped synthetic exception values, removes
stack frames, requests, users, extras, breadcrumbs, and non-allowlisted
tags/contexts, and drops an event when sensitive patterns are present. The CLI
uses `@sentry/bun`; the Nuxt client and server use `@sentry/nuxt` v10.

The current `@sentry/nuxt` v10 module is excluded from the Nitro
`cloudflare-worker` preset. Its server-config injection produces an IIFE
code-splitting build error with this repository's current Nuxt/Nitro versions.
The Cloudflare artifact gate proves the SDK configs, DSN marker, and telemetry
implementation are absent. Hosted client/server telemetry is deferred until a
Workers-compatible Nuxt SDK path passes that gate; local/node Studio and CLI
telemetry are the shipped surfaces.

## Disable telemetry

Remove `SENTRY_DSN` from the process environment and `.env`, then restart
Studio or rerun the CLI. The Connections page and `frameofmind doctor` both
report telemetry as off. Removing the DSN requires no database or artifact
migration because telemetry configuration and payloads are never persisted by
Frame of Mind.

## Consequences

Positive:

- local failures can be correlated by code, stage, and opaque job receipt;
- telemetry remains visibly off by default and reversible by removing one
  environment value;
- the same deterministic scrubber protects the browser, Nuxt server, worker,
  and CLI capture paths.

Costs:

- stack traces and human error messages are intentionally discarded, so
  diagnosis relies on local reproduction plus sanitized codes;
- operators must opt in independently on each machine or runtime;
- source-map upload, tracing, Replay, profiling, logs, and user feedback remain
  out of scope.

## Alternatives Considered

### Enable Sentry by default

Rejected because it would silently add an outbound processor to a local-first
tool.

### Rely on `sendDefaultPii: false` alone

Rejected because it does not enforce the repository's stricter prohibition on
transcripts, paths, filenames, request bodies, provider identifiers, or raw
error messages.

### Send stack traces after path rewriting

Deferred because filenames and frame metadata are not necessary for the first
codes-only operational signal.
