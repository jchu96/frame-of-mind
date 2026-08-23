# Work Log

## 2026-08-23

- Repaired the root-script dependency contract after repeated red runs went
  unnoticed: root scripts now own their `jose` dependency and repository
  hygiene rejects undeclared bare imports under `scripts/` and `test/`.
  A real Windows runner proved that the lockfile drift was a cross-drive
  fresh-clone path rewrite, not an optional package; Windows clones now stay on
  the source drive. After PR #94 landed, CI was split into a 15-minute fast and
  local `check` job and a required 40-minute Playwright-enabled hosted-contract
  job while retaining the three-platform fresh-clone matrix. The complete local
  and GitHub receipts are recorded in the fleet STATUS.

- Closed the Cloudflare Email Service adversarial review's three should-fix
  findings before go-live. A present `EMAIL` binding with no sender now fails
  closed as code-only `E_MAILER_FROM_UNSET`, and binding failures cannot fall
  through to the configured HTTP transport. Migration 0009 adds a nullable
  invite-row timestamp; the Better Auth before-hook reserves it with a
  conditional update, production limits the route to three requests per 15
  minutes, and the second request inside 60 seconds returns
  `MAGIC_LINK_COOLDOWN` without another send. Focused mailer tests (6/6), web
  typecheck, and the built-workerd hosted-auth contract passed; the latter
  applied migrations `0001..0009` twice and emitted
  `magic_link_cooldown=PASS seconds=60 mailer_calls=1`.

- Added binding-first Better Auth magic-link delivery through Cloudflare Email
  Service with explicit sender configuration, dual-part five-minute sign-in
  copy, HTTP fallback, and code-only fail-closed telemetry. The hosted-auth
  spike now proves the local `send_email` simulator and HTTP variants while
  retaining the zero-delivery uninvited-email receipt.

- Added the long-lived `bun run hosted:local` reviewer topology: isolated
  built Workers, fake GitHub/Gemini/mailer, seeded Better Auth invites when
  that adapter is present, and a generated Access-header proxy fallback on
  the current Access-only base.

- Consolidated browser verification into smoke, hosted, adversarial, and
  deployed-canary Playwright projects. A shared OS-temp isolation helper now
  assigns unique ports, Wrangler persistence roots, and local D1 names; hosted
  HTTP contracts retain HTTP assertions and no longer drive Chromium.

- Integrated the E2E harness branch with pluggable hosted auth. Better Auth
  browser sessions now use real cookies and seed fixtures against their
  generated `ba:<userId>` principals; the streaming oracle supplies the full
  built module graph to Miniflare. Focused typecheck and the 10-test hosted plus
  adversarial E2E project passed after the merge.

- Closed PR #84 review findings SF1–SF2 by routing the hosted-auth and hosted
  streaming spikes through the shared run-scoped isolation helper. Two
  concurrently launched auth checks completed with distinct Worker/D1 names,
  and the standalone streaming spike retained every bounded-stream oracle.

- Re-integrated the E2E harness after hosted Phase 2 retired the standalone
  hosted-stream spike. The root check now covers the new hosted-media HTTP
  contract plus the consolidated E2E project; hosted-media uses the shared
  run-scoped identity helper, and workflow media cases retain the harness
  lease, retry settling, and race-failure diagnostics.

- Completed the first hosted UX pass on 2026-08-23. Hosted mode now has one
  navigation, an Intent → Context → Recording → Run stepper, one-click intent
  selection, an honest recording-upload empty state, a three-card review, and
  plain-language Activity, Results, viewer, error, review, and support surfaces.
  The shared hosted screens use semantic Nuxt UI tokens and every hosted page
  sets a useful document title. The Access browser contract captures desktop
  and mobile visual receipts and proves principal-scoped review and support
  denial; `docs/UX_COPY.md` records the copy contract and glossary. Validated
  under the machine-wide gate lock by `bun run check` (22 Vitest files / 212
  tests; Bun web suite: 40 files / 304 tests; Local Studio HTTP, both hosted
  Access modes, both hosted Workflow modes, auth workerd proof, release
  rehearsal, and 32 MiB streaming proof passed), `bun run test:e2e:hosted`
  (hosted browser and 3-admitted/7-rejected spend race passed), and
  `bun run test:e2e:smoke` (13 passed).

- Final-integrated the consolidated E2E harness with the hosted UX pass. The
  hosted Workflow contract retains its first-user browser and visual receipts
  while using run-scoped Worker/D1/port/persistence identities, and its final
  concurrent admission burst drains every admitted Workflow before cleanup.

- Completed the standalone hosted direct-upload spike on 2026-08-23. A real
  Chromium page on an ephemeral loopback origin PUT a generated 20 MiB MP4 to
  a keyless Gemini resumable session in 16 MiB + 4 MiB chunks, then a fresh
  browser queried the exact accepted offset. Browser final response delivery
  was indeterminate (`NetworkError` and `TimeoutError` were both observed),
  while Worker query proved `final`, recovered the
  exact File receipt, and enabled `files.get` size/digest verification plus
  exact deletion. Unauthenticated new-file/list attempts returned 404/403.
  Added `scripts/spike-hosted-direct-upload.ts` and the GO-for-review ADR 0018
  Amendment 2 proposal; no deployed route, Wrangler file, PR, merge, or
  production state changed.

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

## 2026-08-22

- Addressed PR #72's release-hygiene review findings. The scanner now detects
  Cloudflare token/global-key assignments, AWS and Azure signed URLs, and
  SRT/VTT dialogue blocks; allowlisted placeholders exempt only the overlapping
  pattern occurrence. Added an 11-fixture embedded self-test to the normal
  repository gate and replaced the CLI's stale model examples with the shared
  default-model constant. The focused self-test, working-tree and all-ref
  history scans, CLI typecheck, and CLI tests passed.
