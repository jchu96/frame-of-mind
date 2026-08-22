# Data Classification and Repository Hygiene

## Purpose

Frame of Mind is public source code that processes private recordings. This
table defines what may enter the repository, where runtime data lives, how long
Frame of Mind keeps it, and who may see it. The portable run bundle remains the
completed-analysis authority; SQLite and D1 are projections, not permission to
publish their contents.

## Classification classes

| Class | Meaning | Repository rule |
|---|---|---|
| `public` | Deliberately publishable source, documentation, or synthetic test material with no participant or account data. | May be committed after the repository hygiene check passes. |
| `internal` | Sanitized operational metadata that is not meeting content but may identify a deployment, principal, job, or failure category. | Keep out of public examples unless replaced by fixed synthetic values; share only with authorized operators and maintainers. |
| `sensitive-runtime` | Credentials, recordings, transcripts, analyses, screenshots, or stores that contain or can reconstruct private evidence. | Never commit. Keep only in the authorized runtime/store and delete under the owning retention rule. |

## Public data table

| Data | Class | Where it lives | Retention | Who may see it | Contract evidence |
|---|---|---|---|---|---|
| Repository source, documentation, and synthetic fixtures | `public` | Git working tree and public Git history | Project history | Anyone | [repository check](../scripts/check-repo-hygiene.ts), [testing isolation](TESTING.md) |
| Operator-owned recordings | `sensitive-runtime` | Original operator path; optional private Local Studio staging; temporary Gemini Files upload during analysis | Original: operator policy. Local staged copy: selected expiry and terminal cleanup. Gemini copy: delete on terminal paths, provider expiry as backstop | Operator, authorized local process, and Gemini for the selected run | [ADR 0007](adr/0007-separate-media-job-and-run-lifecycles.md), [media tests](../apps/web/test/studio-media-staging.test.ts), [Gemini cleanup tests](../test/analysis-orchestrator.test.ts) |
| Staged media | `sensitive-runtime` | Per-user application-data staging outside the checkout; hosted upload storage does not ship yet | Ephemeral terminal cleanup or explicit one-hour/one-day/seven-day local retention; unified maintenance enforces expiry | Current local operator and Studio process | [local media implementation](../apps/web/server-local/studio-media/local-media-staging.ts), [maintenance tests](../apps/web/test/studio-maintenance.test.ts) |
| Full transcripts and context files | `sensitive-runtime` | Provider response memory or single-use local context staging; prompt memory during analysis | Provider policy; local context expires within one hour and is consumed after execution; no full transcript in the normal run bundle | Operator, authorized provider, local process, and Gemini when selected | [ADR 0011](adr/0011-ephemeral-local-context-staging.md), [context tests](../apps/web/test/local-context-staging.test.ts) |
| Analysis contracts, rendered reports, and screenshots | `sensitive-runtime` | Private run bundle; optional local SQLite or authorized hosted D1 projection; rendered HTML may embed screenshots | Operator/workspace policy; no automatic hosted expiry | Operator and explicitly authorized reviewers or hosted principals | [artifact boundary](ARCHITECTURE.md#47-artifact-store), [projection contract tests](../apps/web/test/contracts.test.ts) |
| Durable and operational receipts | `sensitive-runtime` | `manifest.json`, `analysis-outcome.json`, private media/context receipt files, operational SQLite, and opaque browser session hints | With the owning run, staged resource, job, or browser session; cleanup receipts remain for audit when deletion fails | Operator and authorized maintainers; a hosted principal may see only its own bounded receipt | [ADR 0007](adr/0007-separate-media-job-and-run-lifecycles.md), [support receipt tests](../apps/web/test/studio-support-receipt.test.ts) |
| API keys, OAuth tokens, encryption keys, and signed URLs | `sensitive-runtime` | Process environment or ignored `.env`, process memory, exact-resource private OAuth files, provider/browser memory, and—only for a reviewed hosted release—Cloudflare secret storage | Until process exit, explicit disconnect/revocation, URL expiry, or operator rotation | Credential owner and the exact authorized runtime/provider boundary | [credentials guide](CREDENTIALS.md), [ADR 0008](adr/0008-local-secret-resolution.md), [OAuth isolation tests](../test/oauth.test.ts) |
| Cloudflare Access identities (`sub`, service identity, display email) | `internal` | Validated request context and principal-scoped D1 ownership columns; email is display-only | Access session plus the owning D1 retention period | The authenticated principal and authorized deployment operators | [Access middleware tests](../apps/web/test/access.test.ts), [principal migration](../apps/web/db/migrations/0003_principal_scope.sql) |
| Telemetry codes and approved structural fields | `internal` | Process memory and, only when explicitly enabled, an operator-owned Sentry project; no telemetry payload is stored in run bundles or SQLite | Sentry project policy; none when `SENTRY_DSN` is absent | Authorized maintainers/operators for that Sentry project | [ADR 0017](adr/0017-opt-in-sentry-telemetry.md), [scrubber tests](../test/sentry-telemetry.test.ts) |
| D1 rows | `sensitive-runtime` | Principal-scoped hosted run projections and dark hosted operational tables | Workspace policy and exact-principal/exact-run purge; current automation does not expire completed projections | The owning Access principal and authorized Cloudflare operators | [D1 ownership tests](../apps/web/test/d1.test.ts), [deployment backup/purge](CLOUDFLARE_DEPLOYMENT.md#database-backup) |

Hosted recording upload is not available or deployed as of 2026-08-22. ADR
0018 proposes Worker-proxied Gemini transfer, while Amendment 1 in PR #65 would
adopt measured 4 MiB parts with no more than four concurrent parts per
principal. Private R2 remains only a fallback proposal. See the
[Hosted Studio track](../conductor/tracks/hosted-studio_20260822/).

## Repository hygiene gate

Run the working-tree check before every release:

```bash
bun run check:repo-hygiene
```

It scans tracked and non-ignored untracked files, including documentation,
fixtures, examples, and logs, for credential formats, token assignments,
signed URLs, email addresses, transcript-shaped lines, and committed
media/screenshot/database artifacts. Findings report only a path, line, and
pattern name; matched content is suppressed. Known-safe placeholders and
synthetic fixtures are allowlisted narrowly in the script.

The one-time full-history sweep uses the same rules plus the high-confidence
credential formats in that checker:

```bash
bun --no-env-file scripts/check-repo-hygiene.ts --history
```

The history command scans added patch lines across all refs and reports only
commit, path, and pattern name. A finding must be reviewed locally. If it is a
real credential or private runtime artifact, stop release work, rotate/revoke
the credential when applicable, and follow the repository owner's incident and
history-remediation procedure. Never paste the matched value into a status
file, issue, or chat.

The checker is a deterministic backstop, not a content-understanding system.
It cannot decide whether ordinary prose or pixels are private, so human review
is still required before adding fixtures, screenshots, examples, or logs.
