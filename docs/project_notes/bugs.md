# Bugs and Failure History

## 2026-08-22 — Built hosted upload route materialized every request body

- Symptom: a route-local `TransformStream` delivered exact 16 MiB and
  concurrent 8 MiB bodies to a resumable-shaped sink, but could not prove the
  original Cloudflare request remained streaming; inspector backing storage
  rose by about 32 MiB for the concurrent pair. The requested `hash-wasm`
  server digest also failed before it could instantiate.
- Cause: Nitro 2.13.4's `cloudflare_module` entry calls
  `Buffer.from(await request.arrayBuffer())` before `localFetch` creates the H3
  event. Separately, `hash-wasm` 4.12.0 decodes embedded bytes and calls
  `WebAssembly.compile()` at runtime, which workerd disallows.
- Follow-up: Task 2.0b emitted a built wrapper entry that authenticated and
  intercepted only the dark upload path before Nitro. Its fast-sink oracle saw
  `bodyUsed=false` at all three handlers and reduced the concurrent backing
  delta from 33,568,143 bytes to 6,930,496 bytes, producing a provisional GO.
  Adversarial Task 2.0c invalidated that conclusion: replacing the tee with one
  counting/digesting `TransformStream` still added 8,398,085 backing bytes for
  an 8 MiB upload while the sink delayed its first read for 2,503 ms. A request
  source that declared 8 MiB and produced 9 MiB was truncated to 8 MiB at the
  workerd service boundary, returned 200, and recorded a receipt.
- Resolution proposal: Task 2.0d accepts runtime materialization and bounds it
  by construction. Fresh Wrangler processes measured 1, 2, and 4 MiB parts at
  concurrency two and four; every combination passed its
  `part × concurrency × 1.5` hold bound and the 24 MiB full-run backing-growth
  cap. The largest 4 MiB × 4 case measured 2,842,764 bytes. Task 2.0 is GO at
  4 MiB parts pending an ADR 0018 amendment; private R2 is the second fallback.
- Prevention: gate hosted upload changes on the built workerd artifact, scan
  the emitted entry as well as route source, inspect backing storage rather
  than ordinary JS heap alone, stall the sink long enough to exercise
  backpressure, isolate each memory combination in a fresh process to prevent
  allocator reuse from hiding growth, test length behavior through the service boundary, and
  require `DigestStream` or a static precompiled WASM import before claiming
  Worker-side digest support.

## 2026-08-22 — Every Studio-created analysis failed before Gemini upload

- Symptom: valid Studio jobs moved through `fetching_context` and failed in
  roughly 50 ms with only the generic `analysis_failed` terminal code.
- Cause: private staging deliberately stores the authorized recording as
  `media.sealed`, but the Studio resolver passed only that path and digest.
  The shared analyzer therefore tried to infer MIME from `.sealed` instead of
  using the media session's already-validated MIME receipt. The worker then
  discarded the typed error while terminalizing the job.
- Fix: propagate the sealed session MIME through `AnalyzeOptions`, prefer it
  before path inference, and preserve recognized sanitized error codes in a
  warning event, terminal metadata, and bounded console line. The Run receipt
  can also commit the existing explicit video-only choice in place.
- Prevention: focused tests pin `.sealed` MIME propagation through the Studio
  resolver and shared analyzer, all typed worker failure branches, the Run
  action, and the browser job's non-generic credential failure code.

## 2026-08-11 — Derived transcription failed on every long recording

- Symptom: three consecutive runs on real recordings (50 min and 28 min) all
  warned "Derived transcription failed; continuing without a transcript" while
  audio extraction succeeded.
- Cause (corrected 2026-08-11 after live probing): the failure was provider
  capacity, not output truncation. A probe of one ten-minute window returned
  two consecutive `503 UNAVAILABLE` "model is currently experiencing high
  demand" errors and then succeeded, producing a well-formed transcript with
  `finishReason: STOP` at 3,411 output tokens — far below any budget. The
  original truncation hypothesis was never confirmed; the transport-retry
  budget introduced with the per-candidate isolation work (two retries, linear
  1s/2s backoff) was simply too small to outlast a 503 burst.