- Completed Local Studio Tasks 9.1, 9.2, 9.3, and 9.5. Reconciled the public and
  operator documentation against shipped Local Studio Phases 1-8 and the
  hosted-dark Access, Workflow, spend, telemetry, and release-preparation
  boundary. Added the public data-classification contract and a repeatable
  repository-hygiene gate covering tracked and nonignored working-tree files;
  the one-time all-ref history sweep passed after scanning more than 95,000
  added lines.
  Updated the local track to link the separate Hosted Studio proposal, record
  ADR 0018's Worker-proxied Gemini boundary, and leave Amendment 1's 4 MiB x 4
  materialization limit, Phase 2, Tasks 5.1/5.2, and production deployment
  explicitly pending. `bun run check` passed the repository scan, typechecks,
  tests, builds, Local Studio HTTP contract, hosted Access/Workflow contracts,
  release rehearsal, and 32 MiB streaming spike. Task 9.3 added a depth-one
  fresh-clone install/build/CLI/Studio proof, a v0.2.1-to-HEAD upgrade proof
  that reopens and migrates the same temporary SQLite database, macOS/Linux CI
  boot coverage, and an honest Windows install-only lane with LF checkout.
  Exact-HEAD receipts were `FRESH_CLONE install=PASS build=PASS
  studio_boot=PASS` and `UPGRADE install=PASS build=PASS studio_boot=PASS
  migration=PASS`. Task 9.4 remains open.
- Created the proposed `hosted-studio_20260822` Conductor track, eight-phase
  Tier A/Tier B plan, and ADR 0018 for principal-scoped Cloudflare creation.
  The approved upload design hashes incrementally in a dedicated browser Web
  Worker with `hash-wasm`, uses WebCrypto only as a small-fixture oracle, and
  fails closed unless Gemini's final digest matches. Corrected the Cloudflare
  build from legacy `cloudflare-worker` to module-format `cloudflare_module`.
  Validated by `bun run check`: 21 Vitest files / 202 tests passed; Nitro built
  with `cloudflare-module`; the Cloudflare boundary reported 55 forbidden
  markers absent and 2 hosted review markers present; the 32 MiB streaming
  spike completed with atomic seal and bounded heap growth.
- Implemented Local Studio Task 6.7: authenticated Intent route and sanitized
  built-in recipe catalog, strict custom-recipe/focus/model draft validation,
  shared Intent/Context/Recording readiness, explicit recording-only Context,
  and media-independent Context draft v2 with legacy migration. Home and all
  composer pages now share the same readiness state and expose order-free
  navigation. Validated by `bun run check` (Vitest: 21 files / 201 tests; Bun
  web tests: 196), the production Studio HTTP contract, a clean Cloudflare
  boundary, and the focused Playwright Intent keyboard/error smoke.
- Addressed Task 6.7 adversarial-review findings: Context v1 migration now
  survives failed write-back, built-in Intent drafts pin recipe revision,
  catalog failure retains a safe default-model path, and custom drafts disclose
  their staging limitation without changing readiness. Split the pure composer
  readiness reducer from its Nuxt state wrapper so direct Bun coverage remains
  available with an explicit `useState` import. Validated by `bun run check`
  (Vitest: 21 files / 201 tests; Bun web tests: 199), the production Studio HTTP
  contract, a clean Cloudflare boundary, and 11 Playwright smoke tests.
- Closed the final Task 6.7 delta review by moving the default Gemini model to
  a dependency-free adapter constant, gating its local-only public runtime key,
  and extending the hosted-artifact boundary marker set. Composer ordering now
  covers three permutations, and the catalog-failure smoke rejects unexpected
  client errors while allowing only its synthetic HTTP 500 console message.
- Implemented Local Studio Task 6.8 and closed Phase 6: the authenticated
  `/run` receipt binds the exact sealed media digest, explicit Context choice,
  built-in recipe revision, model/focus, and server-owned retention policy.
  `POST /api/studio/composer/jobs` resolves private media and recipe evidence
  server-side, rejects custom/stale/missing inputs before insertion, and
  delegates validated create/replay to the durable job API. Missing or
  uncommitted Context cannot silently become video-only, and the existing
  executor still resolves enriched Context before Gemini upload. Validated by
  `bun run check` (Vitest: 21 files / 201 tests; Bun web suite and production
  Studio HTTP contract passed; Gemini import and Cloudflare boundaries clean)
  and `bun run test:e2e:smoke` (12 passed), including the complete synthetic
  Intent → Recording → video-only Context → Run → Start flow.
- Hotfixed Studio execution so the sealed media session's validated MIME
  reaches the shared analyzer instead of being inferred from `media.sealed`.
  Typed worker failures now retain sanitized codes in logs, warning events,
  and terminal metadata; Run can commit explicit recording-only context in
  place. Validated by `bun run check` (Vitest: 21 files / 202 tests; Bun web:
  226 tests; both builds, Studio HTTP, Cloudflare boundary, and 32 MiB spike),
  `bun run test:e2e:smoke` (12 passed, including `gemini_request_failed`
  terminal-code honesty), and `bun run smoke:gemini` (`Gemini smoke: passed`).
- Implemented Local Studio Task 7.1 in `f123716`: authenticated `/activity`
  list and `/activity/:id` detail routes over the existing bounded job APIs,
  pure five-state grouping and ordered timeline derivation, and one
  visibility-aware polling controller with bounded backoff and last-good-state
  retention. Home and sidebar links, sanitized terminal banners, immutable
  input summaries, HTTP/session and Cloudflare boundary checks, and the real
  composer-to-timeline browser journey shipped without persistence or
  executor changes. Validated by `bun run check` (21 Vitest files / 201 tests;
  Bun web suite, production Studio HTTP contract, local/Cloudflare builds,
  boundary check, and streaming spike passed) and
  `bun run test:e2e:smoke` (12 passed).
- Addressed the Task 7.1 fix-round findings: the visible Activity list now
  keeps its three-second poll alive when empty or all-terminal, detail loading
  follows the event cursor through a bounded 20 pages, and UI event parsing
  strips additive fields while retaining the shared domain validation and
  sanitized warning message. Added direct regressions for cross-window list
  discovery, three-page event ordering, additive warning fields,
  cancellation-request timeline rows, authenticated detail SSR, and the
  grouped-row smoke click.
- Added opt-in, errors-only Sentry telemetry under ADR 0017 for the CLI and
  local Studio. A shared code-only scrubber drops non-code exception text and
  removes request, user, breadcrumb, stack, and non-allowlisted metadata; the
  local worker and Gemini adapters preserve only sanitized failure/status
  codes. Cloudflare remains telemetry-free because the Nuxt module is gated
  off for that preset. Validated by `bun run check` (Vitest: 22 files / 210
  tests; Bun web suite: 223; Studio HTTP, Cloudflare boundary, and 32 MiB
  streaming spike passed), `bun run test:e2e:smoke` (12 passed),
  `bun run smoke:gemini`, and live Sentry transport event
  `56337fa242e84b378dfebd9aa1274e87` (no auth token was available for
  dashboard read-back).
