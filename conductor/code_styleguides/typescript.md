# TypeScript And Vue Style Guide

## Boundaries

- Parse untrusted input once at the boundary with Zod.
- Keep domain contracts independent of Nuxt, provider, database, and filesystem
  response shapes.
- Prefer dependency injection for time, filesystem, process, provider, and
  storage effects.
- Never expose secret values through API response types.

## TypeScript

- Use strict types and narrow unions for job stages and outcomes.
- Represent state transitions explicitly; do not infer them from log strings.
- Prefer immutable data at durable publication boundaries.
- Add `AbortSignal` support to long-running or retryable operations.
- Use UTC RFC 3339 timestamps for persisted job events.
- Sanitize errors before storage or browser delivery.

## Vue And Nuxt

- Use `useFetch` or `useAsyncData` for SSR reads and `$fetch` for user-triggered
  mutations.
- Use `useState` for state that must survive SSR hydration; avoid module-scope
  reactive state.
- Abort stale requests triggered by watchers.
- Keep Studio pages client-rendered when their state is inherently browser and
  upload-session specific.
- Use Nuxt UI semantic colors and accessible components.
- Render provider and model content as text; never use `v-html`.

## Tests

- Test domain and server behavior independently of rendered components.
- Use synthetic recordings and transcripts only.
- Exercise interruption and restart paths, not only the happy path.
- Assert cleanup receipts and retained-file ownership explicitly.
