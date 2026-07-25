# Middleware Agent Instructions

- Authentication is fail-closed.
- Validate Cloudflare Access signature, issuer, audience, and algorithm.
- Local auth-off mode remains loopback-only by default.