- Closed the ADR 0017 blocker by replacing mutation-based scrubbing with a new
  event constructed from a closed top-level allowlist. Added the reviewer's
  worst-case fixture both directly and through the real `@sentry/bun` envelope
  serializer, disabled SDK package/integration enrichment, Nitro error capture,
  transactions, and browser tracing, and made empty-DSN startup skip SDK init.
  Validated by `bun run check` (Vitest: 22 files / 212 tests; Bun web suite:
  223; Studio HTTP, Cloudflare boundary, and 32 MiB streaming spike passed),
  `bun run test:e2e:smoke` (12 passed), and `bun run smoke:gemini`.
- Revised the Hosted Studio track after adversarial review r1: made principal
  scoping the first independently deployable slice, added hard streaming and
  Workflow-export spikes, fixed the raw 8 MiB resumable-part and Gemini-offset
  contracts, made Workflow retries and receipts explicit, and closed every
  listed security/threat-model residual. Rebasing ADR 0017 exposed that its
  Sentry preset guard named only the legacy Cloudflare preset; the guard now
  also excludes the deployed `cloudflare_module` preset. Validated by
  `bun run check` (Vitest: 22 files / 212 tests; Bun web suite passed; Studio
  HTTP passed; Cloudflare boundary: 63 forbidden markers absent and 2 required
  markers present; 32 MiB streaming spike passed with atomic seal).
- Implemented Local Studio Task 7.2: a pure action-permission table now gates
  cancel, linked retry, exact-provider reconnect, completed-results re-import,
  and failed-cleanup retry from the authoritative job/media/run receipts.
  Activity detail provides inline confirmations and pending/error states while
  list rows expose cancel only. Added local-only session-guarded re-import and
  cleanup-retry routes, state-machine rejection coverage, authenticated HTTP
  cases, Cloudflare markers, and a browser composer-to-list cancellation smoke.
- Closed the Task 7.2 review round after rebasing onto the opt-in Sentry merge:
  provider reconnect guidance is additive to the still-visible cards, denied
  retry explanations remain visible beside other recovery actions, and the
  repository now rejects canceled parents as well as the UI. Expanded the
  action-table cross product, added a preselected-provider browser check, and
  asserted the exact cancellation-request and canceled timeline rows.
- Completed Hosted Studio Slice 1 identity and row ownership on 2026-08-22.
  Access middleware now binds validated user `sub` or normalized service
  identity once; D1 and SQLite projections use constructor-bound principals,
  composite parent/child/registry keys, and fail-closed cross-owner run IDs.
  Migration 0003 rejects any legacy row with the named operator guard and
  proves zero sentinel rows on an empty D1. The built workerd contract signs
  two same-email/different-sub JWTs and proves isolated list/detail/import,
  service/missing-header denial, and hosted-creation darkness.
- Implemented Local Studio Task 7.3 with one pure activity-progress derivation
  for elapsed time, latest activity, current stage start, terminal freeze, and
  counted progress. Activity list/detail update time values on the shared poll
  tick, use full-unit text for assistive technology, announce stage changes
  once, and create a progress bar only for an event with a real numerator and
  denominator. Validated by `bun run check` (22 Vitest files / 212 tests; Bun
  web suite: 258 tests; Studio HTTP, local/Cloudflare builds, boundary check,
  and 32 MiB streaming spike passed) and `bun run test:e2e:smoke` (13 passed),
  including active elapsed display and terminal elapsed freeze.
- Completed Hosted Studio Task 3.0 and selected topology B. Pinned Nitro 2.13.4
  kept the Nuxt `cloudflare_module` artifact default-export-only, so a sibling
  internal-only Worker owns `HostedWorkflowSpike` and Nuxt reaches it through a
  service binding. Both Wrangler deploy dry-runs passed; two local workerd
  sessions created one instance through Nuxt and completed two persisted steps.
  The spike remains environment-gated and normal Cloudflare artifacts forbid
  its route, source, and binding markers. Validated by `bun run check` (22
  Vitest files / 212 tests, web suite, Studio HTTP, hosted Access contract, and
  32 MiB streaming proof), the executable topology spike, and the standard
  Cloudflare boundary build (70 forbidden markers absent; 2 hosted review
  markers present).
- Completed Hosted Studio Tasks 3.1–3.4 on 2026-08-22. The dark Nuxt adapter
  dispatches one principal-scoped attempt to an internal Workflows Worker;
  migration 0004 adds immutable attempts, provider receipts/events, and atomic
  spend reservations. Every provider step uses an explicit 15-minute,
  zero-retry configuration, reads the sealed media receipt first, and converts
  success-without-receipt into an indeterminate terminal state after cleanup.
  The two-Worker fake-JWKS/Gemini contract proves successful publication,
  foreign-principal denial, one provider call across crash replay, and
  concurrent retry deduplication. No upload path, deployment, or live route was
  added.
- Closed PR #63 Phase 3 review fixes on 2026-08-22. Provider calls now acquire
  a principal/attempt/step claim and append their `provider_call` event in one
  D1 batch before invocation; a claim without a result receipt terminates as
  indeterminate and can only proceed through a user-linked retry. The workerd
  contract crashes after a successful fake provider response, restarts the
  exact failed step, and proves one provider call plus completed cleanup. A
  real `GeminiHostedAnalysisProvider`/`GeminiVideoAnalyzer` contract with fake
  transport also proves the 10-minute model timeout and Files API deletion for
  ephemeral success and receipt-failure cleanup paths. Validated by
  `bun run check` (22 Vitest files / 212 tests; Bun web suite: 271 tests; hosted
  Workflow, Studio HTTP, Access, builds, and 32 MiB streaming spike passed).
- Completed Hosted Studio Task 2.0 with a measured NO-GO. A dark,
  Access-authenticated route and fake Content-Range sink proved exact one
  16 MiB and two concurrent 8 MiB transfers on the built Worker, but the
  emitted Nitro entry materialized each request with `request.arrayBuffer()`;
  inspector backing storage rose by about 32 MiB for the concurrent pair.
  workerd also rejected `hash-wasm` 4.12.0 runtime compilation. Tasks 2.1–2.4
  remain blocked, and an unadopted ADR 0018 amendment proposes short-lived
  private R2 staging rather than silently accepting smaller buffered parts.
