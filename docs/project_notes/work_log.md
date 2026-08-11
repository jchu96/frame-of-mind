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
- Reconciled the Local Studio track against shipped code: the authenticated
  Recording step and its production-build browser coverage complete Task 6.3,
  advancing the canonical pointer to Task 6.4 and 31 of 49 tasks.
- Restored the track metadata's missing post-orchestration commit ledger for
  Phase 4 hardening, durable jobs, restart recovery, dashboard shell/Home, and
  bounded context staging so logical revert discovery remains traceable.
- Synchronized prompt revision documentation with runtime revision
  `2026-07-27.2`, moved post-v0.2.1 work into Unreleased notes, and merged the
  current Cloudflare Workers types housekeeping update.
- Completed the previously omitted v0.2.1 release steps by creating the
  annotated tag at PR #14's verified merge boundary and publishing the matching
  GitHub release; later Studio and structured-repair work remains Unreleased.
- Built the authenticated Context composer step with exact Bluedot/Granola
  transport selection, bounded Bluedot MCP catalog browsing, Granola exact-ID
  fallback, private local context staging/preview, refresh-safe typed drafts,
  and optional signed transcript alignment bound into immutable job input.
  Production HTTP and browser coverage verify receipt refresh/deletion,
  provider isolation, reload recovery, and the Recording-to-Context journey.
- Browser review exposed Nuxt UI 4.10 radio labels that retained machine-value
  accessible names. Replaced that selector with a native labeled fieldset and
  retained Nuxt UI for the surrounding workflow.

## 2026-07-28

- Revised the Local Studio contract and plan so users may begin with Intent,
  optional Context, or Recording and complete those sections in any order.
  Added focused core-contract and Studio-adoption tasks for honest video-only
  provenance, v2 import/projection compatibility, and fail-closed context
  selection before the remaining composer UI and Run receipt work.
- Implemented the core schema-v3 video-only pair without changing v2: strict
  versioned Zod validation/digests, recording-only Gemini schemas and prompts,
  context-free orchestration/rendering, and a v2-only Studio projection guard.
  Adversarial review closed a possible missing-provider-evidence downgrade.
  `bun run check` passed with 109 CLI tests, 175 web tests, both production
  builds, the Studio HTTP probe, Cloudflare boundary check, and 32 MiB stream
  spike.
- Adopted v3 in Studio immutable input, readiness, execution receipts, shared
  import DTOs, and SQLite/D1 projections. Video-only jobs require Gemini and
  sealed media but no meeting credential; immutable mode mismatches fail
  before orchestration. The additive projection uses separate v2/v3 table
  families plus a shared run-version registry, and run pages render both.
- Task 6.6 verification passed `bun run check` with 109 core tests, 183 web
  tests, both production builds, the Studio HTTP probe, Cloudflare boundary
  audit, and the 32 MiB stream spike. All eight existing browser smoke journeys
  passed; a focused ninth journey then proved v3 import, detail provenance, and
  Local Studio home rendering end to end.
- PR #29 adversarial iteration bound returned schema versions to immutable job
  context, made every D1 run/item mutation registry-version conditional,
  restored full v2 and v3 runtime coverage, and added populated SQLite-upgrade
  plus real Miniflare/D1 tests. Cross-version API imports now return a
  sanitized 409, and the v2/v3 operator review guidance is explicit.
- The post-iteration `bun run check` passed 109 core tests, 188 web tests,
  CLI and both Nuxt production builds, the local Studio HTTP contract,
  Cloudflare boundary audit, and the 32 MiB streaming spike.
- Reproduced issue #30 entirely with synthetic fixtures and implemented strict
  invalid-JSON/schema repair, lossless timestamp normalization, per-candidate
  isolation, balanced outcome counts, and sanitized whole-run cleanup receipts.
- Added explicit `--model`/`--depth` handling, video-only `--source none`, and
  the evidence-backed `communication-coaching` recipe. Documented current deep
  behavior separately from the proposed v4 claim-evidence and role-based
  multi-model architecture.
- Used an internal near-perfect implementation artifact only as a private
  quality benchmark; public architecture and future golden fixtures retain its
  structural rigor without copying meeting, repository, participant, URL, or
  screenshot content.
- Closed the issue #30 adversarial findings: provider transport failures abort
  instead of masquerading as candidate validation failures; upload-processing
  errors retain exact cleanup identity/provenance; outcome counts bind to the
  published analysis; and index text plus failure metadata use the same local
  bounds as durable contracts. `bun run check` passed with 138 core tests and
  188 web tests, and `bun run smoke:gemini` passed upload, index, detail, and
  exact deletion using generated media only.
- PR #31 adversarial review reproduced six additional boundary cases with
  synthetic fixtures: cancellation racing an upload error, malformed upload
  identity, unnamed unconfirmed cleanup, historical offset-form expiration
  metadata, omitted poll identity, and substituted poll identity. The iteration
  pins finalized upload identity through polling and cleanup, keeps cancellation
  non-publishing, sanitizes diagnostic metadata before Zod, makes recovery
  warnings provenance-aware, and preserves existing manifest readers.
