# Decision Notes

Canonical, status-bearing architecture decisions live in
[`docs/adr/`](../adr/README.md). This file keeps concise chronological context
for agent recall and must not become a duplicate ADR authority.

## 2026-08-22 — One plan owns local Studio maintenance

Local Studio replaces independently scheduled media/context expiry work with
one startup-and-interval controller over job, media, and context snapshots. A
pure plan names only opaque IDs and fixed reasons; its executor is idempotent,
and stale-job warning plus interruption is atomic. The operator's original
recording is outside the inventory, a live retained receipt is a deletion veto,
and any recent worker heartbeat protects queued work behind the active job.
Every nonterminal job remains a media/context reference owner until a stale-job
CAS succeeds; only a fresh cleanup plan may then remove its unreferenced
staging, and `in_use` is always a deletion veto. This changes the operational
cleanup mechanism, not the accepted retention or ownership boundaries in ADRs
0007 and 0011.

## 2026-08-22 — Hosted Studio is a principal-scoped Cloudflare boundary

Proposed: Tier A extends the existing Worker, D1, Access application, and
hostname with one Workflow per analysis job and Worker-proxied Gemini resumable
upload. Every row and operation is scoped by validated Access `sub`; recording
bytes are not stored unless retention is explicit. The browser hashes the full
file incrementally in a dedicated Web Worker with `hash-wasm`, and the server
fails closed unless the digest matches Gemini `sha256Hash`. One-shot WebCrypto
and cross-request server hashing were rejected as unbounded and unnecessarily
stateful, respectively. Tier B separately adds principal-bound encrypted
provider connections. See proposed ADR 0018 and `hosted-studio_20260822`.

Adversarial review R1 hardened the proposal before implementation: the existing
viewer/import surface becomes Slice 1 and is principal-scoped while hosted
creation stays dark; hosted uploads use raw 8 MiB parts only after a measured
two-concurrent-stream Nitro spike; provider Workflow steps use explicit
15-minute configs with zero platform retry; and parent, item, and registry rows
all use composite principal keys. Workflow export topology is resolved only by
Task 3.0: pinned Nitro 2.13.4 has no supported named-export seam, so an
internal-only sibling Workflows Worker owns `WorkflowEntrypoint` and Nuxt calls
it through a service binding on the existing Access hostname. Both dry-runs and
a local two-step instance passed. Local SQLite uses reserved
`local:single-user` so shared RunStore SQL stays in lockstep without adding
principal fields to durable run bundles or local job/media ports.

Task 2.0 first measured a NO-GO on the stock built Worker: Nitro 2.13.4 consumes
incoming bodies with `request.arrayBuffer()` before H3, and `hash-wasm` 4.12.0
attempts runtime WASM compilation that workerd forbids. Task 2.0b's wrapper and
`DigestStream` produced a provisional GO against a fast sink. Task 2.0c then
replaced the tee with one counting/digesting `TransformStream`, deleted the
fallback Nitro spike handler, normalized path variants, and expanded Access,
abort, and length tests. The required slow-sink run still retained 8,398,085
backing bytes for an 8 MiB request against a 2 MiB limit; the production-shaped
over-length run returned 200 with a receipt because workerd exposed only the
declared bytes. Task 2.0d then accepted materialization and measured fresh
processes across 1, 2, and 4 MiB parts at concurrency two and four. Every
combination passed its relative hold bound and the 24 MiB absolute backing
growth cap; the largest 4 MiB × 4 case measured 2,842,764 bytes. Task 2.0 is GO
at 4 MiB with a per-principal concurrency cap of four, pending an ADR 0018
amendment. Tasks 2.1–2.4 remain blocked until adoption. Private R2 is the
second unadopted fallback; ADR 0018 remains Proposed.

## 2026-08-11 — Recipes become charters; the executor owns prompt policy

Proposed: recipe intent decomposes into named, bounded slots (stance, allowed
questions, acceptance, label vocabulary, exemplars, rejection, boundaries)
rendered by the executor positive-before-negative, after the media and
context blocks, under a sandwiched untrusted-data guard, so no recipe origin
can occupy a policy position in the prompt. Slots bind the passes
asymmetrically: acceptance loose at index recall, rejection strict at
interrogation precision. One trust ladder — runtime policy, operator
intent, operator context, provider context, derived transcript, recording
content — becomes a stated contract instead of fragments. Manifests gain a
per-phase assembled-prompt digest and a model-routing reason. ADR 0014 was
refined the same day: `insufficient-evidence` disposition, fail-closed claim
citations under the ADR 0013 blast radius, and run-level unresolved questions
and residual risks. See ADR 0016.

## 2026-07-28 — A recording may supply its own transcript