- Completed Hosted Studio Task 2.0b and re-issued Task 2.0 as GO. A build step
  emits `hosted-entry.mjs`, which reuses Access JWT verification and bypasses
  Nitro only for the dark upload path; every other request still delegates to
  Nitro. The workerd oracle delivered exact 16 MiB and concurrent 8 MiB bodies,
  matched Cloudflare `DigestStream` SHA-256 to independent fixtures, observed
  `bodyUsed=false` at all three handlers, and reduced concurrent inspector
  backing growth from 33,568,143 bytes to 6,930,496 bytes (repeat: 6,926,400).
  Tasks 2.1–2.4 are unblocked but unimplemented; the R2 amendment is not needed
  and is retained only as a reference. No deploy or production Wrangler change
  occurred. Validated with repeated `bun run check:hosted-stream` runs and the
  full `bun run check` gate.
- Completed Hosted Studio Task 2.0c and re-issued Task 2.0 as NO-GO. Replaced
  the tee with one counting/digesting `TransformStream`, normalized upload path
  variants, deleted the fallback Nitro spike route, and expanded the oracle to
  cover a 2,500 ms slow sink, an over-length source, partial client abort, and
  all Access-negative claim shapes. Path bypass, Access, digest, exact-byte,
  and client-abort checks pass. The decisive slow-sink run added 8,398,085
  inspector backing bytes for an 8 MiB request against a 2,097,152-byte limit;
  the over-length workerd run returned 200 with a receipt after exposing only
  the declared 8 MiB. Tasks 2.1–2.4 are blocked and the private-R2 draft is the
  active unadopted fallback. No deployment or production Wrangler change
  occurred. `bun run check:hosted-stream` intentionally exits nonzero until
  both blockers clear; the ordinary repository gate remains separate.
- Completed Hosted Studio Task 2.0d and re-issued Task 2.0 as GO at 4 MiB
  parts with at most four concurrent parts per principal, pending an ADR 0018
  amendment. The oracle starts a fresh Wrangler process for every 1, 2, and
  4 MiB × concurrency-two/four combination so allocator reuse cannot suppress
  the delta. All six slow-sink combinations passed their
  `part × concurrency × 1.5` hold bounds and the 24 MiB full-run backing cap;
  4 MiB × 4 measured 2,842,764 bytes for hold and peak growth. Runtime
  truncation now authorizes a receipt only for the exact forwarded bytes; an
  early-close short part was rejected with no sink receipt, and partial client
  abort still aborted the sink at 131,072 bytes with no receipt. Private R2 is
  the second fallback. No ADR, deployment, or production Wrangler
  configuration was changed. Validated by `bun run check:hosted-stream`.
- Completed Hosted Studio Tasks 5.3 and 5.4 on 2026-08-22. A versioned spend
  plan reserves trusted duration × the documented conservative 300 video
  tokens/second across an enforced maximum call graph plus headroom; D1 gates
  initial and linked attempts atomically and settles provider usage on every
  terminal path, falling back to the full reservation when usage is
  incomplete. The internal Workflows Worker now owns an optional ADR-0017
  codes-only telemetry envelope port for Access, upload-interface, Workflow,
  spend, publication, and cleanup outcomes; the normal review build resolves
  it to a no-op. Targeted tests, the normal Cloudflare boundary build, the
  two-Worker HTTP contract, and the complete `bun run check` gate passed;
  Tasks 5.1/5.2 remain Phase-2-dependent and no deployment occurred.
- Completed Hosted Studio Tasks 4.1–4.4 on 2026-08-22. The gated hosted shell
  reuses the local Studio composer/activity derivations through shared pure
  modules and a hosted data adapter; Recording consumes only an existing
  sealed principal receipt and states that upload is unavailable. Activity,
  cancel, retry, media, and publication reads are principal-bound and expose
  only opaque IDs plus sanitized receipts/codes. The Workflow now cleans up
  before constructing immutable provenance, validates a real analysis/manifest
  pair, and projects it atomically through the existing D1 `RunStore`; the
  existing viewer resolves the resulting run without any share or ownership-
  transfer path. The focused two-Worker contract prints
  `HOSTED_STUDIO_CONTRACT PASSED` after runtime-dark 404s, two-principal guessed-
  ID denial, cancel/retry, browser composer/activity, and published-viewer
  checks. Pair mismatch and forced D1 partial-write fixtures fail with zero
  projection rows. Validated by `bun run check` (22 Vitest files / 212 tests;
  Bun web suite: 272 tests; local Studio, hosted Access, hosted Studio/Workflow,
  builds, boundary, and 32 MiB streaming contracts passed) and
  `bun run test:e2e:smoke` (13 passed).
- Integrated the merged Phase 4 composer/activity/publication slice into the
  Phase 5a spend/telemetry branch on 2026-08-22. Raw and composer creates now
  share one trusted-duration spend-plan and atomic-reservation service; linked
  retries retain their immutable plan. The two-Worker contract preserves the
  Phase 4 browser, cancellation, foreign-media 404, cleanup-before-publication,
  and viewer checks while proving both create surfaces return sanitized 429
  with no attempt or Workflow receipt after cap exhaustion. `bun run check`
  passed all hosted Access, Studio, Workflow, spend, and telemetry contracts;
  `bun run test:e2e:smoke` passed 13 tests. No deployment or production
  Wrangler change occurred.
- Closed PR #66 review findings SF1–SF3 on 2026-08-22. Spend plan
  `hosted-video-v2` shares Gemini's maximum repair and transport-attempt policy,
  blocks publication when actual usage exceeds reserved usage, marks the
  attempt indeterminate, and caps committed units at the reservation. Failed
  or canceled zero-claim attempts release reservations; the hosted-only,
  principal-scoped janitor idempotently releases expired zero-claim rows while
  retaining the full-reservation fallback for incomplete usage. The built
  Nuxt + Workflow workerd contract concurrently submitted ten unique creates
  against a three-reservation principal and observed three 201 responses and
  seven sanitized 429 responses with only three Workflow-backed attempts. No
  deployment or production Wrangler change occurred.
