# Hosted Workflows Worker Agent Instructions

- This sibling Worker is internal-only: the public Nuxt Worker calls it through
  the `HOSTED_WORKFLOWS` service binding; it must never gain public routes.
- Access context does not cross the binding: every entry revalidates a bounded,
  principal-scoped job receipt before doing work.
- Spend is law: reservations are atomic in D1, overruns fail closed, and every
  Gemini call stays inside the reserved plan. Never widen a cap in code.
- `src/spend.ts`, `src/contracts.ts`, and `src/telemetry-contract.ts` are
  versioned contracts shared with `apps/web/server-hosted`; change them only
  with matching contract-test updates.
- Telemetry is codes and structural fields only — no free text, emails,
  transcripts, or media bytes.
- Gate with `bun run test:hosted-workflows-http` (+ `:better-auth`) and the
  sharded lane; the operator `wrangler.jsonc` here is gitignored.
