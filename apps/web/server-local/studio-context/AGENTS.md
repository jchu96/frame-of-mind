# Local Context Staging Instructions

- Keep this directory local-only and excluded from every Cloudflare build.
- Accept only bounded UTF-8 JSON, text, Markdown, SRT, or VTT streams.
- Stage private bytes outside the checkout and expose only opaque receipts.
- Normalize execution through the shared `FileContextSource`; do not create a
  second transcript parser or durable context authority.
- Verify current bytes against the receipt before use. Delete the staged copy
  when its execution lease ends, whether analysis succeeds or fails.
- Treat expiry as an abandoned-upload backstop. Never delete a user-owned
  source file.
- Do not log file bodies, names, private paths, transcript text, or receipts.
