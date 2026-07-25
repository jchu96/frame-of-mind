# Web Server Agent Instructions

- Treat every request body, header, run contract, and D1 row as untrusted.
- Keep authentication middleware ahead of every SSR/API data path.
- Never log JWTs, import bodies, meeting content, or database rows.
- Keep the 2 MiB import bound unless the abuse and retention model is reviewed.
- Use prepared statements only.
