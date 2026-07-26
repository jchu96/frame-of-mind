# Workflow

## TDD Policy

Strictness: **moderate**.

- Write contract, state-machine, security, storage, and server-route tests
  before their implementation.
- Component behavior may be developed with focused tests alongside the
  implementation.
- Every reproduced failure receives a regression test.
- Target at least 80 percent coverage for newly introduced domain and server
  modules; visual layout code is verified through behavior and end-to-end
  flows rather than line coverage alone.

## Commit Conventions

- Use Conventional Commits.
- Make one implementation commit per Conductor task when practical.
- Include the track ID in task commits:
  `feat: persist analysis jobs (local-studio_20260726)`.
- Commit plan-marker and metadata updates with the task they describe or in a
  dedicated `chore:` commit.
- AI-authored commits include the repository-required co-author attribution.
- Never commit credentials, recordings, transcripts, analyses, or local
  databases.

## Review Gates

- Review trust-boundary changes adversarially.
- Re-ground security and data-integrity findings against the actual base diff.
- Require explicit review for:
  - secret storage or credential APIs;
  - recording staging and deletion;
  - job cancellation or recovery;
  - durable schema changes;
  - Cloudflare Access, D1, or future R2 behavior.
- Keep external publishing out of the local Studio track.

## Verification Checkpoints

Verification occurs per task for focused tests and at every phase boundary for
the full applicable slice. Pause for explicit approval between phases during
Conductor implementation.

## Quality Gates

Run from the repository root:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:web
bun run build:cli
bun run build:web
bun run build:web:cloudflare
bun audit --production --audit-level=high
git diff --check
```

Studio phases additionally require:

- a fresh local-data directory;
- loopback and hostile-Host authentication tests;
- upload interruption, retry, cancellation, and cleanup tests;
- browser end-to-end coverage for the golden path;
- confirmation that tracked files contain no generated media or secrets;
- validation that `analysis.json` and `manifest.json` remain authoritative.
