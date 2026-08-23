# Key Facts

- Local context staging accepts only JSON, text, Markdown, SRT, or VTT up to
  8 MiB, returns no path/body/name, expires after one hour, and is absent from
  Cloudflare builds.
- Local file-context execution revalidates exact bytes, normalizes through
  `FileContextSource`, and consumes the process-local lease in the executor
  cleanup path. SQLite stores only its opaque ID and expected SHA-256, never
  transcript content.
- Studio Context drafts persist only a sealed media ID, one typed
  provider/transport meeting identifier or local context ID plus digest, and
  an optional signed transcript offset. File names, paths, transcript text,
  catalog results, and the bounded preview remain unpersisted.
- Bluedot MCP is the only Studio meeting-catalog capability currently
  implemented. Granola MCP/API use exact-ID entry, and a catalog failure never
  changes provider, transport, account, or credential.
- The canonical Bluedot MCP endpoint is `https://app.bluedothq.com/api/v1/mcp`.
- The canonical Granola MCP endpoint is `https://mcp.granola.ai/mcp`; it uses browser OAuth and Streamable HTTP.
- Granola MCP advertises `get_meetings` and paid-plan `get_meeting_transcript` tools.
- Granola also documents `GET https://public-api.granola.ai/v1/notes/{note_id}?include=transcript` for API-key automation.
- Frame of Mind exposes Granola REST only through explicit `--granola-transport api`; MCP remains the default.
- As of 2026-08-22 the repository pins the official `@google/genai` 2.17.1
  package (PR #50; 2.13.0 before that) and the analyzer defaults to
  `gemini-3.7-flash` (b38f8f2; 3.6 flaked at the detail phase). The SDK's
  core client retry (`httpOptions.retryOptions`, 2.15+) is opt-in and not
  used; transport retry remains the adapter's own (PR #47/#48). Verified by
  fault-injection probe and `bun run smoke:gemini` under Bun before merge.
- Version 0.2.1 uses Google's documented two-step resumable Files upload
  protocol under Bun and retains `@google/genai` for polling, stable
  `generateContent`, and deletion.
- The production adapter derives an allowlisted Gemini schema from Zod and
  always applies the complete originating Zod schema locally. The provider
  subset never becomes the durable contract.
- A locally invalid structured response gets one regeneration attempt whose
  added corrective feedback contains schema paths/codes only. The unchanged
  Zod contract still decides whether analysis may proceed.
- Google's current Interactions API uses top-level `response_format` and
  remains Beta. Frame of Mind intentionally retains stable `generateContent`
  for production generation until a later architecture decision changes it.
- The repository vendors Google's official `gemini-api-dev` and
  `gemini-interactions-api` skills at upstream commit
  `47d75caf3bfce63d83ea2c7ed9618d82bff06335`.
- `bun run smoke:gemini` uses generated video to verify production upload,
  index, detail interrogation, and exact deletion without printing payloads or
  remote identifiers.
- Topic-scoped work uses timestamped transcript evidence to select bounded
  operator-owned media derivatives. Semantic scope includes all relevant
  speakers and distinguishes direct request, collaborative clarification, and
  analyst inference.
- The validated two-window run retained nine timestamped screenshots generated
  by the shipped ffmpeg-backed screenshot extractor.
- Each clip's current index request still transfers the full normalized
  transcript unless the operator uses a bounded local context file.
- The analysis contract is `analysis.json`; execution provenance is `manifest.json`; Markdown and self-contained HTML are renderings.
- Full provider payloads and full transcripts are processed in memory but are not persisted in a normal run.
- Local output files and provider token files are created with user-only permissions where the platform supports POSIX modes.
- Embeddings are intentionally absent from the initial release; structured analyses remain useful without a vector service.
- The Nuxt review workspace stores only validated run contracts in SQLite/D1;
  it does not store recording or screenshot bytes.
- The Cloudflare target uses Nitro's module-format `cloudflare_module` preset,
  Workers Assets, a D1
  binding named `DB`, and Cloudflare Access JWT validation.
- Schema v2 binds `analysis.json` to `manifest.json` with a shared run ID and
  canonical analysis SHA-256; import and hydration fail closed on divergence.
- Schema v3 is the explicit video-only pair: `context.mode` is `none`, media is
  local-file only, and meeting/transcript/provider/alignment fields are absent.
  Core readers and SQLite/D1 projection accept v2/v3 through separate tables.
- `analysis_run_registry` prevents a run ID from crossing the v2 meeting and
  v3 video-only projection tables, including concurrent import attempts; D1
  parent and child mutations are all registry-version guarded in one batch.
- MCP OAuth credentials are bound to the exact HTTPS resource URL, and custom
  endpoints use isolated origin-hashed token files.
- D1 item import uses transactional `json_each` expansion; list APIs use
  bounded keyset pagination and summary-only selects.
- The accepted Studio Phase A direction uses an authenticated local Bun process
  with concurrency one; hosted execution is a separate Phase B track.
- CLI analysis now runs through a provider-neutral `AnalysisOrchestrator` with
  typed progress, cooperative cancellation, explicit factories, and an
  optional post-publication projection publisher.
- A validated run is durable at atomic staging-directory rename. Projection
  failure returns a sanitized warning and cannot invalidate the bundle or
  rewrite its frozen cleanup provenance.
- Projection receives cloned validated contracts without the authoritative run
  directory path. The projection port cannot mutate bundle files through its
  interface.
- Local Studio jobs/events use separate local-only SQLite tables and Bun
  `BEGIN IMMEDIATE` writes. These operational tables are excluded from D1 and
  Cloudflare builds.
- Job rows retain opaque media/context identifiers and digests, not receipt
  copies or private paths. The private media JSON receipt remains the single
  media authority.
- The local worker claims queued jobs oldest-first and runs one at a time.
  Startup abandons active attempts as interrupted; shutdown cooperatively
  aborts the current signal.
- Process recovery preserves queued and terminal attempts, interrupts every
  abandoned active attempt, and requires an explicit linked retry even when
  durable cancellation intent existed before the restart.
- Studio execution reuses `AnalysisOrchestrator` through a typed adapter. The
  immutable job model and recipe provenance override mutable resolver values.
- Cancellation persists before abort and queued cancellations invoke no
  provider. Linked retries require exact unexpired retained media at creation
  and an `in_use` execution lease; indeterminate publication outranks cancel.
- Local job routes are explicit node-only `/api/studio/jobs` handlers with
  100-row/event caps backed by one Nitro-owned process runtime.
- The local runtime shares one Bun SQLite connection between operational job
  tables and rebuildable completed-run projection, while media receipts remain
  separate JSON authority.
- Only an exact active media execution lease can resolve a private sealed-file
  path; that capability is absent from shared and HTTP contracts.
- External deletion rejects `in_use` media; ephemeral executor cleanup uses a
  separate digest-bound release that startup reconciliation also uses for an
  abandoned lease, and current bytes are rehashed before Gemini.
- Initial jobs require explicit recipe provenance and lease sealed media while
  executing; cleanup deletes ephemeral staging or restores retained staging.
- Studio media sessions, analysis jobs, and durable runs have separate
  lifecycles and authority boundaries.
- New Studio API keys are environment- or process-session-scoped; Phase A adds
  no plaintext API-key store.
- Local Studio media uses server-advertised fixed-size parts, exact
  `Upload-Offset` receipts, streamed SHA-256/MIME verification, and private
  per-user application-data storage outside the checkout.
- After the worker is ready, the local Nitro runtime applies one maintenance
  plan before exposing job routes, reconciles interrupted media writes/seals,
  then schedules non-overlapping maintenance until Nitro closes; Cloudflare
  builds exclude the entire implementation.
- Scheduled maintenance treats any recent worker heartbeat as liveness for
  queued siblings, keeps every nonterminal job as a staging reference owner,
  skips every `in_use` receipt, revisits failed actions on the next plan, and
  preserves durable `cleanup_failed` evidence.
- Local Studio maintenance now owns startup and scheduled media/context cleanup
  plus stale-job interruption through one pure plan. It targets only
  Studio-owned staging copies, executes stale-job CAS operations before a fresh
  cleanup-only plan, preserves every live retained receipt and active lease,
  never inventories the operator's source recording, and exposes only a
  session-guarded sanitized dry-run plan and last-run summary.
- The local Recording page keeps the selected `File` component-local, stores
  only an opaque media ID in session storage, and verifies a complete
  bounded-part fingerprint before a refresh-resume sends missing parts.
- Ephemeral and retained media both carry a server-owned expiry; the seal and
  delete paths share per-session writer exclusion.
- The Studio-enabled Bun build selects a local-only Nuxt UI dashboard frame;
  review-only local and Cloudflare builds select the pass-through SSR review
  frame and exclude Studio shell markers.
- Studio Home composes existing operational jobs, rebuildable run summaries,
  and sanitized connection presence without persisting a dashboard-specific
  aggregate. It revalidates after client navigation.
- Tailwind scans local-only Studio components through an explicit stylesheet
  `@source` because they live outside Nuxt's automatic `app/` source tree.
- Local Studio uses an unauthenticated inert `/__studio/launch` page only for
  fragment exchange; every data-bearing Studio page and API requires the
  per-launch HttpOnly session.
- Local Studio Activity action availability is derived from authoritative job,
  media, provider, and completed-run receipts. Re-import republishes an
  existing atomic run pair into `RunStore`; cleanup retry delegates to the
  media adapter and returns its actual status.
- Local Studio retained playback resolves from a successful job's opaque run
  ID, media receipt, and exact digest. The authenticated local route streams
  the private sealed file without returning its path; expired, ephemeral,
  cleaned, unknown, or mismatched media is unavailable.
- Gemini detail failures are repaired once and isolated per candidate only when
  they cross the typed provider-response boundary; strict Zod remains local
  authority.
- `analysis-outcome.json` separates indexed, selected, limit-omitted,
  validated, accepted, rejected, and failed candidate counts.
- A whole-run failure after remote upload publishes only a sanitized
  `failure-manifest.json` with exact cleanup status.
- `--depth deep` currently means denser indexing and layered prompting using
  one selected model for both passes; role-separated Flash/Pro synthesis is a
  proposed v4 architecture, not shipped behavior.
- `communication-coaching` supports evidence-backed intent-versus-impact and
  missed-cue review scoped to the recording.
- Gemini bills audio input at roughly 32 tokens per second against roughly 300
  tokens per second for video at the default media resolution, so transcribing
  a recording's audio before the video passes adds about ten percent to media
  cost. The local ffmpeg extraction itself costs nothing.
- Gemini's audio MIME allowlist excludes `audio/mp4`, so an `.m4a` derivative
  is rejected. Frame of Mind extracts an ADTS `.aac` file and uploads it as
  `audio/aac`.
- A derived transcript is never persisted to the run bundle. The manifest
  records only its `origin`, transcribing model, and the SHA-256 of the
  formatted transcript text.
- A 2026-07-28 three-run comparison on one 29m42s teaching recording found
  recipe design moved results more than model choice: Flash 3.6 with the
  improved recipe matched Pro on validation (8/8) in about a third of the wall
  time, while Pro's edges were importance calibration and friction-moment
  coverage. Pricing snapshot: Pro roughly $2/M input and $12/M output under
  200K-token prompts versus Flash $1.50/M and $7.50/M — Pro costs ~1.3-1.6x
  per token, not multiples. See
  `docs/spikes/recipe-model-evaluation-runbook-2026-07-28.md`.
- Evaluation fixtures must be genuinely public or self-produced recordings.
  Hosted-online does not mean public; an authorized restricted recording can
  be analyzed but never becomes a shared test fixture.
- The production Cloudflare build emits `hosted-entry.mjs`, includes the
  AD-11 hosted implementation, and defaults
  `NUXT_HOSTED_WORKFLOWS_ENABLED=false`. Its pre-Nitro upload-part intercept
  remains 404 and body-unread until Phase 2 lands; the public Worker has no
  secret and the internal Workflows Worker permits only `GEMINI_API_KEY` in
  the Tier A release shape.
- Better Auth 1.7.1 is workerd-compatible through the direct D1 adapter when
  the Cloudflare bundle externalizes `node:async_hooks`. D1 migration 0006
  stores Better Auth dates as ISO text and invitations as normalized email.
- Hosted auth binds one principal in middleware: Access uses its validated
  subject; Better Auth uses `ba:<userId>`; stacked mode still uses the Better
  Auth principal and records the outer Access subject separately.
