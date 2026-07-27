# ADR 0007: Separate media, analysis-job, and durable-run lifecycles

- Status: Accepted
- Date: 2026-07-26
- Amended: 2026-07-27 — cleanup failure is recoverable; every media mode has
  a server-owned expiry; browser upload sessions bind the complete file

## Invariant

Each state transition must identify one owned resource. Upload progress,
analysis progress, and published evidence cannot share a state machine or imply
the same durability and retention guarantees.

## Context

A browser drops recording bytes before an analysis job exists. A sealed local
copy may be used by one or more explicit attempts. A successful attempt then
publishes a versioned analysis/manifest pair. Treating `draft`, `staging`,
analysis stages, and run publication as one job lifecycle makes idempotency,
cancellation, restart recovery, and deletion ambiguous.

The same ambiguity creates a UX contradiction: deleting staging immediately is
privacy-preserving, but a later review page cannot seek the original file
because browsers do not retain arbitrary local filesystem paths after refresh.

## Decision

Use three separate lifecycles.

### Media session

```text
created -> uploading -> sealed -> in_use
in_use -> retained
retained -> in_use
created|uploading -> aborted
created|uploading|sealed|retained -> expired
sealed|in_use|retained|expired|aborted -> deleting -> deleted
deleting -> cleanup_failed -> deleting
any nonterminal state -> failed
```

- Media sessions use opaque IDs and server-owned paths outside the checkout.
- The server streams parts to disk, enforces byte and part bounds, reserves
  sufficient disk space, and computes the final SHA-256 by streaming the sealed
  file.
- One writer owns a part/session transition at a time.
- Delete and seal use the same per-session writer exclusion, so a disconnected
  browser cannot race cleanup against a seal that is still hashing.
- `cleanup_failed` records a sanitized retryable deletion failure. It returns
  only to `deleting`; it is deliberately distinct from terminal `failed`.
- Original user files are never deleted.
- The default mode is ephemeral: delete the staged copy after terminal job
  cleanup, with a server-owned expiry as the backstop when no job or browser
  receipt survives.
- Retained-for-review mode is explicit and time-bounded, with visible expiry
  and manual deletion.
- A browser-created session records a SHA-256 binding over the ordered upload
  part digests. Resume re-hashes the complete reselected file in bounded parts,
  so matching size, MIME, or a confirmed prefix cannot splice two recordings.
- An expired/deleted recording can be reattached. The Studio accepts it only
  when its streamed SHA-256 matches the run manifest.
- Recording bytes never enter SQLite, D1, the run bundle, logs, or analytics.

### Analysis job

```text
queued
fetching_context
uploading_to_gemini
indexing
interrogating
rendering
cleaning_up
succeeded
failed
canceled
interrupted
```

- Job creation requires sealed media and a validated immutable input receipt.
- Cancellation intent is a durable timestamp/flag, not a backwards state
  transition. The executor observes it, performs cleanup, then reaches
  `canceled`.
- A terminal job never returns to a nonterminal stage.
- Retry creates a new linked attempt with its own ID and idempotency key.
- Restart turns an active job into `interrupted`; it does not invent success,
  failure, or automatic remote resume.
- SQLite job and event rows are operational authority until terminal
  publication. They are not described as rebuildable run projections.

### Durable run

- A successful job atomically publishes the validated v2 `analysis.json` and
  `manifest.json` pair.
- That pair becomes the durable analysis authority.
- SQLite/D1 run and item rows remain rebuildable projections.
- Projection import failure cannot destroy or roll back a published pair.
- Failed, canceled, and interrupted jobs have no synthetic run bundle.

Reviewer-authored notes and dispositions are out of the initial Studio scope.
If added, they require a separately versioned, atomic annotation contract; they
must not exist only in a rebuildable database projection.

## Consequences

Positive:

- state transitions have one resource owner;
- upload resume does not imply analysis resume;
- retry and cleanup semantics are testable;
- the review player has an honest retention/reattachment contract;
- database authority is explicit before and after run publication.

Costs:

- the UI must display media, job, and run status separately;
- reattachment hashes the selected recording before playback;
- retained playback consumes local disk until expiry or deletion;
- initial stage and refresh-resume each read the complete selected file once to
  establish or verify its bounded-memory file binding;
- future annotations need a new durable contract.

## Alternatives Considered

### One end-to-end job state machine

Rejected because media exists before the job and may outlive an attempt.

### Always retain every dropped recording

Rejected because it creates a silent local archive and undermines the
local-first deletion posture.

### Always delete immediately after analysis

Rejected as the only mode because it makes timestamp-linked playback impossible
without reattachment.

### Store review notes only in SQLite

Rejected because projection loss would destroy original user-authored work.
