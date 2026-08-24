# Middleware Agent Instructions

- Authentication is fail-closed.
- Bind Better Auth sessions to one `ba:<userId>` principal. Validate Access
  signature, issuer, audience, and algorithm only in Access or stacked modes.
- Local auth-off mode remains loopback-only by default.