Transcript resolution is a ladder: provider transcript, operator context file,
transcript derived from the recording's audio, none. Deriving one is first-party
evidence support, not fabricated meeting context; the audio being transcribed is
the same media the run already analyzes, so the result adds no claim the
recording does not already carry, and its alignment offset is zero by
construction. That is why it is allowed where inventing meeting context is not.
The rung runs only when the ladder above it produced nothing and the operator did
not opt out, its failure is nonfatal, and the manifest labels the provenance so a
reviewer can tell a derived transcript from a provider one. See ADR 0015.

## 2026-07-27 — Local context staging is bounded and single-use

Studio accepts only five text-oriented formats through an 8 MiB private upload.
The receipt stays outside SQLite, execution normalizes through
`FileContextSource`, and the executor deletes the staged copy when its lease
ends. One-hour expiry is the abandoned-upload backstop. See ADR 0011.

## 2026-07-27 — Resumable upload is shipped; local Zod remains authoritative

The production Bun adapter uses Google's documented resumable Files upload,
the SDK for status/generation/deletion, an allowlisted provider schema, and the
complete local Zod contract. Beta Interactions remains outside production.
See ADR 0010.

## 2026-07-27 — Transcript-first scope is semantic, not speaker-exclusive

Topic- or speaker-focused analysis selects bounded local media derivatives
before Gemini upload, while retaining the complete relevant conversational
turn. Direct requests, collaborative clarification, and analyst inference stay
distinguishable. See ADR 0009.

## 2026-07-27 — The repository skill has no activation shim

`.agents/skills/frame-of-mind/` is the canonical real skill. The maintainer's
dotfiles, Codex, Claude, and shared-agent discovery paths symlink directly to
it. Portable colleague and Windows installs may copy that directory through the
managed installer.

## 2026-07-26 — Local Studio runs through Bun before hosted execution

Phase A is a Nuxt Studio controlled through a per-launch authenticated local
Bun process with concurrency one. Phase B hosted execution remains a separate
track behind compatible job/media contracts. See ADR 0006.

## 2026-07-26 — Media, jobs, and runs have separate authority

Media upload/retention, analysis execution, and published v2 runs use separate
lifecycles. Active SQLite jobs are operational authority, while completed
SQLite/D1 run rows remain rebuildable projections. See ADR 0007.

## 2026-07-26 — Studio does not create a plaintext API-key vault

New API keys resolve from the environment or Bun process memory. Existing
provider OAuth state keeps its exact-resource private token storage. See ADR
0008.

## 2026-07-25 — Providers supply context, media is a separate input

Bluedot, Granola, and local files implement one meeting-context contract. The screen recording is passed independently. This preserves the core invariant when a provider has transcripts but no downloadable video.

## 2026-07-25 — Claude Artifacts are a renderer, not storage

The durable source of truth is a portable local run bundle. `report.html` provides an artifact-like, self-contained review surface that can be opened locally or attached to another workflow. Platform-specific Claude output may be added as an exporter, but no analysis depends on Claude-hosted artifact state.

## 2026-07-25 — Keep generated data outside the checkout

Default runs use the operating system's per-user application-data directory. This prevents accidental commits, keeps public clones clean, and makes retention an explicit operator concern.

## 2026-07-25 — Persist excerpts and hashes, not raw provider context

Normal analyses retain recipe-relevant excerpts plus recording/transcript hashes. They do not persist raw MCP payloads or complete transcripts. A future opt-in archive must have an explicit retention and encryption design.

## 2026-07-25 — Frame of Mind is a multi-purpose video-understanding product

Issue evidence is one recipe, not the product boundary. The public brand is Frame of Mind, repository slug `frame-of-mind`, CLI `frameofmind`, and skill `frame-of-mind`. Positioning: “Video in. Understanding out.”

## 2026-07-25 — Granola MCP and REST API are explicit peer transports

Browser OAuth is the default colleague-run path. The official REST API is an explicit `--granola-transport api` path for eligible keys and automation. The tool never silently falls back between identities.

## 2026-07-25 — The review database is a projection

The portable run bundle remains authoritative. A Nuxt SSR workspace may import
reviewed `analysis.json` and `manifest.json` into local SQLite or Cloudflare D1.
Hosted imports are explicit and protected by Cloudflare Access plus in-app JWT
validation.

## 2026-07-26 — Run bundles are cryptographically paired

Schema v2 places the run ID in both contracts and the canonical
`analysis.json` SHA-256 in `manifest.json`. Import and hydration revalidate the
pair; normalized database columns are only a projection and must match it.
Schema v1 imports fail closed and must be regenerated.

## 2026-07-26 — MCP OAuth credentials are exact-resource scoped

Canonical provider endpoints retain stable token paths for usability. Every
custom HTTPS endpoint gets an origin-hashed token path, and stored credentials
include the exact MCP resource URL. No provider token may cross that boundary.

## 2026-07-25 — MCP follows the read-only retrieval pattern

The first Frame of Mind MCP surface is deferred to the next iteration. Local
stdio and Cloudflare Streamable HTTP will share read-only run query contracts;
analysis, media, provider authentication, deletion, and publishing stay outside
the initial tool set.