- Implemented the derived-transcript ladder: provider transcript, operator
  context file, transcript derived from the recording's audio, none. The new
  rung strips the first audio stream with ffmpeg into a private ADTS `.aac`
  derivative, uploads it as `audio/aac` through the existing resumable Files
  path, transcribes it on the run's own model under strict local Zod with the
  existing single repair, and deletes the remote audio immediately on success
  and failure. `--no-derived-transcript` opts out; a missing ffmpeg or audio
  track is a warning. Prompt revision moved to `2026-07-28.3`. Validated by the
  `test/analysis-orchestrator.test.ts` ladder cases,
  `test/gemini.test.ts` transcribe cases, `test/audio.test.ts`, and
  `test/versioned-contracts.test.ts` coverage of the optional
  `derivedTranscript` manifest field on schema 2 and 3. See ADR 0015.
- Deliberately out of scope and still open after that change: persisting the
  derived transcript as a run artifact and surfacing it in Studio, a
  `frameofmind suggest` recipe-preparation pass, a scene-detect pre-pass,
  duration-adaptive sampling, and automated pre-clipping of source media.
- 2026-07-28: Validated the derived-transcript ladder live and ran the first
  controlled recipe/model evaluation: three runs over one authorized 29m42s
  teaching recording (Pro+recipe v1 standard, Pro+recipe v2 deep, Flash+recipe
  v2 deep). All runs validated 100% of selected candidates with derived
  transcripts and confirmed remote cleanup. Outcome: Flash default confirmed;
  recipe v2 (friction/recovery, learner signals, alternative readings, pattern
  names) outperformed v1 regardless of model. Method captured in
  `docs/spikes/recipe-model-evaluation-runbook-2026-07-28.md`; automating it is
  the top follow-up.

## 2026-08-11

- Authored ADR 0016 (Proposed): decompose recipes into charter slots (stance,
  allowed questions, acceptance, rejection, boundaries, optional phase focus)
  assembled deterministically by the executor under the untrusted-data guard,
  with a single documented trust-precedence ladder and per-phase assembled
  prompt-prefix digests plus model-routing reasons in the manifest.
  Documentation only; no recipe, prompt, or schema code changed.
- Refined ADR 0014 in place (still Proposed): the disposition set gains
  `insufficient-evidence`, claim citations validate fail-closed under the
  ADR 0013 per-candidate blast radius, and v4 runs must report run-level
  unresolved questions and residual risks. Updated the ADR index and
  decisions.md. Implementation of ADR 0016 awaits acceptance; the natural
  first slice is charter schema + assembly with `issue-review` migrated and
  registry tests asserting slot budgets and required boundaries.
- Refined ADR 0016 same day after a prompt-engineering review of the charter
  design against the live prompt code: added label-vocabulary and exemplar
  slots (v2/v3 details[] labels are prompt-enforced only, so they need a
  dedicated slot; recipe-specific accept/reject pairs replace the single
  generic detail-pass example), phase-asymmetric binding (acceptance loose at
  index recall, rejection strict at interrogation precision), data-relative
  charter placement preserving the instructions-after-media recency shape, a
  guard sandwich sentence after the data blocks, positive-before-negative
  slot rendering, a minimal schema-constraint constant replacing enumerated
  caps the enforced schema already guarantees, and risk-ordered migration
  with communication coaching last behind an eval-runbook comparison.
- Implemented the ADR 0016 first slice (charter schema + assembly). Recipes
  may now declare a structured charter (stance, allowed questions max 4,
  acceptance, label vocabulary 1-12, exemplars 1-2, rejection, boundaries,
  optional phase focus), compiled deterministically in recipes/index.ts with
  phase-asymmetric binding and an 8,000-character rendered-instruction guard;
  issue-review migrated with synthetic exemplars while the other five
  built-ins stay on the v1 instruction pair. gemini.ts gained the
  data-boundary sandwich line after the context blocks, a single
  schema-constraint constant replacing enumerated caps in all three phases, a
  softer index-pass rejection line, charter-exemplar suppression of the
  generic evidence example, and an exported promptPrefix. Manifests (schemas
  2 and 3) gained optional promptProvenance (per-phase prefix digests plus a
  model-routing reason derived without env reads); promptRevision moved to
  2026-08-11.1; built-in revision moved to builtin-2026-08-11.1. Charter
  digests use deep canonicalization; v1 recipe hashes are unchanged.
  Validated by recipes/gemini/versioned-contracts vitest additions and the
  full check gate (21 files, 171 tests). ADR 0016 flipped to Accepted.
  docs/RECIPES.md and README document the charter format. Still open: the
  five remaining migrations behind an eval-runbook A/B (coaching last), and
  the issue-review live A/B itself.
- PR #39 (recipe charters, ADR 0016 first slice) went through adversarial
  review and merged as a561869. The independent review pass surfaced two real
  blockers the author pass missed: the enumerated prompt caps are the only
  channel carrying numeric output bounds because the sanitized provider
  schema strips maxLength/maxItems (schema-redundancy premise falsified; ADR
  0016 corrected), and a blanket built-in revision bump would have failed
  Studio's immutable recipe receipts for queued jobs naming the five
  unchanged recipes (bump now scoped per recipe). Also fixed: charter-gated
  index binding across both index variants, charter-aware promptPrefix,
  honest GEMINI_MODEL routing reason, VERSIONING.md row. Fixes in e78658b;
  gate 21 files / 173 tests.
