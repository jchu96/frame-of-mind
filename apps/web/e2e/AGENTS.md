# Browser E2E Agent Instructions

## Commands

| Task | Command |
|------|---------|
| Browser smoke | `bun run test:e2e:smoke` |
| Full browser suite | `bun run test:e2e` |
| One file | `bun run test:e2e -- apps/web/e2e/<file>.spec.ts` |

## Test Boundaries

- Use only invented, public-safe fixtures. Never load `.env`, provider tokens,
  meeting content, recordings, transcripts, or generated runs.
- Bootstrap authentication in `auth.setup.ts`; dependent projects reuse only
  its ignored Playwright storage state.
- Prefer roles, labels, and visible names. Add a test ID only when the user
  interface has no stable semantic locator.
- Use web-first assertions and event/response waits. Do not add fixed sleeps.
- Keep provider calls offline. Browser tests may exercise local configuration,
  imports, and synthetic adapters only.
- Put traces, screenshots, videos, reports, and storage state under ignored
  `test-results/` or `playwright-report/`.
- Test one real happy path in the browser. Keep exhaustive state, security,
  upload, and storage permutations in lower-level contract tests.
