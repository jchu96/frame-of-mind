# Nuxt UI Agent Instructions

- Follow Nuxt 4 `app/` conventions and Nuxt UI v4 components.
- Use `useFetch` for SSR reads and `$fetch` for user-triggered mutations.
- Render provider/model content as text. Never use `v-html`.
- Do not turn stored `appUrl` or other untrusted strings into links without a
  reviewed URL policy.
- Keep the interface useful with zero runs and on narrow screens.
