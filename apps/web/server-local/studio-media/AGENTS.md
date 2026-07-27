# Local Media Staging Agent Instructions

- Keep this implementation local-only and outside Nuxt's scanned `server/`
  tree.
- Accept opaque media IDs only; never accept or return a client filesystem
  path or recording name.
- Stream bounded chunks to private user-only files outside the checkout.
- Persist part receipts before acknowledging progress and reconcile partial
  writes after restart.
- Never claim deletion until byte removal succeeds; preserve
  `cleanup_failed` receipts for explicit retry.
- Keep recording bytes out of SQLite, logs, errors, fixtures, and Cloudflare
  artifacts.
- Extend the Cloudflare artifact marker gate whenever this boundary changes.
