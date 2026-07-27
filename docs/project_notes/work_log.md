# Work Log

## 2026-07-25

- Scaffolded the TypeScript CLI, Bluedot OAuth/MCP adapter, Gemini two-pass Files API analysis, secure download path, screenshots, durable JSON/Markdown artifacts, tests, CI, agent guidance, and runbook.
- Verified `gemini-3.6-flash` against an 8:54 local screen recording and deleted the remote Gemini file after analysis.
- Confirmed a live Bluedot output-schema mismatch and the absence of a recording URL; documented both.
- Added Granola MCP and local-file context adapters.
- Added explicit/model-derived transcript alignment after a source clip was found to begin later than the full meeting transcript.
- Added self-contained `report.html` as an optional artifact-like review surface while retaining JSON as the source of truth.
- Used a short authorized screen recording to validate issue-review output and a downstream ticket workflow.
- Reframed the product from evidence dossiers to recipe-driven video understanding and selected the public Frame of Mind brand.
- Added built-in recipes, general `analysis.json`, architecture/credentials/recipes/versioning docs, and a Codex/Claude skill installer.
- Added explicit Granola REST API-key transport while retaining MCP OAuth as the default.
- Added a Bun/Nuxt UI SSR review workspace with explicit imports, local SQLite,
  Cloudflare D1, build-time adapter selection, and Access JWT enforcement.
- Documented the deferred read-only local/Cloudflare MCP design using the NEC
  Knowledge Base's shared-core and dual-front-door pattern.
- Ran independent adversarial security, provider, and contract reviews; closed
  findings across OAuth recovery, MCP error handling, transcript isolation,
  path safety, media limits, import streaming, contract parity, and D1
  retention.
- Reproduced and fixed a clean Linux CI failure caused by an undeclared
  Tailwind workspace dependency, then validated a fresh frozen Bun install.

## 2026-07-26

- Completed the v0.2 adversarial hardening pass: exact-resource OAuth
  isolation, v2 run/digest/recipe provenance, strict evidence timestamps,
  caption normalization, bounded Granola streaming, cleanup retries, CSRF
  controls, keyset pagination, and D1 bulk item expansion.
- Added and adversarially reviewed the public local Studio Conductor track.
  Grounded five architecture blockers and two plan gaps, then revised job/media
  authority, local session security, retention/reattachment, provider
  capabilities, Worker isolation, delivery slices, rollback, and risk gates.
- Added the canonical ADR index and ADRs 0006-0008 for local Studio execution,
  lifecycle separation, and environment/session-only API secrets.
- Implemented the first four local Studio foundation tasks and measured a
  synthetic 32 MiB Bun/Nitro stream through bounded `FileSink` writes, atomic
  seal, byte ranges, and Cloudflare build-time exclusion.
- Added the local Studio one-time launch exchange: a URL-fragment capability is
  removed before a bounded same-origin POST creates an HttpOnly, SameSite
  Strict process-session cookie; Cloudflare builds exclude the complete route,
  plugin, and session implementation.
- Completed local Studio connection health: `.env`-first and process-memory
  API keys, exact-resource Bluedot/Granola OAuth status/initiation, a
  session-protected Nuxt Connections page, and a production Bun launcher bound
  explicitly to `127.0.0.1`. Browser validation caught and closed Node-dev,
  all-interface binding, and first-load cookie-race failures.
- Added scoped Conductor and shared-web contract guidance, then fixed the Phase
  3 Nuxt UI boundary: `UFileUpload` owns accessible selection while a separate
  composable and the server media-session contract own resumable staging,
  reconciliation, progress, cancellation, and cleanup.
- Added an isolated Playwright Studio baseline covering browser bootstrap,
  session denial/replay, temporary-key nonreflection, synthetic import/review,
  console cleanliness, and narrow-screen overflow. The test server clears
  provider credentials and uses temporary OAuth, SQLite, and dotenv state.

## 2026-07-27

- Started reconciled Task 3.6 after merging Studio Home PR #24. Added a
  separate 8 MiB context adapter and protected create/delete routes for JSON,
  text, Markdown, SRT, and VTT; receipts contain no paths or bodies.
- Wired exact context receipts into the local job resolver and executor. The
  process-local lease blocks deletion during normalization, reuses
  `FileContextSource`, and consumes private staging in `finally`; one-hour
  expiry remains the abandoned-input backstop.
- The full repository gate passed with 93 CLI tests, 166 web tests, the
  production-built HTTP contract, Cloudflare exclusion, and the 32 MiB
  streaming probe. All 10 production Playwright tests also passed.
- The adversarial pass added the missing immutable context SHA-256 and closed
  two cleanup races: expiry now skips a live temporary upload, and a corrupt
  receipt no longer prevents later safe entries from expiring.
- Diagnosed a live Bluedot-to-Gemini video run without persisting meeting
  content: preserved speaker-before-text transcript ownership, isolated an
  SDK-only Files upload 404, rejected an untyped generate-content shim, and
  verified Gemini 3.6's typed Interactions `response_format` contract with a
  provider-safe Zod-derived schema and synthetic video.