- Note: windowed transcription still shipped and is still correct — it bounds
  per-request output and cost — but it was not what fixed this symptom.
- Correction: transcribe in ten-minute windows with a fifteen-second lead-in
  overlap, shift each window's segments onto recording time, and merge with
  overlap segments dropped; a failed window discards the whole transcript
  instead of publishing one with an unlabeled hole. Then widen the retryable
  transport budget to four retries with exponential backoff capped at 16s,
  which is what actually clears a 503 burst.
- Prevention: unit tests pin window planning, offsetting, overlap dedupe, and
  ordering; orchestrator tests prove per-window extraction bounds, per-window
  upload cleanup, the stitched result reaching both passes, and no-transcript
  publication when a window fails; an adapter test proves a burst two failures
  deep still resolves. Probe the sanitized error class against the live API
  before theorizing about a cause — the swallowed status was the whole answer.
  Issue #40 tracks the incident.
- Follow-up: request-level retries alone left the transcript all-or-nothing
  across windows, so a window that exhausts them is re-uploaded and transcribed
  once more from the audio already on disk. Measured during a load-shedding
  episode, per-request failure ran near 50%; with five retried requests per
  attempt and two attempts per window, losing a window became remote.

## 2026-08-11 — Retained-upload digest check rejected every genuine match

- Symptom: the first live `--remote-file` reuse failed with "does not match
  the local recording digest" for the exact file the previous run uploaded.
- Cause: the Files API documents `sha256Hash` as base64, and the check assumed
  base64 of the raw digest bytes; live responses actually base64-encode the
  lowercase hex digest string.
- Correction: compare via a tolerant matcher that accepts plain hex, raw-bytes
  base64, and hex-string base64, normalizing before comparison.
- Prevention: the reuse tests pin the live-observed encoding as the primary
  fixture; verify provider-side encodings against a real response, not only
  documentation, before shipping an equality gate.

## 2026-08-11 — One transient detail-generation error erased a 22-candidate run

- Symptom: a real 50-minute analysis failed at detail 14/22 after ~26 minutes
  with `Gemini detail generation failed.`, publishing only a sanitized
  `unexpected_failure` manifest and discarding 13 validated candidates. A
  minimal probe with the same key immediately succeeded.
- Cause: the 2026-07-28 per-candidate isolation covered typed
  response-validation failures but not `GeminiFileError` thrown when the
  generation request itself failed, so one transient transport error was
  run-fatal.
- Correction: detail-phase generation failures now raise the candidate-scoped
  `generation_failed` code after two bounded transport retries (429/5xx only),
  and the orchestrator records them and continues; index and transcribe phases
  keep run-scoped failure semantics.
- Prevention: adapter tests cover retry-then-succeed, retry exhaustion,
  non-retryable immediate failure, and index-phase run-scoping; issue #41
  tracks the incident.

## 2026-08-11 — Doctor never detected ffmpeg on Windows

- Symptom: `frameofmind doctor` reported ffmpeg missing on Windows even though
  `ffmpeg -version` succeeded and the screenshot/audio extractors worked.
- Cause: the PATH probe checked each directory for a file literally named
  `ffmpeg`, but Windows installs `ffmpeg.exe`; only the presence check was
  wrong because `spawn("ffmpeg", ...)` resolves the `.exe` itself.
- Correction: probe Windows executable names (`.exe`, `.cmd`, `.bat`, then the
  bare name) per PATH entry and skip empty PATH segments.
- Prevention: treat a doctor presence probe as wrong until it uses the same
  resolution rules as the spawn path it describes.

## 2026-07-27 — Context expiry could race an active upload

- Symptom: the first janitor draft removed every `.stage-*` directory as
  abandoned, including a request that was still streaming.
- Cause: temporary directories were not included in the adapter's in-process
  ownership set.
- Correction: register the temporary directory before creation, skip it during
  expiry, and release ownership only after publish or cleanup.
- Prevention: the adapter test pauses a live stream, runs expiry, then proves
  the complete file still publishes.

