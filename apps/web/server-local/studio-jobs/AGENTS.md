# Local Studio Job Persistence Instructions

- Keep this directory local-only and absent from Cloudflare bundles.
- Keep `tsconfig.server-local.json` rooted at the production startup plugin so
  `bun run typecheck:web` checks this string-registered local-only import graph;
  Nuxt's generated server project does not discover it automatically.
- SQLite job/event rows are operational authority until a terminal run
  publishes; they are not rebuildable projections.
- Store immutable job input and sanitized events, never media bytes,
  transcripts, provider payloads, filesystem paths, signed URLs, or secrets.
- Make idempotency, transitions, cancellation intent, retry lineage, and event
  sequencing atomic.
- Construct one `LocalStudioJobWorker` singleton per local database. It claims
  queued work before invoking providers and never runs a second in-process job.
- On startup, interrupt only abandoned active attempts. Preserve queued and
  terminal rows, preserve durable cancellation intent, never auto-resume an
  indeterminate provider call, and require a new linked attempt for retry.
- Configure the HTTP API only after the Nitro-owned runtime and worker start
  successfully. Share the runtime's Bun SQLite connection with completed-run
  projection; close it only after cooperative worker shutdown.
- Bind every executor progress event to the claimed job/attempt; the worker,
  not the analysis adapter, owns terminal outcomes.
- Persist operator cancellation before signaling the active AbortController.
  Queued cancellations must settle without invoking providers.
- Create retries only through `LocalStudioJobControl`: replay existing keys
  before checking media, but require an exact unexpired retained receipt for a
  new attempt. Retry execution must acquire `retained -> in_use` before path
  resolution and release `in_use -> retained` afterward. Release retries once,
  reports only a sanitized code, and leaves startup reconciliation as the
  final repair path.
- New initial jobs must validate the exact digest, retention receipt, expiry,
  and `sealed` state through `LocalInitialMediaGuard`; idempotent replays occur
  before checking whether media still exists. Initial execution acquires
  `sealed -> in_use`, then returns retained media to `retained` or deletes the
  ephemeral staged copy during terminal cleanup.
- An indeterminate publication outcome always outranks cancellation because a
  run may already exist and a retry could duplicate it.
- Resolve paths, recipes, and process-memory secrets just in time. Enforce the
  immutable recipe digest, custom/built-in provenance, requested model, focus,
  and provider selection before orchestration.
- Reject custom recipes before queue insertion until their separate staging
  contract exists. Local context-file IDs must resolve to an exact, unexpired
  private receipt before queue insertion and again at execution.
- Acquire context files only for execution, normalize them through the shared
  file adapter, and delete the private copy in the executor `finally` path.
- Never launch OAuth from the background worker. Provider authorization must
  already exist for the exact requested transport; execution is noninteractive.
- Validate every row crossing the database boundary with the shared Zod
  contracts and verify immutable-input digests on reads.
- Keep `migrations/0001_jobs.sql` synchronized with `studioJobSchemaSql`.