- Corrected the live analysis scope to transcript-selected local clips before
  upload, rather than treating the entire available recording as the user's
  requested review boundary.
- Vendored Google's official `gemini-api-dev` and
  `gemini-interactions-api` skills into the public repository and dotfiles,
  with pinned provenance, Apache-2.0 licenses, activation rules, and shared
  Codex/Claude discovery.
- Adversarially reviewed the Playwright baseline and fixed a real replay
  hydration race, retry false-green policy, non-idempotent secret precondition,
  process/browser dotenv exposure, and forceful-shutdown temp leak. CI now
  fails flaky tests, provider canaries prove isolation, and the outer runner
  cleans its synthetic database after both success and failure.
- Implemented the Phase 3 local media backend: private resumable staging,
  durable part receipts, replay/conflict checks, streamed seal verification,
  explicit retention/expiry, retryable cleanup, startup reconciliation, and
  authenticated local-only HTTP routes. Adapter, production-built HTTP, and
  Cloudflare-exclusion coverage use only synthetic bytes.
- The adversarial pass closed canonical-root symlink escape, receipt
  check/open replacement, stale-upload mutation, and contradictory
  partial-plus-sealed restart cases. Full repository checks and five
  production Playwright smoke journeys passed afterward.
- Added the accessible local Recording page with explicit retention and remote
  transfer disclosure, browser-side validation, receipt-confirmed progress,
  pause/retry/abort, and hash-verified refresh resume. Deterministic client
  tests and production Playwright cover small-file stage/delete and an
  8 MiB confirmed-part resume; the browser pass also caught and fixed deleted
  terminal-state handling and mobile header overflow.
- Adversarially reviewed the Recording slice and closed sealed-media orphaning,
  seal/delete concurrency, replacement-handle loss, ambiguous create
  duplication, storage-denial, incomplete identity verification, rounded
  progress, and missing controller/drop/keyboard coverage. The client now
  verifies a complete bounded-part fingerprint, the server owns every expiry,
  and focused state-machine plus production-browser tests cover the repaired
  seams.
- Closed the follow-up retention seam by adding a non-overlapping,
  lifecycle-owned media expiry sweep with shared writer ownership, cleanup
  retry, sanitized failure reporting, and deterministic shutdown tests.
- Converted the sanitized live meeting-to-issue experience into a public
  operator runbook, accepted transcript-first semantic-scoping ADR, portable
  skill reference, attribution ladder, BI synthesis checklist, GitHub
  publishing safeguards, failure matrix, and future-agent guidance.
- Corrected documentation so successful resumable-upload and Interactions
  experiments remain diagnostics rather than being described as shipped
  adapter behavior.
- Made the pinned official Google companion skill directories visible to Git
  so a fresh public clone receives the same Gemini guidance and provenance.
- A cold-reader review found that the production adapter still uses both
  diagnostic-failing Gemini paths, transcript-first clipping does not minimize
  transcript transfer, the initial ffmpeg mapping could preserve extra streams,
  and cleanup guidance overpromised. Public docs now mark live analysis
  compatibility-blocked, disclose full-transcript transfer, use a
  metadata-stripped re-encode recipe, and provide exact manifest-owned cleanup.
- Replaced stale managed Frame of Mind skill copies in dotfiles, Codex, and
  shared-agent discovery with direct symlinks to the repository's canonical
  skill. Claude resolves the same link through the existing dotfiles
  configuration; no activation shim remains.
- Verified from retained artifacts that the two bounded analysis runs produced
  nine timestamped screenshots through the shipped ffmpeg extractor; both
  Gemini uploads were recorded as deleted and the original local recording
  remained outside the repository.
- Replaced the broken SDK Files upload wrapper with a typed, streaming
  resumable uploader; added provider-schema sanitization with strict local Zod
  validation, adapter tests, ADR 0010, and v0.2.1 release documentation.
- Added `bun run smoke:gemini`. The first generated-video run caught a detail
  timestamp refinement gap; after tightening the prompt, a complete
  upload/index/interrogate/delete run passed on `gemini-3.6-flash` with exact
  remote cleanup.
- Adversarial review caught cross-origin redirect credential forwarding,
  smoke false-green behavior, ambiguous finalize cleanup, and raw provider
  error propagation. The adapter now disables redirects, redacts every model
  and delete failure, reports unknown cleanup honestly, and requires relevant,
  accepted synthetic evidence before the canary passes.
- The follow-up adversarial review returned clear after the smoke also required
  an in-bounds indexed candidate, an accepted matching detail kind, and an
  in-candidate evidence timestamp. The stricter live canary and full repository
  gate passed.
- Extracted the CLI analysis pipeline into a typed `AnalysisOrchestrator` with
  explicit provider/analyzer factories, structured stage/progress/warning
  events, cooperative `AbortSignal` checks, exact-upload cleanup, atomic
  publication, and nonfatal post-publication projection warnings. Deterministic
  service tests cover success, cancellation, cleanup failure, and projection
  failure; the CLI now adapts those events without log-scraping seams.
- Adversarial review closed an injected run-ID traversal into recursive cleanup
  and removed the authoritative bundle path from the projection capability.
  Projection now receives only cloned validated contracts.