## 2026-07-27 — One corrupt context receipt blocked unrelated expiry

- Symptom: a malformed receipt aborted the sweep before later expired context
  could be deleted.
- Cause: reconciliation treated the directory scan as one all-or-nothing
  operation.
- Correction: continue safe per-entry cleanup, retain the first failure, then
  report its sanitized code after the scan.
- Prevention: the corruption regression test proves a later valid expired file
  is removed even though the sweep reports the unrelated invalid receipt.

## 2026-07-27 — Narrow request initially analyzed too much media

- Symptom: a topic-focused request was treated as permission to analyze the
  complete available recording.
- Cause: media availability was conflated with the user's semantic scope.
- Correction: use timestamped transcript evidence to select bounded local
  derivatives before Gemini upload.
- Prevention: ADR 0009 makes transcript-first semantic scoping the default for
  topic- or speaker-focused work.

## 2026-07-27 — Speaker-only correction omitted useful collaboration

- Symptom: a first correction narrowed the review to the named requester's
  literal airtime and risked dropping useful clarifications.
- Cause: speaker identity was mistaken for the semantic topic boundary.
- Correction: retain the complete relevant conversational turn, then classify
  direct request, collaborative clarification, and analyst inference.
- Prevention: the meeting-to-issue workflow treats a named speaker as a search
  signal, not an exclusion rule.

## 2026-07-27 — Model attribution needed transcript and video reconciliation

- Symptom: model output associated a request with a visually prominent
  participant even though provider segment ownership and conversational
  continuity suggested another speaker.
- Cause: neither transcript diarization nor visible tile prominence is
  sufficient attribution authority by itself.
- Correction: preserve the raw `speakerTag`, then reconcile audio, visible
  active-speaker labels, adjacent turns, and direct address.
- Prevention: uncertain attribution remains explicitly unverified.

## 2026-07-27 — Screenshot evidence upload briefly created a zero-byte object

- Symptom: an issue-asset path existed remotely but its object size was zero.
- Cause: a failed local file-to-base64 step was followed by a successful API
  call because the shell pipeline did not fail as a unit.
- Correction: replace the object from the verified source and confirm the
  remote size before linking it.
- Prevention: enable `pipefail`, validate local existence and nonzero size, and
  re-read the remote object after any evidence upload.

## 2026-07-27 — Gemini SDK upload returned an empty 404 for a valid API key

- Symptom: `@google/genai` 2.13.0 `files.upload()` failed before media
  processing with an empty 404 response under Bun.
- Isolation: the same API key, file, MIME type, and Gemini Developer API
  accepted the documented resumable upload protocol; file listing, model
  generation, media understanding, and deletion also succeeded.
- Diagnostic result: the official resumable Files API upload sequence worked
  while the SDK continued to handle polling, generation, and cleanup.
- Status: resolved in v0.2.1 by a typed, streaming production uploader with
  exact-host validation and cleanup coverage.
- Prevention: keep `bun run smoke:gemini` and rerun it after Bun, SDK, model,
  Files protocol, or adapter changes.

## 2026-07-27 — Gemini 3.6 rejected the full Zod JSON Schema

- Symptom: `gemini-3.6-flash` returned `400 INVALID_ARGUMENT` for both text-only
  and video structured-output requests.
- Cause: `z.toJSONSchema(...)` emitted constraints outside Gemini's supported
  schema subset; a generated `maxItems: 1000` alone caused the current
  Interactions endpoint to reject the request. The failure was independent of
  transcript size, private media, and upload state.
- Solution: derive a provider-safe JSON Schema subset from the Zod schema,
  while parsing the response as `unknown` and validating it against the full,
  stricter originating Zod schema.
- Status: resolved in v0.2.1 by an isolated schema sanitizer plus complete
  local Zod validation.
- Prevention: contract-test the sanitizer and run both structured video passes
  when upgrading the model or `@google/genai`.

## 2026-07-27 — A generateContent test did not prove responseFormat support

- Symptom: `models.generateContent` accepted `responseFormat` without a request
  error but returned Markdown/prose that failed strict JSON parsing.
