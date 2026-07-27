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
- Give every media mode a server-owned expiry. Browser state must never own
  cleanup, and legacy receipts need an explicit migration.
- Serialize write, seal, and delete ownership per media session. A disconnected
  completion request may still be hashing server-side.
- Verify any browser-provided complete-file binding against the ordered
  durable part receipts before seal.
- Keep recording bytes out of SQLite, logs, errors, fixtures, and Cloudflare
  artifacts.
- Extend the Cloudflare artifact marker gate whenever this boundary changes.