- Implemented Local Studio Task 7.4 with one pure closed-allowlist projection
  for both Activity's Technical details disclosure and its versioned v1
  support receipt. The formatter emits only sanitized job/stage/terminal codes,
  normalized timestamps, transition-derived stage durations, provider/recipe
  IDs, retention, and cleanup state; adversarial fixtures prove transcript
  text, paths, URLs, tokens, emails, meeting IDs, and raw provider errors are
  excluded. Copy uses the Clipboard API with a visible selected textarea
  fallback, and the same receipt is exposed through a session-guarded local-
  only GET route. Also closed the Task 7.3 review NITs by binding the full last-
  activity screen-reader text, rejecting invalid clocks instead of consulting
  wall time, and recording SHAs `40945d4`, `26290db`, and `dd4b2b4` in track
  metadata. Validated by `bun run check` (22 Vitest files / 212 tests; Bun web
  suite: 283 tests; local Studio HTTP, hosted Access/Workflow, builds, and the
  32 MiB streaming proof passed) and `bun run test:e2e:smoke` (13 passed).
- Prepared Hosted Studio Phase 6.1/6.3/6.4 on 2026-08-22 without deploying.
  The Cloudflare production build now emits a deterministic pre-Nitro wrapper
  that keeps the Phase-2 upload-part path 404-dark without reading its body;
  the AD-11 artifact gate proves six required and nine forbidden markers with
  positive and negative fixture bundles. Committed Wrangler examples describe
  the public module/Assets/D1/service binding and internal D1/Workflow shape
  with `GEMINI_API_KEY` as the sole Tier A secret. The 16.74-second release
  rehearsal applied local D1 migrations `0001`–`0004`, proved replay
  idempotence and byte-stable local import, dry-ran both Workers and the
  previous artifact without `100329`, and verified export/restore rollback
  documentation. `bun run check` passed 22 Vitest files / 212 tests, the Bun
  web suite, local Studio, both hosted Access entries, hosted Workflow/Studio/
  spend contracts, the release rehearsal, and the 32 MiB streaming spike.
  Hosted flags remain false by default; no live Wrangler file, PR, merge, or
  deployment was created.
- Completed Local Studio Task 7.5 on 2026-08-22. One pure maintenance planner
  now joins durable jobs, Studio-owned media/context staging receipts, and the
  worker heartbeat to identify expired uploads, old orphan copies, and stale
  unpublished jobs. Its idempotent executor preserves operator-owned source
  recordings, live retained receipts, and active leases; it records stale jobs
  with sanitized warning and interruption evidence. The controller runs after
  worker readiness, before job-route exposure, and on a configurable
  non-overlapping interval; a session-guarded local-only route exposes the
  sanitized dry-run plan and last-run summary, while Home reports only changed
  runs. Also closed the Task 7.4 review NITs by binding the full list-row
  last-activity accessible text and asserting unknown support-receipt IDs are
  404. Validated by `bun run check` (22 Vitest files / 212 tests; Bun web suite:
  37 files / 291 tests; Local Studio HTTP, hosted Access/Workflow, builds,
  Cloudflare boundary, and 32 MiB streaming proof passed) and
  `bun run test:e2e:smoke` (13 passed).
- Closed PR #69 review SF1 for Local Studio Task 7.5 on 2026-08-22. Maintenance
  now treats any recent single-concurrency worker heartbeat as liveness for old
  queued siblings, and every nonterminal job remains a staging-reference owner
  until its stale-job stage/update CAS succeeds. Stale CAS actions run before
  cleanup; any successful transition triggers a fresh cleanup-only plan, while
  a lost CAS cannot authorize deletion. The executor independently vetoes
  every `in_use` receipt, closing the plan-to-claim race. Added live-worker,
  no-worker, CAS-win, CAS-loss, and claim-race coverage. Also fixed the cheap
  review NIT so the hosted-release boundary receipt counts all 13 forbidden
  markers; the startup-timeout NIT remains open because safe cancellation is a
  separate design change. Validated by `bun run check` (22 Vitest files / 212
  tests; Bun web suite: 37 files / 294 tests; Local Studio HTTP, hosted
  Access/Workflow, hosted release rehearsal, builds, and 32 MiB streaming proof
  passed) and `bun run test:e2e:smoke` (13 passed).
- Completed Local Studio Tasks 8.1 and 8.2 on 2026-08-22. Successful jobs now
  resolve live retained recordings from an opaque run ID, exact job digest,
  and server-owned receipt, then stream them through an authenticated
  local-only route with bounded single-range responses. Unknown, expired,
  cleaned, ephemeral, traversal-shaped, conditional, and malformed requests
  fail closed. Added the responsive `/review/:runId` findings/video/detail
  workspace with keyboard filters, candidate markers, literal untrusted text,
  and an honest no-media state that leaves reattachment disabled for Task 8.4.
  Validated by `bun run check` (22 Vitest files / 212 tests; Bun web suite: 39
  files / 299 tests; local Studio HTTP, hosted Access/Workflow/Studio/spend,
  both builds, release rehearsal, and 32 MiB streaming proof passed) and
  `bun run test:e2e:smoke` (13 passed).
- Completed Local Studio Tasks 8.3–8.5 on 2026-08-22. Review finding and marker
  selection now seeks the canonical evidence timestamp, with J/K and listbox
  keyboard navigation plus signed transcript-offset display as escaped text.
  Expired or deleted media can be reattached to job-backed or imported runs
  only after the server streams and matches the projected manifest digest; the
  private receipt stores the run binding, and mismatches are deleted with a
  sanitized code. Added allowlisted local Markdown copy and analysis/manifest
  JSON download actions with no media or external publication. Validated by
  `bun run check` (22 Vitest files / 212 tests; Bun web suite: 40 files / 303
  tests; local Studio HTTP, hosted Access/Workflow/Studio/spend, both builds,
  release rehearsal, and 32 MiB streaming proof passed) and
  `bun run test:e2e:smoke` (13 passed), including offset/export, matching and
  mismatching reattachment, Cloudflare exclusion, and browser review coverage.
