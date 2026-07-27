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
- Resolve paths, recipes, and process-memory secrets just in time. Enforce the
  immutable recipe digest, custom/built-in provenance, requested model, focus,
  and provider selection before orchestration.
- Validate every row crossing the database boundary with the shared Zod
  contracts and verify immutable-input digests on reads.
- Keep `migrations/0001_jobs.sql` synchronized with `studioJobSchemaSql`.
