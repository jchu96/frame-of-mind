# Browser E2E Agent Instructions

## Commands

| Task | Command |
|------|---------|
| Browser smoke | `bun run test:e2e` |
| Hosted Workers | `bun run test:e2e:hosted` |
| Human hosted Studio | `bun run hosted:local` |
| Reviewer regressions | `bun run test:e2e:adversarial` |
| Deployed canary | `bun run test:e2e:canary` |
| Full suite | `bun run test:e2e:all` |
| One file | `FRAME_OF_MIND_E2E_SUITE=<suite> bun --no-env-file scripts/run-playwright-e2e.ts apps/web/e2e/<folder>/<file>.spec.ts` |

## Test Boundaries

- Use only invented, public-safe fixtures. Never load `.env`, provider tokens,
  meeting content, recordings, transcripts, or generated runs.
- Bootstrap local authentication in `smoke/auth.setup.ts`; dependent projects reuse only
  its ignored Playwright storage state.
- Use `support/hosted-test.ts` for built hosted Workers and
  `support/isolation.ts` for every harness. Never hardcode listener ports,
  Wrangler persistence paths, or D1 database names.
- Prefer roles, labels, and visible names. Add a test ID only when the user
  interface has no stable semantic locator.
- Use web-first assertions and event/response waits. Do not add fixed sleeps.
- Keep provider calls offline. Browser tests may exercise local configuration,
  imports, and synthetic adapters only.
- Put traces, screenshots, videos, reports, and storage state under ignored
  `test-results/` or `playwright-report/`.
- Keep reviewer-derived security probes under `adversarial/`, tag them
  `@adversarial`, and cite the originating `REVIEW-fom-*.md` in a comment.
- Keep `flaky-quarantine.json` explicit and empty unless a separately reviewed
  quarantine has an owner and removal condition.