- Added the local-only SQLite job/event migration and `JobRepository`.
  Immediate transactions serialize idempotent creation, transitions plus
  events, cancellation intent, retry lineage, and sequence allocation. Tests
  cover migration isolation, cross-connection replay, persistence after
  reopen, pagination/filtering, terminal publication metadata, and digest
  corruption while keeping media receipt authority outside SQLite.
- Adversarial review closed two lifecycle gaps: cancellation is rejected after
  durable publication, and event rows are bound to their owning attempt by
  both a composite foreign key and repository validation.
- Added the single-concurrency local job worker and typed
  `AnalysisOrchestrator` adapter. Tests cover oldest-first claims, concurrency,
  startup interruption, cooperative shutdown, sanitized failure, progress
  binding, invalid publication receipts, immutable recipe verification, and
  model propagation.
- Adversarial review closed shutdown-during-startup and
  shutdown-after-queue-read races. The adapter now also revalidates the
  returned durable pair and reports a malformed publication receipt as
  indeterminate instead of failed.
- Added the local job control and retained-media reuse guard. Cancellation is
  durable before abort, queued cancellation avoids providers, new retries
  require exact unexpired retained bytes, retry replays survive later expiry,
  and linked attempts fail closed without a just-in-time media lease. Added
  recovery for abandoned retained leases and kept indeterminate publication
  outcomes from being mislabeled by a concurrent cancellation.
- Added the local job list/create/detail/cancel/retry HTTP contracts, bounded
  query/body parsing, sanitized error mapping, initial sealed-media guard, and
  a repository-backed service adapter. Registration is node-only and returns
  503 until the runtime singleton is supplied in the next seam.
- Adversarial review tightened create-time recipe provenance and extended the
  execution lease to initial attempts, including terminal deletion of
  ephemeral staging and restoration of retained staging.
- Wired the protected job routes to one Nitro-owned local runtime: shared Bun
  SQLite repository/projection, single-concurrency worker, cancellation/retry
  controls, typed orchestrator, process-memory credentials, noninteractive
  provider execution, and lease-gated private media path resolution.
- Added focused resolver/runtime/media capability tests and updated the
  production-built local HTTP contract from expected startup 503 to an
  authenticated empty durable queue. Cloudflare remained free of local
  runtime and `bun:` implementation.
- Adversarial review found and closed two execution-lease blockers: external
  media abort can no longer delete `in_use` bytes, and same-size post-seal
  mutation now fails digest validation both at private-path resolution and
  immediately before Gemini upload. Studio run routes now also reuse the
  Nitro-owned run store instead of opening an unowned second connection.
- Follow-up adversarial review caught the corresponding restart seam:
  externally guarded deletion also blocked abandoned ephemeral-lease cleanup.
  Startup now uses the exact digest-bound cleanup capability, database
  bootstrap owns failure cleanup from its first schema operation, and focused
  tests cover both reconciliation and configured `RunStore` lifecycle identity.
- Final review exposed that Nuxt did not typecheck the absolute-path,
  local-only plugin graph. Added a dedicated server-local TypeScript project
  to the normal web typecheck and fixed the latent discriminated-union,
  OAuth-state, and numeric-reduction errors it surfaced.
- Added a real two-process SQLite restart drill. A first Bun process now
  commits queued, active, cancellation-in-flight, and terminal fixtures before
  an abrupt exit; a second proves state-based interruption, exactly-once queue
  claims, terminal preservation, and explicit linked-retry execution.
- Adversarial review made fixture creation sequential so deterministic IDs
  cannot race, and bounded every child process so a recovery regression fails
  the test instead of hanging the suite.
- Added the build-time local Studio dashboard shell over shared SSR pages,
  retaining the existing review header in ordinary local and Cloudflare
  builds. Production HTTP, Cloudflare marker, desktop, mobile, import, provider
  isolation, and recording journeys verify the boundary.
- Added the local-only Studio Home over the existing job, run, and connection
  read contracts with active-work, recent-run, provider-health, empty, and
  single-action states. Browser review caught and fixed stale return-after-
  import data plus missing Tailwind utilities for build-injected local pages;
  Playwright now asserts both data revalidation and real desktop columns.
- Reconciled pre-existing Conductor drift exposed by the pre-PR validator:
  adversarial review had added Task 3.6 without increasing the task total or
  reopening Phase 3 verification. The plan now records 29 of 49 tasks complete
  and returns next-work focus to the missing bounded context-file path.
- The full CI browser project exposed unauthenticated Home requests after a
  replayed bootstrap link. Added a dedicated inert launch route, protected
  Home/review/import and run APIs with the same per-launch session, and proved
  invalid/replayed links mount no dashboard or credential/data reads.
- Diagnosed a live `where.appUrl` detail-validation failure. Added one
  sanitized structured-response regeneration, preserved strict Zod authority,
  surfaced the pass-2 CLI boundary, removed empty failed-attempt containers,
  and covered repair, redaction, retry bounds, and cleanup with regressions.
- Adversarial review additionally bounded and identifier-sanitized validation
  path segments so a future record-shaped schema cannot turn a model-controlled
  key into repair-instruction text.
