# Local Studio Job Persistence Instructions

- Keep this directory local-only and absent from Cloudflare bundles.
- SQLite job/event rows are operational authority until a terminal run
  publishes; they are not rebuildable projections.
- Store immutable job input and sanitized events, never media bytes,
  transcripts, provider payloads, filesystem paths, signed URLs, or secrets.
- Make idempotency, transitions, cancellation intent, retry lineage, and event
  sequencing atomic.
- Construct one `LocalStudioJobWorker` singleton per local database. It claims
  queued work before invoking providers and never runs a second in-process job.
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
- An indeterminate publication outcome always outranks cancellation because a
  run may already exist and a retry could duplicate it.
- Resolve paths, recipes, and process-memory secrets just in time. Enforce the
  immutable recipe digest, custom/built-in provenance, requested model, focus,
  and provider selection before orchestration.
- Validate every row crossing the database boundary with the shared Zod
  contracts and verify immutable-input digests on reads.
- Keep `migrations/0001_jobs.sql` synchronized with `studioJobSchemaSql`.