- Cause: the diagnostic used an array shape from the 2.13.0 declaration plus
  an unsanitized schema, while Google's current generateContent documentation
  shows an object-shaped `responseFormat`.
- Resolution: treat that diagnostic as inconclusive. The current official
  Interactions API path passed the exact sanitized Zod-derived schema and a
  synthetic video; generateContent remains a documented previous API.
- Prevention: load Google's official skills and hosted feature page before
  reconciling SDK declarations with a changing Beta API.

## 2026-07-27 — Provider-safe output exceeded a stricter local field bound

- Symptom: a structured video response passed Gemini's provider schema but
  failed local Zod validation because `where.surface` exceeded 2,000
  characters.
- Cause: Gemini's supported JSON Schema subset could not carry every local
  string-length constraint.
- Solution: keep the strict local schema, make bounded fields explicit in the
  prompt, and fail closed with sanitized issue paths.
- Status: resolved in v0.2.1 without a corrective retry.
- Prevention: never truncate or cast a model response to force acceptance;
  schema success is required before artifact publication.

## 2026-07-27 — Detail smoke returned a noncanonical evidence timestamp

- Symptom: upload and index passed, but the first complete synthetic smoke
  failed local detail validation at `evidence.timestamp`.
- Cause: the provider-safe schema cannot express the local canonical timestamp
  refinement, and the detail prompt had not restated the candidate bounds.
- Fix: require `HH:MM:SS` evidence inside the exact candidate range and retain
  strict local parsing.
- Verification: the next generated-video run passed upload, index, detail
  interrogation, and exact deletion on `gemini-3.6-flash`.
- Prevention: the explicit smoke command must keep both structured passes.

## 2026-07-27 — Optional Gemini app URL aborted an otherwise usable detail

- Symptom: an `issue-review` run reached Gemini and then failed strict local
  validation at `where.appUrl (custom)`, leaving no bundle and an empty meeting
  container.
- Cause: Gemini emitted a URL-shaped optional value that violated the stricter
  no-query/no-fragment evidence rule. Provider-safe JSON Schema could not
  express the refinement, and the adapter had no bounded repair path. CLI
  progress also hid the pass-2 boundary until a detail completed.
- Fix: describe the optional URL constraint in the provider schema, regenerate
  the complete structured response once using sanitized issue paths/codes,
  retain unchanged Zod validation, print the pass-2 boundary, and remove an
  empty meeting container after failure.
- Prevention: tests cover repair success, repeated invalid output, rejected
  value non-disclosure, exact remote cleanup, and failed-attempt directory
  cleanup.

## 2026-07-27 — Upload-start redirects could forward the Gemini key

- Symptom: the new direct uploader validated the returned resumable URL but
  left Fetch's default redirect behavior enabled on the earlier key-bearing
  request.
- Cause: a cross-origin 307 can be followed before post-response URL
  validation, and Bun 1.3.14/Node 22 can forward `X-Goog-Api-Key`.
- Fix: set `redirect: "error"` on both upload requests and retain exact-host
  validation for the returned resumable URL and finalized file URI.
- Verification: an offline request-contract test requires redirects disabled
  on both hops; the generated-video live smoke still passes.
- Prevention: never treat validation after an automatic redirect as a
  credential boundary.

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

## 2026-07-28 — One near-valid Gemini detail erased the run

- Symptom: invalid JSON, a noncanonical timestamp, or an overlong optional
  field in one detail response aborted the complete analysis and discarded
  already validated candidates.
- Cause: invalid JSON did not use the typed repair boundary, and the
  orchestrator had no per-candidate boundary for exhausted response failures.
- Fix: classify missing/invalid/schema responses, regenerate once, normalize
  only `.000` losslessly, isolate typed candidate failures, publish balanced
  outcome counts, and preserve a sanitized whole-run failure manifest after
  remote upload.
- Prevention: synthetic fixtures cover invalid JSON, zero/non-zero
  milliseconds, overlong fields, partial and all-detail failure, unexpected
  whole-run failure, provider-transport aborts, payload redaction, and cleanup
  provenance when upload processing fails after an exact remote ID is known.