- Closed Local Studio Task 9.4 review SF1 on 2026-08-22. The env-gated
  node-server streaming spike now registers the Studio bootstrap and session
  middleware even when the full Studio surface is off. Its executable proof
  rejects an unauthenticated upload before writing bytes, exchanges the
  one-time launch capability, and preserves the authenticated 32 MiB streaming
  and range contract. The production HTTP contract covers both session states,
  and the hosted artifact gate forbids spike route, source, and flag markers.
  Validated by `bun run check` (22 Vitest files / 212 tests; Bun web suite: 40
  files / 303 tests; Local Studio HTTP, hosted contracts, release rehearsal,
  and streaming spike passed).
- Root-caused the local hosted-spend race flake on 2026-08-23. Under a
  concurrent hosted-auth Chromium/workerd run, the ten HTTP requests returned
  three `hosted_workflow_dispatch_failed` 503s and seven correct spend-cap
  429s, while D1 contained exactly three queued attempts and three 12,000-unit
  reservations against the 36,000-unit cap. The admission transaction was
  correct; unbounded local emulator/browser concurrency made the HTTP oracle
  conflate admission with downstream dispatch. The shared isolation helper
  now gives every top-level E2E runner a stale-safe machine-wide runtime lease,
  while nested fixtures reuse the owner lease and per-run state remains unique.
  Legacy access/Workflow contracts now use run-scoped Worker and Workflow names,
  and the spend-race fixture drains all three admitted Workflows before later
  scenarios. Reverting the runtime lease reproduced the concurrent failure on
  run 6; the fixed hosted-auth spike passed 5/5 concurrent launches, the focused
  Workflow contract passed 5/5 sequential runs, and a single `gate-lock` lease
  around 10 consecutive `bun run check` executions passed 10/10 with
  `admitted=3 rejected=7` each time.
- Completed the pluggable hosted-auth spike on 2026-08-23 without deployment.
  Better Auth 1.7.1 ran in the built Nuxt workerd artifact with direct D1,
  fake GitHub OAuth and captured magic-link browser sign-ins, claimed email
  invites, `ba:<userId>` ownership, and stacked Access subject binding. The
  existing two-principal Access contract and full hosted Studio/Workflow/spend
  contract reproduced their PASS receipts in Better Auth mode by changing only
  the login credential fixture. Added migration 0006, mode-aware membership
  operations, fail-closed rehearsal checks, a spike receipt, and proposed ADR
  0019; the production Wrangler example remains unchanged. Validated by
  `bun run check` (22 Vitest files / 212 tests; Bun web suite: 40 files / 304
  tests; both builds, Local Studio HTTP, default and Better Auth hosted
  Access/Workflow/Studio/spend contracts, auth workerd proof, release
  rehearsal, and 32 MiB streaming proof passed).
- Addressed PR #75's four authentication review findings on 2026-08-23.
  Uninvited magic-link sends now fail before verification storage and mailer
  invocation; Access rejects the Better Auth `ba:` namespace; and the stacked
  browser proof denies a second Access subject before session insertion. ADR
  0019 and the threat model now name magic-link verification as a
  session-minting, first-fetch GET with link-scanner consumption risk instead
  of claiming every mutation is POST. The production GitHub provider also
  requires a verified provider email, and Better Auth membership removal now
  refuses to remove the final invite instead of silently doing nothing.
  Validated by the Access unit fixture, the built-workerd auth spike, and a
  fresh `bun run check` exit 0 (22 Vitest files / 212 tests; Bun web suite: 40
  files / 304 tests; both auth-mode Workflow contracts, release rehearsal, and
  32 MiB streaming proof passed). An initial full run hit the pre-existing
  intermittent workerd hang; the isolated contract and fresh full gate passed,
  and the harness follow-up is recorded in `bugs.md`.
- Completed Hosted Studio Phase 2 direct media upload on 2026-08-23 without
  deployment. Added principal-scoped D1 pending sessions, cap-before-provider
  admission, encrypted capability custody, browser incremental hashing and
  direct resumable upload, reload/query resume, exact Files metadata seal, and
  cancel/expiry cleanup with a seal-race grace. Retired the proxy-entry upload
  interception and fixed-part spike. The built-workerd Workflow harness now
  serializes retryable local dispatch failures and recognizes an exact local
  dispatch failure as an admitted spend-race result while still requiring the
  D1 admission count and separate end-to-end Workflow receipts. Validated under
  the machine-wide `gate-lock` with `bun run check` (22 Vitest files / 212
  tests; Bun web suite: 41 files / 309 tests; default and Better Auth hosted
  Access/Workflow contracts; hosted auth; `HOSTED_MEDIA_CONTRACT PASSED`;
  release migration range 0001..0007; and the 32 MiB streaming proof) and
  `bun run test:e2e:smoke` (13 passed). The hosted media contract used a built
  workerd Worker, fake Files API, and real Chromium to cover cap 429,
  key/capability boundaries, reload/query resume, two-tab exclusion, exact
  seal, three mismatch deletions, principal 404, cancellation, janitor cleanup,
  and seal/janitor concurrency.
- Addressed PR #82 Phase 2 review findings on 2026-08-23. Workflow retained-file
  resolution now fails closed unless provider size and SHA-256 both equal the
  sealed receipt, including a missing-hash Workflow fixture with the sanitized
  `media_seal_mismatch` code. The fake Files API now matches live identity
  timing: pre-final cancel/expiry abandons D1 and relies on provider TTL without
  a nonexistent delete. Added principal-scoped open-session recovery, explicit
  Resume/Discard, page-exit keepalive cancellation, and a Chromium close/new-tab
  contract that proves resume and cap release after discard. Validated by the
  machine-wide locked `bun run check`: 22 Vitest files / 213 tests, 41 Bun web
  files / 313 tests, both hosted Workflow auth modes, the hosted media contract,
  release migrations 0001..0007, and the 32 MiB streaming proof all passed.
- Added the hosted `/sign-in` surface on 2026-08-23 with GitHub OAuth,
  optional magic-link email, friendly invitation/configuration failures,
  same-origin relative return paths, and both server and SPA-navigation
  guards. The built-workerd Playwright spec passes in Better Auth and stacked
  modes; temporarily removing the `/sign-in` exemption made all five browser
  checks fail with a redirect loop, proving the render oracle discriminates.
  The existing auth spike and isolated Better Auth Workflow contract pass.
