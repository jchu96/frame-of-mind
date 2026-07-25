# Server Utility Agent Instructions

- Keep security policy functions small and directly tested.
- Cache remote JWK sets, not JWTs or identities.
- Never include token contents or verification details in user-facing errors.
