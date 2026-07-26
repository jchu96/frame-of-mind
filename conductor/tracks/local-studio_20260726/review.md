# Adversarial Plan Review: Local Studio

**Track:** `local-studio_20260726`
**Reviewed:** 2026-07-26
**Initial PR head:** `e94ad8c`
**GitHub review:** [pullrequestreview-4782548342](https://github.com/jchu96/frame-of-mind/pull/5#pullrequestreview-4782548342)

> Historical checkpoint: this review gated the original plan. The user later
> approved implementation, Phase 1 merged in PR #6, and Phase 2 was completed
> in PR #7. The current status is recorded in `metadata.json` and `index.md`.

## Executive Summary

The Phase A local-first direction is viable and better aligned with the product
than cloud-first execution. The initial plan was not safe to implement because
it conflated three lifecycles, weakened the meaning of database projection,
extended loopback trust to credential mutation, and promised video playback
after deleting the only browser-accessible copy.

The revised specification resolves those architecture blockers and adds early
feasibility gates. The track remains large, so it is explicitly an umbrella
program delivered through three slices and multiple pull requests. No phase may
silently skip its stop/go verification.

## Grounded Findings And Resolution

| Severity | Finding | Resolution |
|---|---|---|
| Blocker | Active jobs were called rebuildable projections | SQLite job/events are operational authority until terminal run publication; only completed-run rows are rebuildable |
| Blocker | Reviewer notes existed only in projection storage | Notes/dispositions are removed from the MVP pending a versioned annotation contract |
| Blocker | Loopback/Host validation protected credential mutation | ADR 0006 requires a per-launch local capability/session in addition to peer, Host, origin, and body validation |
| Blocker | `draft` and `staging` were analysis job stages | ADR 0007 separates media-session, analysis-job, and durable-run lifecycles |
| Blocker | Terminal media deletion contradicted timestamp playback | Ephemeral deletion remains default; explicit time-bounded retention or digest-verified reattachment enables playback |
| Should fix | Meeting search and local context had no owned backend work | Added optional `MeetingCatalogSource` and bounded private context-file ingestion |
| Should fix | A green Worker build did not prove local code exclusion | Added early and per-phase artifact/route isolation gates |
| Should fix | Architecture decisions were deferred until implementation | Added canonical ADR index plus ADRs 0006-0008 |
| Should fix | Forty-eight tasks lacked a usable cut line | Added Foundation, Beta, and v1 delivery slices with stop/go gates and rollback |

## Second-Pass Refinements

A second hostile read after the blocker fixes closed four interpretation gaps:

- added an explicit `retained` media state and transitions back to `in_use`;
- added owned `staged_context` metadata without placing transcript bodies in
  SQLite;
- separated local operational migrations from the existing SQLite/D1
  completed-run parity contract;
- assigned the local-only Studio enablement flag and signal-aware executor
  shutdown to implementation tasks.

## Plan Viability By Slice

### Slice 1 - Safe Foundation

Viable only after the Phase 1 spikes prove:

- Nitro/H3 accepts bounded part streaming without whole-body buffering;
- Bun can incrementally write, flush, and atomically seal the chosen protocol;
- the local-session bootstrap can be removed from the visible URL and logs;
- the Cloudflare artifact excludes local-only routes and `bun:` imports.

Failure of any spike changes the contract before implementation continues.

### Slice 2 - Local Studio Beta

Viable after provider catalog capability remains optional and local context has
its own bounded ingestion path. The beta can use the existing run detail page
after completion; timestamp-linked retained-media playback is not required to
validate composer, activity, cancellation, retry, and cleanup.

### Slice 3 - Studio v1

Viable after retention and reattachment semantics are proven with synthetic
large media. The player must never imply media exists when an ephemeral session
has been deleted.

## Research Findings

- Bun documents incremental `FileSink` writes, SQLite transactions/savepoints,
  and a temp-file-plus-atomic-rename pattern. These support the proposed local
  adapter but do not by themselves prove Nitro request streaming behavior.
- Current Nuxt documentation confirms Nitro/H3 server routes and hybrid
  rendering, but the reviewed documentation did not establish a complete,
  production-grade large-request streaming contract for this exact dual-preset
  application. The Phase 1 measured spike is therefore mandatory.
- The existing `MeetingContextSource` on `origin/main` exposes only
  `meeting(id)`. Meeting lists must be a separate optional capability rather
  than a breaking expansion of every provider.
- The existing local auth-off middleware was designed for a read-only viewer.
  Credential and deletion control require a stronger local session boundary.

## Alternatives Reconsidered

### Cloud-first Phase A

Still rejected. It couples the first usable Studio to R2, hosted job durability,
team authorization, cost, and deletion operations.

### Desktop wrapper

Still deferred. Tauri could improve filesystem selection later, but packaging
and updates are not required to validate the browser-plus-Bun product.

### Invoke the CLI and parse its output

Rejected. Structured orchestration and progress contracts are required for
recovery, cancellation, tests, and future hosted execution.

### Persist reviewer notes in SQLite

Rejected. Original user-authored state cannot be called a rebuildable
projection.

## Residual Decisions

These are intentionally not invented in the planning PR:

- exact upload part size and retry window;
- native chunk protocol versus a dedicated resumable upload library;
- allowed time-bounded review-retention durations;
- whether a later release needs an OS credential-vault adapter;
- whether the one-process executor needs to become a supervised child process
  after real workload measurement.

Each must be settled by evidence in the named phase and recorded in a new ADR
if it changes an accepted boundary.

## Author-Side Reader Checks

The revised documents were reread from the perspective of a contributor who
knows only the public repository:

| Reader question | Canonical answer |
|---|---|
| Can v0.2 upload and analyze through the website today? | No. `WEB_WORKSPACE.md` and the runbook identify it as import-only and route execution through the CLI |
| What survives a browser close? | The job continues while the Bun process remains alive; process restart marks it interrupted |
| Which database rows are disposable? | Completed run/item projections are rebuildable; active job/events are operational authority |
| Where does a key entered in Studio live? | Bun process memory only; environment input is the persistent path |
| Why might the review player ask for the recording again? | Ephemeral staging is deleted by default and reattachment must match the manifest digest |
| Does the Worker gain local execution routes? | No. Local-only routes and implementations are excluded and tested absent |
| Can every provider list meetings? | No. Catalog listing is optional; exact meeting-ID entry remains the fallback |

No question requires private context or a fact that exists only in this review.

## Review Verdict

**Historical verdict at review time: ready for human specification review, not
yet approved for implementation.**

The plan is technically coherent after the documented corrections. Approval
should authorize Phase 1 only; later phases remain gated by their verification
and explicit Conductor approval.

Implementation was subsequently authorized. Phase 1 and Phase 2 passed their
stop/go gates; Phase 3 remains the next unimplemented phase.
