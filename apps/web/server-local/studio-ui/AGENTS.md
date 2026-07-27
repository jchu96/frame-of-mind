# Local Studio UI Agent Instructions

- Keep this page tree build-time local-only and registered only when
  `FRAME_OF_MIND_STUDIO=1`.
- Keep the Studio dashboard frame behind the build-time `#frame-app` alias.
  Review-only and Cloudflare builds must resolve the pass-through frame and
  retain the existing SSR review header.
- Keep browser-selected `File` objects in component-local state. Persist only
  opaque resumable IDs; never persist names, paths, bytes, transcripts, or
  provider payloads in SSR state, cookies, SQLite, or browser storage.
- Count upload progress only from validated server receipts. After refresh,
  reconcile the server and verify the complete bounded-part file fingerprint
  before resuming; matching metadata or a confirmed prefix is insufficient.
- Treat session storage as an optional opaque resume hint, never cleanup
  authority. Preserve ambiguous create keys and fail closed on replacement
  until the current staged copy is deleted.
- Make local storage, retention, later remote transfer, abort, retry, and
  cleanup behavior explicit before the user starts an operation.
- Use semantic labels, visible status text, keyboard-operable controls, and
  no color-only state. Keep one real happy path in Playwright and exhaustive
  transfer state tests in `apps/web/test/`.