- Completed Hosted Studio retention and evidence Tasks 5.1–5.2 on 2026-08-23
  without deployment. Retained mode now creates a private principal-scoped R2
  multipart upload behind a one-way, single-use application capability; seal
  verifies the complete R2 size and SHA-256 against the independently verified
  Gemini file. Added a visible 30-day default kept-until receipt, explicit
  owner delete with an active-analysis veto, expired-object and incomplete-
  multipart janitor cleanup, retained range playback, and client-canvas PNG
  evidence in an append-only sidecar stamped with run-manifest, recording, and
  timestamp provenance. The immutable run pair remains unchanged and the
  Stream-thumbnail port is disabled with no dependency. The built-workerd
  contract printed `HOSTED_RETENTION_CONTRACT PASSED` and
  `HOSTED_EVIDENCE_CONTRACT PASSED`; reverting the R2 digest comparison or
  provenance checks makes the named wrong-bytes/missing-source cases fail.
  Locked typecheck and the 313-test web suite passed; the full gate receipt is
  recorded in the worker status after final verification.
- Addressed hosted UX pass-2 functional and accessibility findings on
  2026-08-23. Built-in revisions now share one resolver and the hosted HTTP
  contract starts every catalog goal; sign-out sends the required JSON body,
  reports failure, and proves session deletion. Hosted Tailwind sources are
  explicit, the composer is three accurately numbered steps, terminal states
  are actionable, provider/retention language is plain, and SSR-derived
  activity state plus a serialized clock prevent hydration drift. The browser
  contract now checks the responsive grid, hover/selected rings, focused skip
  link, review columns, single headings, running state, and hydration console,
  with pass-2 desktop/mobile screenshot receipts. Gate receipts follow after
  the serialized acceptance run. Validated by `gate-lock bun run
  test:e2e:hosted`, `gate-lock bun run check:hosted-auth`, and a final
  `gate-lock bun run check` exit 0 (22 Vitest files / 212 tests; Bun web suite:
  40 files / 304 tests; both auth-mode hosted Workflow contracts, sign-out
  browser coverage, release rehearsal, and the 32 MiB streaming proof passed).
- Integrated Hosted Studio Phase 2 from `origin/main` into the UX pass on
  2026-08-23. Recording keeps the production direct-upload lifecycle,
  open-session Resume/Discard recovery, and page-exit abandonment while using
  the three-step composer, plain-language retention choices, and responsive
  pass-2 presentation. Workflow fixtures cover both the UX catalog sweep and
  Phase 2's missing-provider-hash failure, and the refreshed Recording
  desktop/mobile screenshots were visually checked for step-label collisions
  and stale reason messaging. Validated under the machine-wide lock by a final
  `bun run check` exit 0 (22 Vitest files / 213 tests; Bun web suite: 41 files
  / 313 tests; both hosted Workflow auth modes, hosted media/browser recovery,
  release rehearsal, and 32 MiB streaming proof passed) and a final `bun run
  test:e2e:hosted` exit 0 (`HOSTED_STUDIO_CONTRACT PASSED` and
  `HOSTED_WORKFLOW_CONTRACT PASSED`, including the 3-admitted/7-rejected spend
  race). One earlier full-check auth browser process closed unexpectedly; the
  isolated auth gate and the clean final full check both passed unchanged.
- Completed hosted UX pass 3 on 2026-08-23. Recording now uses plain-language
  upload and retention states, renders the configured size limit, collapses a
  sealed upload to `name · duration · size · Replace`, and keeps the mobile
  composer usable at 390 px. Intent exposes an explicit Optional focus label;
  start failures provide code-specific recovery actions; and Activity plus
  Results distinguish recording-only runs with sealed D1 duration and size.
  Added rendered glossary checks, direct label-driven browser coverage, all
  four start-error fixtures, two distinct recording rows, and 26 reviewed
  desktop/mobile receipts under `apps/web/e2e/__screenshots__/ux-pass-3/`.
  Validated by `gate-lock bun run test:e2e:hosted` and a terminal
  `gate-lock bun run check` exit 0: repository hygiene, all typechecks, 22 Vitest files /
  213 tests, 42 Bun web files / 316 tests, both hosted Workflow auth modes,
  hosted media recovery/direct-upload contracts, auth, release rehearsal, and
  the 32 MiB streaming proof passed. One earlier full run hit the documented
  intermittent auth browser closure; its isolated rerun and terminal full gate
  both passed unchanged.
- Closed the PR #86 hosted UX pass-3 review findings on 2026-08-23. Activity
  now joins one principal-scoped batch of tolerant display receipts, so a
  pre-0007 nullable-size row no longer hides valid jobs while execution reads
  remain strict. Recording derives its retention label from the server's
  session policy and omits an unavailable size ceiling. Each reachable Run
  start error owns specific copy and a matching retry, navigation, refresh, or
  support action; removed built-in recipes now return `recipe_not_found`.
  Filename persistence remains intentionally absent because the durable job
  boundary stores only opaque media IDs and digests. The real-D1/browser
  contract and refreshed desktop/mobile screenshots passed under
  `gate-lock bun run test:e2e:hosted`, including the nullable legacy row,
  3-admitted/7-rejected spend race, composer, Activity, publication, viewer,
  and review workspace.
- Hardened the hosted-auth spike on 2026-08-23 after the hub reproduced the
  fresh stacked Chromium closing on its first navigation twice under a clean
  serialized gate. Browser launch now earns a side-effect-free `/api/health`
  readiness receipt before login, retries only the exact TargetClosed family
  once, and leaves all auth mutations non-retried. The discriminator passed
  3/3 and the live `gate-lock bun run check:hosted-auth` contract passed with
  one-attempt readiness receipts in both Better Auth modes.
- Integrated `origin/main` into Hosted Studio Phase 5b on 2026-08-23 with a
  two-parent merge. The seven conflicts preserve the Phase 5b retention and
  evidence contracts alongside main's hosted harness isolation, release
  bindings, documentation, and shipped review-workspace UX; the canonical
  review route is `/review/:runId`. The final serialized `bun run check`
  passed with 23 Vitest files / 217 tests, 43 Bun web files / 317 tests, nine
  hosted/adversarial Playwright tests passed with one intentional skip,
  migrations `0001..0008`, and named retention, evidence, media, spend,
  Studio, Workflow, auth, release, and 32 MiB streaming receipts. The final
  pass-2 review-workspace desktop and mobile screenshots were refreshed and
  visually checked. Browser startup now earns a side-effect-free authenticated
  health receipt and retries only the known DevTools-pipe disconnect once;
  Better Auth fixture seeding stops both live workerd processes before external
  Wrangler D1 writes and restarts them on the same isolated resources.
