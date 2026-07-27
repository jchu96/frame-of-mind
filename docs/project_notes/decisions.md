# Decision Notes

Canonical, status-bearing architecture decisions live in
[`docs/adr/`](../adr/README.md). This file keeps concise chronological context
for agent recall and must not become a duplicate ADR authority.

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
