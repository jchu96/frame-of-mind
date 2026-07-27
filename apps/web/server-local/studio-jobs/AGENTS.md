# Local Studio Job Persistence Instructions

- Keep this directory local-only and absent from Cloudflare bundles.
- SQLite job/event rows are operational authority until a terminal run
  publishes; they are not rebuildable projections.
- Store immutable job input and sanitized events, never media bytes,
  transcripts, provider payloads, filesystem paths, signed URLs, or secrets.
- Make idempotency, transitions, cancellation intent, retry lineage, and event
  sequencing atomic.
- Validate every row crossing the database boundary with the shared Zod
  contracts and verify immutable-input digests on reads.
- Keep `migrations/0001_jobs.sql` synchronized with `studioJobSchemaSql`.