- Closed the second PR #86 delta review on 2026-08-23. Hosted Activity detail
  now uses the same nullable-tolerant display projection as the list while
  execution remains strict. The real-D1 contract covers the legacy detail and
  a principal-B attempt whose immutable input references principal-A media;
  the exact-message table pins every reachable start code; and denied clipboard
  writes leave the rendered support code selectable without an unhandled page
  error. Integrated `origin/main` at `7a50381`, preserving its run-scoped E2E
  isolation/resource lease and both branches' regression receipts.
- Re-integrated `origin/main` at `2e0f2c8` into Hosted Studio Phase 5b on
  2026-08-23. The merged list and detail routes keep #86's batched,
  NULL-tolerant display receipts while execution remains strict. Recording
  copy now derives the unfinished-upload duration from the Gemini session TTL
  and the `Keep` duration independently from the R2 retention-days policy;
  the browser contract proves `1 hour` and `30 days` respectively without
  exposing internal glossary terms. The run-start error table gives each
  retained-media failure specific copy and a recovery CTA, Activity keeps
  #86's recording rows, and the pass-3 screenshot set was regenerated and
  visually checked. The final serialized `bun run check` passed with 23
  Vitest files / 217 tests, 44 Bun web files / 321 tests, both hosted Workflow
  auth modes, the retention/evidence/media contracts, nine executed
  Playwright tests with one intentional skip, release migrations `0001..0008`,
  and the 32 MiB streaming proof.
- Phase 6 Tier A dark deploy on 2026-08-23 from `main` `24eb948` (PRs #84
  harness, #85 retained media + evidence, #86 UX pass 3, #87 ignore). Followed
  RUNBOOK 6.4: pre-deploy D1 export to private storage (checksum
  `ead2cd15…`), private R2 bucket with a 30-day object-expiry rule and a 7-day
  incomplete-multipart abort rule (no custom domain, `r2.dev` disabled), remote
  migrations `0007` and `0008` applied, both dry-run receipts named the module
  entry, `DB`, `ASSETS`, `RETAINED_MEDIA`, `HOSTED_WORKFLOWS` / `HOSTED_WORKFLOW`
  with no `100329`, `GEMINI_API_KEY` installed on both Workers, sibling
  Workflows Worker deployed first (version `79c4e680…`) and the public Nuxt
  Worker second (version `60147161…`) with `NUXT_HOSTED_WORKFLOWS_ENABLED=false`
  and auth mode still `cloudflare-access+better-auth`. Anonymous probes of `/`,
  `/sign-in`, `/api/session`, `/api/runs`, `/api/hosted/*`, `/hosted/activity`
  and `/api/health` all return `302` to the Access login, including the
  `workers.dev` preview host, so no read-only canary behind Access is possible
  without a human login; the authenticated canary (GitHub sign-in →
  `/api/session` shows a `ba:` principal, hosted routes `404`) is the next step
  and gates the `better-auth` cutover. Hosted creation remains dark.
- `better-auth` cutover completed on 2026-08-23 (ADR 0019 step 4). The first
  live GitHub callback failed with `email_not_found` because the registered
  GitHub App lacked the *Email addresses: Read-only* account permission; after
  the maintainer granted it, `POST /api/auth/sign-in/social` → callback →
  `/` → `/api/session` all succeeded behind Access. PR #89 maps that callback
  error to specific copy. The public Worker was redeployed with
  `NUXT_AUTH_MODE=better-auth` (version `fe9d36b4…`), the maintainer
  re-verified `/` and `/api/session`, and both Access applications in the
  account were deleted — the custom-domain app and the Workers-level
  "frame-of-mind - Cloudflare Workers" app, which kept redirecting every
  hostname until it was removed too. Anonymous probes now return `200` for
  `/sign-in` and `/robots.txt` and `403` for every data and hosted route.
  Membership is the D1 invite table; `access-users.ts` is no longer
  authoritative. Hosted creation remains dark.
- Sharded the 16-step repository gate on 2026-08-23 without reducing logical
  coverage. Fast, local, and hosted lanes now build each required preset once,
  consume fail-closed marked artifacts, isolate outputs, enforce per-step
  process-group deadlines, and cache the five newest content-addressed builds.
  The locked complete sharded gate passed in 324.47 seconds (fast 20.17, local
  38.81, hosted 324.46); hosted was dominated by the two Workflows HTTP modes
  at 62.61 and 95.19 seconds. A separate known Better Auth stall proved the
  single retry and exact 1,200-second `step_timeout` receipt.
- Closed the PR #94 false-green review blockers on 2026-08-23. Build cache keys
  now cover the Git-visible implementation tree and the scrubbed content
  environment, so `src/**` and build-script changes invalidate artifacts while
  Markdown does not; caller `NUXT_*` and `FRAME_OF_MIND_*` values no longer
  enter build children. The PR tier defaults to `origin/main`, fails closed
  when that ref is unavailable, and stays reduced only when every path is on
  the documented safe allowlist. The focused discriminator passed 6/6,
  including cache-key mutation, ambient-environment, tier-selection,
  step-set-equality, preset-mismatch, and owned-process timeout coverage.
  A first simultaneous two-worktree proof then exposed per-step timeout clocks
  starting while sibling contracts waited on the machine-wide workerd/Chromium
  lease. The local and hosted lanes now own that lease once per lane, and child
  contracts inherit only its verified token, keeping both intra-gate and
  cross-worktree waiting outside step timers.
- Email sign-in went live on 2026-08-23 after PR #91: the public Worker was
  redeployed (version `2bf0861d…`) with a restricted `send_email` binding
  (`allowed_destination_addresses` = the invited maintainer addresses),
  `NUXT_BETTER_AUTH_MAILER_FROM` on the onboarded domain, and migration
  `0009` applied remotely. The maintainer's live test succeeded: magic-link
  request `200` → verify `302` → `/` `200` → `/api/session` `200`. The tail
  surfaced two follow-ups dispatched immediately: Better Auth could not read
  the client IP on Workers (`cf-connecting-ip`), so the per-route rate limit
  was a single shared bucket; and `/api/_nuxt_icon/*` was not a public path,
  so the sign-in page's icon request returned `403` before login.
