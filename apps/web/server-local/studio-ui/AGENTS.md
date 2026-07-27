# Local Studio UI Agent Instructions

- Keep this page tree build-time local-only and registered only when
  `FRAME_OF_MIND_STUDIO=1`.
- Keep the Studio dashboard frame behind the build-time `#frame-app` alias.
  Review-only and Cloudflare builds must resolve the pass-through frame and
  retain the existing SSR review header.
- Keep `app/assets/css/main.css` explicitly pointed at this directory with
  Tailwind v4 `@source`. Build-injected pages outside `app/` can compile while
  silently losing utilities that appear only in this tree.
- Keep `/__studio/launch` inert and outside the dashboard frame. It may
  exchange or reject a URL-fragment capability, but it must not read jobs,
  runs, connections, media, or credentials. Every other Studio page is
  session-protected.
- Compose Home from the existing job, run-projection, and sanitized
  configuration reads. Do not add a dashboard cache or a second authority, and
  revalidate when the page is mounted after a client-side workflow.
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
