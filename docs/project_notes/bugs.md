# Bugs and Failure History

## 2026-07-25 — Bluedot tool output rejects its own duration value

- Symptom: the MCP SDK's high-level `callTool` path rejects `get_meeting` even though the tool returned meeting data.
- Cause: the server advertised a per-tool output schema whose duration format did not accept the ISO-8601 duration returned by the live endpoint.
- Workaround: call `tools/call` through `client.request` and validate the MCP envelope with `CallToolResultSchema`.
- Prevention: keep an offline contract test and retry the high-level path only after the provider schema is verified fixed.

## 2026-07-25 — Bluedot context had no recording URL

- Symptom: `get_meeting` returned metadata, summary, and transcript but no downloadable media field.
- Impact: analysis cannot assume the context provider is also a media provider.
- Prevention: require `--video` as the normal path and treat signed Bluedot URLs as an explicitly validated fallback.

## 2026-07-25 — Short clip received the wrong transcript window

- Symptom: an 8:54 clip from the middle of a longer meeting was paired with transcript lines from meeting time zero.
- Cause: candidate video timestamps were used directly against a full-meeting transcript.
- Fix: model and manifest a transcript offset, support `--transcript-offset`, and apply it before slicing nearby transcript evidence.

## 2026-07-26 — Custom MCP endpoint could inherit a canonical bearer token

- Symptom: an overridden MCP URL shared the default provider token file.
- Cause: OAuth credentials were stored by provider name, not resource URL.
- Fix: require HTTPS, bind stored OAuth state to the exact resource, and derive
  a separate hashed token path for every noncanonical endpoint.
- Prevention: offline origin-isolation tests; never add a raw bearer-token
  override.

## 2026-07-26 — Invalid model timestamps fell back to video zero

- Symptom: malformed timestamps could survive the durable schema and be parsed
  as zero for clips/screenshots.
- Cause: permissive strings plus fail-open time parsing.
- Fix: canonical timestamp schemas, throwing time conversion, ordered ranges,
  and candidate-bound evidence validation.
- Prevention: malformed, reversed, and out-of-window regression tests.

## 2026-07-26 — Valid hosted import could exceed a D1 bound-value/row limit

- Symptom: a request below the API's 2 MiB cap expanded above D1's 2,000,000
  byte string/row limit.
- Cause: the projection parameter duplicated summary/candidate/result fields
  and no exact projected-row budget was enforced.
- Fix: derive normalized columns from original item JSON, split expansion
  parameters at 900 KB, and reject projected run rows above 1.8 MB.
- Prevention: 1,000-item and large multi-batch D1 regressions.

## 2026-07-26 — Cleanup retry could outlive its published manifest

- Symptom: a manifest recorded `deleted: false`, then a `finally` retry deleted
  the remote file after publication.
- Cause: cleanup retry state was not frozen at the atomic publication boundary.
- Fix: permit final retry only while no durable bundle exists, then freeze
  cleanup state immediately after the successful rename.
- Prevention: treat a published manifest as immutable provenance.
- Prevention: test non-zero clip alignment and retain alignment method, confidence, and rationale in `manifest.json`.

## 2026-07-25 — Gemini returned 429 before analysis

- Symptom: valid API keys failed with resource-exhausted or prepaid-credit messages.
- Cause: provider billing/quota, not authentication or media format.
- Prevention: distinguish missing credentials, invalid credentials, quota, and billing in troubleshooting; do not keep retrying a billing failure.

## 2026-07-25 — Quoted dotenv extraction produced an invalid key

- Symptom: a key copied with surrounding shell quotes failed authentication.
- Cause: ad hoc shell parsing treated dotenv syntax as the secret value.
- Prevention: use a dotenv-aware loader or export the value through the shell; never document `grep | cut` credential extraction.

## 2026-07-25 — Clean CI could not resolve Tailwind

- Symptom: local builds passed while a fresh Linux CI build failed resolving
  `@import "tailwindcss"` from the application stylesheet.
- Cause: the warm local dependency tree masked that the isolated web workspace
  did not directly declare the CSS package.
- Fix: pin `tailwindcss` in `apps/web/package.json`.
- Prevention: run at least one fresh `bun install --frozen-lockfile` build
  before release.

## 2026-07-27 — Recording UI misread successful deletion

- Symptom: the browser showed a cleanup failure after the server had removed
  the staged bytes and returned terminal state `deleted`.
- Cause: the client accepted only `aborted` as a clean deletion terminal.
- Fix: accept both `aborted` and `deleted`, while retaining
  `cleanup_failed` as an actionable failure.
- Prevention: the production Playwright happy path now stages and deletes a
  synthetic recording through the real local API.

## 2026-07-27 — Browser receipt accidentally owned private-media cleanup

- Symptom: closing the tab after seal could discard the only UI handle while
  an ephemeral recording had no remaining expiry.
- Cause: upload expiry was cleared at seal, but the media retention receipt did
  not carry its own server-owned bound.
- Fix: every media mode now has a server-owned expiry; sealed ephemeral media
  expires independently of browser state, and legacy receipts migrate on read.
- Prevention: adapter regressions cover sealed expiry and the ADR states that
  browser storage is never cleanup authority.

## 2026-07-27 — Resume could splice recordings with a shared prefix

- Symptom: a same-size/MIME replacement with matching confirmed parts could
  append a different suffix after refresh.
- Cause: resume verified only already-confirmed part hashes.
- Fix: create binds the ordered digests of every fixed-size file part; resume
  recomputes that complete binding with bounded memory before any new write.
- Prevention: client and adapter tests mutate only the unconfirmed tail and
  require a closed mismatch.

## 2026-07-27 — Expired media cleanup depended on process restart

- Symptom: a sealed recording whose browser receipt was lost could remain on
  disk after expiry for as long as the same Studio process stayed open.
- Cause: the adapter enforced expiry during access and startup reconciliation,
  but the server had no lifecycle-owned periodic sweep.
- Fix: Nitro now owns a one-minute, non-overlapping expiry janitor, skips
  writer-owned sessions, retries cleanup failures, cancels the interval on
  close, and waits for an active sweep to finish.
- Prevention: deterministic scheduler tests cover non-overlap, sanitized
  failures, cleanup retry, active-writer exclusion, continued operation, and
  shutdown draining.