## 2026-07-27 — Cleanup failure is recoverable, media failure is terminal

Local media deletion transitions through `deleting`. A failed filesystem
cleanup persists `cleanup_failed` and may retry only through `deleting`;
terminal `failed` is reserved for corrupt or irreconcilable receipt/file state.
This prevents the UI from claiming deletion while preserving an honest repair
path. See the amended ADR 0007.

## 2026-07-27 — CLI and Studio share one analysis orchestrator

The CLI owns argument parsing and terminal rendering only. Provider access,
Gemini analysis, cancellation boundaries, cleanup, validation, atomic
publication, and optional projection are implemented once in the typed
`AnalysisOrchestrator`. The future Bun executor consumes its events directly;
it never shells out to the CLI or parses display text.

## 2026-07-27 — Job SQLite does not duplicate media receipt authority

Local job and event tables are operational authority for execution only. They
store the opaque media/context references and digests required by immutable job
input, while Phase 3's private JSON receipt remains authoritative for media
existence, retention, and cleanup. D1 remains limited to completed-run
projection tables.

## 2026-07-27 — The first executor is one process-local durable worker

One singleton worker per local SQLite database claims queued attempts
oldest-first and runs at concurrency one. Repository state, not an in-memory
queue, remains authoritative. Startup marks abandoned active attempts
interrupted; shutdown uses cooperative abort and waits for cleanup. The typed
adapter reuses `AnalysisOrchestrator` and binds immutable model/recipe/provider
values rather than invoking or scraping the CLI.

## 2026-07-27 — Cancellation and retry share one control service

`LocalStudioJobControl` persists cancellation before signaling the worker and
creates linked retries only after the separate retained-media receipt proves
the exact digest and expiry. Existing retry idempotency keys replay before the
media check; new retries recheck retained media again immediately before
orchestration and lease it as `in_use` until execution cleanup. A possibly
published indeterminate result outranks concurrent cancellation.

## 2026-07-27 — Job HTTP surface fails closed before runtime wiring

Local job endpoints live under the already session-protected
`/api/studio/jobs` prefix and are registered only in enabled node-server
builds. Their route/service contracts are present before the process singleton,
but return HTTP 503 until repository, control, worker, and executor are wired
together; a route must never acknowledge work that cannot execute.

## 2026-07-27 — One local runtime owns job execution and run projection

The local Nitro process constructs one Bun SQLite connection, job repository,
worker, control service, typed orchestrator adapter, and completed-run
projection. Private media paths resolve only during an exact `in_use` lease.
Job execution never opens an interactive OAuth callback; missing or expired
provider authorization requires explicit reconnection.

## 2026-07-28 — Context enrichment is optional and explicit

Studio supports both video-only and context-enriched analysis. Recording and
Intent are required, while Context may be completed before or after them. A
video-only run records the absence of external context through a versioned
contract; it never fabricates a meeting, transcript, provider, or alignment,
and a failed context source never silently changes the user's selected mode.
The durable pair rules are canonical in
[ADR 0012](../adr/0012-explicit-video-only-run-provenance.md).

## 2026-07-28 — Provider response failures are bounded per candidate

Missing, invalid-JSON, and schema-invalid Gemini responses regenerate once
under unchanged Zod authority. Typed detail failures are isolated; valid
candidates remain publishable with a sanitized outcome, and whole-run failures
after upload receive a minimal cleanup-provenance receipt. See
[ADR 0013](../adr/0013-defensive-gemini-response-boundary.md).

## 2026-07-28 — Evidence and artifact families evolve together, not invisibly

The proposed next analysis schema separates evidence and claims from composed
findings, procedures, technical explanations, coaching reports, and Q&A.
Current v2/v3 recipes remain compatible, and mixed Flash/Pro passes wait for
per-role model provenance. See
[ADR 0014](../adr/0014-versioned-evidence-and-artifact-families.md).

## 2026-07-28 — Flash stays the default model; Pro is a deliberate upgrade

A controlled three-run comparison (same recording, recipe, depth, and moment
budget) showed gemini-3.6-flash matching gemini-pro-latest on validation and
core findings at about a third of the wall time. Pro remains available via
`--model` for deliverable coaching passes where importance calibration and
friction coverage matter. Model comparisons must follow
`docs/spikes/recipe-model-evaluation-runbook-2026-07-28.md`, and its golden
fixture must be a genuinely public or self-produced recording.

## 2026-08-22 — Sentry telemetry is opt-in and codes-only

Frame of Mind sends no Sentry events unless `SENTRY_DSN` is set. Explicit
capture paths create synthetic code-only exceptions, and one shared scrubber
constructs a new event from a closed top-level allowlist before transport.
SDK auto-capture for Nitro errors, tracing, transactions, and package metadata
is disabled; Nuxt app/Vue error hooks can only pass a synthetic code. The
durable boundary and disable procedure are
canonical in [ADR 0017](../adr/0017-opt-in-sentry-telemetry.md).
