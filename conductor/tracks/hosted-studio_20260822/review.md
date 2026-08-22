# Adversarial Plan Review: Hosted Studio

**Track:** `hosted-studio_20260822`
**Reviewed:** 2026-08-22
**Head SHA:** `c3dc88bbd46fc30f4ef8041fc5daff4a5c2303e8`
**Worktree:** `~/repos/fom-hosted-review` (detached, read-only)

> Gate: same bar as `conductor/tracks/local-studio_20260726/review.md`.
> Attack is on the plan's executable assumptions, not prose quality.

> Historical checkpoint: this review gated the original hosted plan at
> `c3dc88bbd46fc30f4ef8041fc5daff4a5c2303e8`. Attempt 2 rebased onto
> `origin/main` at `8ce93fa`, preserved the reviewer document below, and added
> a resolution ledger after the original verdict. Current proposal status and
> task counts are recorded in `metadata.json` and `index.md`.

## Executive Summary

Tier A on the existing `fom.flickerventures.com` Worker, D1, Access application,
and hostname is the right product shape. Principal-scoped rows, Worker-proxied
Gemini upload, one Workflow per attempt, and a separate Tier B KEK are coherent
trust decisions. The plan is **not safe to implement**.

Four architecture blockers match the class of defect that stopped the original
local-studio plan: an unproven Nitro/Workers streaming contract, a wrong
Workflows timeout/retry assumption against current Cloudflare docs, an
unenumerated unscoped viewer surface, and a 95 MB hosted part size that
collides with the shared local media contract and the 128 MB isolate. Phase 1
alone is scaffolding, not a usable team-mode Studio. A thinner first slice
exists: principal-scope the already-deployed viewer on the empty production D1
before any creation path is built.

## Grounded Findings And Resolution

| Severity | Finding | Resolution |
|---|---|---|
| Blocker | FR-04 and AD-4 require the Worker to stream a ≤95 MB chunk into Gemini without buffering (`spec.md:189-193`, `spec.md:393-397`, `plan.md:80-83`, `plan.md:95-99`), but Phase 2 has no measured Workers/Nitro spike. Memory is **128 MB per isolate, not per request**. Local Studio was blocked on the same unproven Nitro streaming contract and only proceeded after a spike. | Add a Phase 2.0 stop/go spike on the Cloudflare runtime: pipe `request.body` to Gemini with a ≥95 MB (or the revised part size) synthetic body, measure isolate RSS, concurrent two-upload behavior, and confirm h3 does not `readBody()` the stream. Failure changes the upload contract before Task 2.3. |
| Blocker | Spec AD-7 / platform facts claim the ten-minute model timeout is safely below Cloudflare's "recommended thirty-minute maximum configured step timeout" (`spec.md:47-50`, `spec.md:262-264`, `spec.md:436-437`, `plan.md:113-116`). Current Workflows docs default `step.do` to **`timeout: "10 minutes"` and `retries.limit: 5` with exponential backoff**. Thirty minutes is an example, not a documented maximum. A full-length Gemini call therefore races the default step timeout, and a successful call whose D1 receipt write fails is retried as a new billable generate. That contradicts the invariant that steps "cannot silently duplicate provider work" (`spec.md:72`). | Make `WorkflowStepConfig` explicit in Task 3.3: step timeout strictly greater than `MODEL_REQUEST_TIMEOUT_MS` (15–30 minutes), `retries.limit: 0` or `NonRetryableError` after a durable receipt check, and tests that a crashed-after-Gemini step does not start a second generate. User retry remains a new Workflow instance (`spec.md:265`). |
| Blocker | FR-03 requires every SQL predicate to include `principal_sub` and forbids an unscoped runtime path (`spec.md:386-390`). The plan's Task 1.3 is generic (`plan.md:46-49`) and does not list the existing viewer paths that become IDOR the moment a second Access user exists. The migration sketch adds `principal_sub` only to `analysis_runs`, `analysis_run_registry`, and `video_analysis_runs` (`spec.md:525-543`) and leaves `analysis_items` / `video_analysis_items` unscoped. `upsertRunSql` still `ON CONFLICT(run_id) DO UPDATE` with a global `PRIMARY KEY (run_id)`. | Enumerate and scope every path below before hosted routes enable. Import must refuse cross-principal overwrite. Either add `principal_sub` to child tables and composite FKs, or prove every child mutation is unreachable without a parent row already authorized for that principal — and still add a principal predicate on the delete/insert statements. |
| Blocker | Hosted parts are capped at 95 MB (`spec.md:43-46`, `spec.md:190-191`, `spec.md:395`, `plan.md:80`). Shared domain contract `MAX_MEDIA_PART_BYTES` is **64 MiB** (`src/domain/studio-schemas.ts:12`). Raising that cap changes the local Studio media session contract. 95 MB also consumes most of a 128 MB isolate if Nitro or `fetch` buffers. Local Phase B said recording bytes flow browser → R2, not through Worker memory (`local-studio spec.md:412-413`). | Do not raise the shared 64 MiB cap. Give hosted its own part size at or below 64 MiB, preferably the existing 8 MiB default, which is safer for isolate memory and still well under the 100 MB Free/Pro request-body limit. Treat browser → Worker → Gemini as a hosted decision that supersedes the Phase B R2 sketch, and record that in ADR 0018. |
| Should fix | Mid-chunk failure and cross-isolate resume are specified as "reconcile from the server receipt" and "never double-forward" (`spec.md:665-666`) without naming Gemini's offset query as source of truth. D1 `received_bytes` is durable (good — not single-instance) but can disagree with Gemini after a killed stream. | On every part start and retry, query the resumable session (`X-Goog-Upload-Command: query` / size-received) and forward only from that offset. D1 receipts record completed parts; they do not authorize a replay that would overlap Gemini's already-accepted bytes. |
| Should fix | Phase 3 assumes a Nitro `cloudflare_module` Worker can export `WorkflowEntrypoint` (`plan.md:105-108`, `plan.md:204-207`). Workflows require a class export from the Worker module. There is no spike. | Spike Workflow binding against the current Nitro preset before Task 3.1. Acceptable fallback: a small dedicated Workflows Worker with a service binding, still on the same Access hostname. |
| Should fix | ADR 0017 is cited as the telemetry allowlist (`spec.md:318-324`, `spec.md:777`, `plan.md:183-186`) but **does not exist** in this SHA (`docs/adr/README.md` jumps 0016 → 0018). Default Sentry/Workers log payloads can carry `Authorization` or Gemini URLs. | Land ADR 0017, or inline the allowlist into ADR 0018, before Phase 5. Task 5.4 cannot be reviewed against a missing contract. |
| Should fix | Spend caps are Gemini-**call** units (`spec.md:302-308`, `spec.md:452-456`). Video tokens dominate cost; five reserved "calls" can still be unbounded dollars. | Define the unit as a documented estimate (calls × worst-case video-token ceiling) or add a dollar/token ceiling. Keep fail-closed on corrupt cap state. |
| Should fix | Ephemeral hosted review has no ffmpeg and deletes the Gemini file at cleanup (`spec.md:243-246`, `spec.md:466-471`). Canvas screenshots and timestamp playback then have no media unless the browser `File` still exists. Local Studio required retained media or digest-verified reattachment for this reason. | State that ephemeral hosted review has no playback/screenshots after tab close; retained R2 (or reattachment) is required for evidence capture. Record capture-method provenance as already specified. |
| Should fix | Hosted execution has no ffmpeg, so ADR 0015 derived-transcript extraction cannot run. The `transcribe` step (`spec.md:261`, `spec.md:425-428`) does not say whether hosted skips that rung or asks Gemini to transcribe from the video file. | Name the hosted transcript ladder explicitly. Video-only hosted runs must not claim `derivedTranscript` provenance they did not produce. |
| Should fix | Shared `RunStore` / `sql.ts` is used by local SQLite and D1. Adding `principal_sub` predicates without a local schema twin will break local import. `JobRepository` and `MediaStagingAdapter` currently have no principal (`src/domain/studio-ports.ts`). Plan language that "local executor tests remain unchanged" (`plan.md:126`) does not cover RunStore. | Keep local job/media adapters source-split. Give local SQLite a synthetic single principal so D1/SQLite schema stay in lockstep. Do not add `principal_sub` to the local-facing `JobRepository` port; wrap hosted repositories instead. |
| Should fix | `docs/THREAT_MODEL.md` still says hosted execution is out of scope. ADR 0018 does not capture isolate memory DoS, Workflow default retries, D1 export of encrypted Gemini session URLs, Access `sub` recycle on seat removal, or import-overwrite IDOR. | Extend the threat model and ADR 0018 with those rows before Phase 2. |
| Should fix | Current deny-list in `scripts/check-cloudflare-boundary.ts` forbids `OrchestratedAnalysisJobExecutor` and `/activity`, which hosted analysis/UI may need once the gate is inverted (`spec.md:333-341`). | Rewrite the allow/deny lists as AD-11 says, with hosted-specific activity routes if `/activity` must remain a local-only marker. |
| Should fix | Part POST encoding is unspecified. Multipart of a 95 MB file plus metadata can exceed the 100 MB Free/Pro body limit and still 413. | Use a raw body plus headers (`Content-Length`, offset, part number, digest). Never multipart for the bytes. |

## Plan Viability By Slice

### Slice 1 — Identity and scoped viewer (proposed Phase 1 Tasks 1.1–1.3)

Viable as the **first shippable cut**, and thinner than the plan's Phase 1, once
the unscoped query list is explicit. The production D1 at
`fom.flickerventures.com` is empty today, so the first-principal backfill is a
vacuous fail-closed no-op: it still must run, prove zero `__legacy_unclaimed__`
rows, and keep hosted creation disabled. It does not need to be reversible by
mapping rows back to email (`spec.md:651-652`).

This slice is not a Studio. It is a security hardening of the current
review-only Worker and should land before any upload or Workflow code.

### Slice 2 — Phase 1 remainder + Phase 2 upload (as written)

Not viable until the Workers streaming spike passes and the part size is
reconciled with `MAX_MEDIA_PART_BYTES` and isolate memory. Upload-only is still
not a usable team-mode Studio.

### Slice 3 — Phase 3 Workflows

Not viable until StepConfig timeout/retry is corrected against current
Workflows defaults and Nitro can actually export a `WorkflowEntrypoint`.
Idempotency receipts in D1 are the right pattern; platform step retries are not
the same as user-linked retry.

### Slice 4 — Phases 4–6 team-mode Studio

This is the first slice that could produce a usable hosted composer → activity
→ review loop. It depends on Slices 1–3. Spend, retention, and telemetry can
stay in Phase 5 if ephemeral-only is an accepted Phase 4 limitation, but
ephemeral screenshot/playback must be disclosed (see Should-fix above).

### Slice 5 — Phases 7–8 Tier B

Correctly blocked on the Phase 6 gate. Do not start KEK custody until Tier A
cross-principal tests pass. The separate-KEK decision is sound.

## Research Findings

Fetched 2026-08-22 from current Cloudflare and Gemini docs (not training data):

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
  (updated 2026-07-28): request body size is a **Cloudflare account plan**
  limit, not a Workers plan limit — Free/Pro **100 MB**, Business 200 MB,
  Enterprise 500 MB default. Isolate memory **128 MB**. Paid CPU default
  **30 seconds**, configurable to **5 minutes**. HTTP duration unlimited while
  the client stays connected. Simultaneous outgoing connections waiting for
  headers: **6**. Spec's 95 MB < 100 MB is numerically true for Free/Pro raw
  bodies; it is not true that hashing/streaming 95 MB is memory-safe, and the
  plan never confirms the zone plan of `fom.flickerventures.com`.
- [Workers streaming / memory guidance](https://developers.cloudflare.com/workers/platform/limits/#memory)
  and [Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/):
  stream with `TransformStream` / pipe; `arrayBuffer()` / `text()` of a large
  body is an isolate-OOM path. Docs do **not** prove Nitro/h3 leaves
  `getRequestWebStream()` unconsumed on `cloudflare_module`.
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
  (updated 2026-06-15): wall clock per step **unlimited**; CPU per step default
  30 seconds / max 5 minutes; non-stream step result **1 MiB**; event payload
  **1 MiB**; max retries per step 10,000. Spec technical note at `spec.md:811-813`
  about 1 MiB step returns is correct.
- [Workflows sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
  (updated 2026-07-09): **default** `timeout: "10 minutes"`, `retries.limit: 5`,
  `delay: 10000`, `backoff: "exponential"`. `"30 minutes"` appears only as a
  custom-config example. `NonRetryableError` is the documented way to forbid
  retry. `step.sleep` does not count toward the step cap.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): max
  string/BLOB/row **2,000,000 bytes**; **100** bound parameters; query duration
  **30 seconds**. Existing 1.8 MB row and 900 KB parameter caps remain stricter
  and are still valid.
- [Access application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
  (updated 2026-06-25): identity JWTs carry `sub` (stable per email **until the
  user is removed and re-added**) and `email`. Service-token JWTs carry
  **`sub: ""`** and `common_name` equal to the client ID. Spec AD-2 is
  correct. Custom claims (groups) can be trimmed at ~1 KB — rejecting IdP
  groups for Tier A is justified.
- [Gemini Files API](https://ai.google.dev/gemini-api/docs/files): files are
  stored **48 hours**. A Workflow that starts more than 48 hours after seal, or
  retries after expiry, must fail closed rather than loop on default step
  retries. `ensure_gemini_file` must also wait for ACTIVE with `step.sleep`.
- Current in-repo Gemini timeout is `MODEL_REQUEST_TIMEOUT_MS = 10 * 60_000`
  (`src/adapters/gemini.ts:57`), equal to the Workflows **default** step
  timeout.
- Production Access middleware today extracts **email only**
  (`apps/web/server/utils/access.ts:8-20`, `00.auth.ts:45-48`). `sub` is not
  yet an executable principal. `POST /api/runs` writes `imported_by` from that
  email (`index.post.ts:49`); `docs/MCP_ROADMAP.md:237-238` already forbids
  treating `imported_by` as an ACL.

### Existing viewer query paths the plan does not list

All of these are unscoped after a `principal_sub` column exists unless Task 1.3
changes them:

| Path | What it does today |
|---|---|
| `GET /api/runs` → `RunStore.listRuns` | `supportedRunSummariesSql` over both run tables; cursor is `(completed_at, imported_at, run_id)` with no principal (`apps/web/server/api/runs/index.get.ts`, `sql.ts:210-232`, `d1.ts:45-69`) |
| `GET /api/runs/:id` → `getRun` | `WHERE run_id = ?` on `analysis_runs` and `video_analysis_runs` (`[id].get.ts`, `d1.ts:72-101`) |
| `POST /api/runs` → `importRun` | Global registry insert; `upsertRunSql` / `upsertVideoRunSql` `ON CONFLICT(run_id) DO UPDATE`; `DELETE FROM analysis_items WHERE run_id = ?`; `json_each` inserts into item tables (`index.post.ts`, `d1.ts:103-155`, `sql.ts:105-202`) |
| Registry lookup | `SELECT schema_version FROM analysis_run_registry WHERE run_id = ?` (`d1.ts:145-147`) |
| Existence probes | `SELECT 1 FROM analysis_runs/video_analysis_runs WHERE run_id = ?` (`d1.ts:106-111`) |
| Local SQLite twins | Identical SQL via `apps/web/server/data/sqlite.ts` and `schemaSql` |
| `GET /api/session` | Returns `frameOfMindUser` (email, authMode). Not a row query; must not become a principal override |
| `GET /api/health` | No data |

`analysis_items` and `video_analysis_items` are not in the `0003` sketch.
Detail reads currently hydrate from `analysis_json` on the parent row, but
import **writes and deletes** the child tables by `run_id` alone. That is an
unscoped mutation.

Backfill of an empty D1 is safe as a procedure and unsafe as a default: the
`__legacy_unclaimed__` column default (`spec.md:526`) must not remain on the
live schema after the coordinator, which the follow-up rebuild already
requires (`spec.md:648-650`).

## Alternatives Reconsidered

### Browser → private R2, Worker only signs

This is what local Phase B required. It avoids 95 MB through the isolate and
matches retained-media later. It was rejected in AD-4 because ephemeral
analysis should not force custody. That rejection is acceptable **only if**
Worker streaming is measured and parts stay small. If the spike fails, R2
(or much smaller parts) is the remaining honest design.

### Direct browser → Gemini resumable URL

Still rejected. The session URL is a bearer capability; returning it to the
browser would put `GEMINI_API_KEY`-authorized upload in XSS/extension reach.

### One Workflow instance reused for user retry

Correctly rejected. Keep it distinct from **platform** `step.do` retries,
which the plan currently leaves at Cloudflare defaults.

### Email as `principal_sub`

Correctly rejected. Document Access `sub` recycle on seat removal as a
residual operational fact.

### Shipping Tier B credentials in Phase 1

Correctly rejected.

### Call-count spend cap as a dollar bound

Not equivalent. Either rename it so operators do not think it is a budget, or
bind it to a token/dollar ceiling.

## Residual Decisions

These must not be invented during implementation; they need a named spike or
ADR note:

- Cloudflare **zone** plan for `fom.flickerventures.com` (100 vs 200 vs 500 MB
  body limit) and whether a lower account upload ceiling is configured.
- Hosted part size after the streaming spike (recommend ≤ 8–16 MiB, never a
  silent raise of local `MAX_MEDIA_PART_BYTES`).
- Whether Nitro can export Workflows or a sibling Worker is required.
- How Gemini `generateContent` idempotency is approximated when receipts are
  missing (accept duplicate spend vs. operator replay only).
- Hosted derived-transcript behavior without ffmpeg.
- Synthetic local `principal_sub` value for SQLite projection lockstep.
- Whether `GET /api/runs` remains the hosted list route or is replaced by
  `/api/hosted/runs` so local import-only tests stay byte-stable.
- ADR 0017 landing SHA, or an ADR 0018 telemetry appendix.
- KEK/Gemini-key rotation runbook: Tier A fail-closed on encrypted session
  ciphertext is stated (`spec.md:197-199`); operator steps for secret replace
  plus aborting in-flight uploads are not.

## Author-Side Reader Checks

| Reader question | Canonical answer |
|---|---|
| Can the allowlisted team upload and analyze on `fom.flickerventures.com` today? | No. The deployed Worker is review/import-only. Hosted Studio is a plan. |
| Is the production D1 empty? | Yes — operator fact for this review. Backfill still runs fail-closed; it assigns no real rows. |
| What identifies a user? | Validated Access JWT `sub`. Email is display and allowlist input only. Service tokens are `service:<common_name>` after proving empty `sub`. |
| Where does `GEMINI_API_KEY` live in Tier A? | One Wrangler secret. Never D1, logs, Sentry, or the browser bundle. Session URLs are AES-GCM ciphertext in D1 under a key derived from that secret; rotating the secret invalidates in-flight uploads. |
| What survives closing the browser? | The Workflow instance and D1 job/media rows. Ephemeral bytes do not survive in R2. Gemini files last at most 48 hours. |
| Which D1 rows are disposable? | Completed run projections remain rebuildable from the versioned bundle. Active hosted job/event/media/spend rows are operational authority until terminal cleanup. |
| Does local Studio keep working? | Yes if ports stay split. Shared `RunStore` SQL and `MAX_MEDIA_PART_BYTES` must not be silently retargeted at hosted 95 MB parts or unscoped local tests will move. |
| Is Phase 1 a usable team Studio? | No. It is identity, schema, and a scoped viewer. Composer + Workflow + publication (Phase 4, after 2–3) is the first usable hosted loop. |
| Can one Access user read another's imported run once two people exist? | Yes, on the current code, via `GET /api/runs` and `GET /api/runs/:id`. That is why Slice 1 must ship first. |

No question requires private context or a fact that exists only in this review
except the operator assertion that production D1 is empty, which is recorded
here because the live database is not in the repository.

## Review Verdict

**NOT_SAFE**

The architecture is pointed in the right direction and several ADRs (Access
`sub`, no browser Gemini URL, separate Tier B KEK, one Workflow per attempt,
ephemeral-by-default) should survive. Approval must not authorize
implementation of Phases 2–8 until the blockers above are written into the
spec and plan.

A revised plan may authorize **Slice 1 only** (principal-scoped viewer +
migration + empty-DB backfill, hosted creation still dark) after the query
paths are listed and scoped. Upload, Workflows, and composer remain gated on
the Workers streaming spike, the Workflows `StepConfig` correction, and the
part-size reconciliation with the local Studio contract.

## Attempt 2 Resolution Notes

These notes are additive to the historical review above. They record where the
revised proposal resolves each finding; they do not change the original
`NOT_SAFE` verdict at its reviewed SHA.

| Finding | Resolution | Revised evidence |
|---|---|---|
| Blocker: unproven Worker/Nitro streaming | Added hard Task 2.0 with an ≥8 MiB synthetic stream, two concurrent uploads, H3 `readBody()` exclusion, isolate-memory measurement, and contract-change-on-failure gate. | `spec.md:43-51`, `spec.md:217-231`, `plan.md:101-109`, `plan.md:142-146` |
| Blocker: wrong Workflow timeout/retry assumption | Current defaults are cited; every step has explicit 15-minute config, provider retries are zero, receipt checks precede calls, success-without-receipt is non-retryable, and crash-after-Gemini must not generate twice. | `spec.md:52-60`, `spec.md:304-321`, `spec.md:513-531`, `plan.md:167-182` |
| Blocker: incomplete principal scoping | Added principal columns/composite keys for both item tables, composite import conflict semantics, and a file:line checklist of every existing list/detail/import/registry/existence/SQLite/session/health path plus a two-principal built-Worker test. | `spec.md:184-206`, `spec.md:456-462`, `spec.md:619-789`, `plan.md:38-94` |
| Blocker: 95 MB part conflicts with local/isolate limits | Fixed hosted raw-body parts at 8 MiB, left shared local constants unchanged, and recorded hosted browser → Worker → Gemini as superseding the provisional R2 sketch. | `spec.md:217-256`, `spec.md:464-479`, `plan.md:121-137`, `docs/adr/0018-hosted-studio-trust-boundary.md:35-38` |
| Should fix: mid-chunk resume authority | Gemini's queried accepted offset is authoritative on every start/retry; D1 completed-part receipts never authorize overlap. | `spec.md:222-227`, `spec.md:466-471`, `plan.md:121-127` |
| Should fix: WorkflowEntrypoint export assumption | Added Task 3.0 as the sole resolver, with a sibling Workflows Worker + service binding as the decided fallback. | `spec.md:327-331`, `plan.md:151-156`, `plan.md:191-195` |
| Should fix: missing ADR 0017 | Attempt 2 rebased onto `8ce93fa`, where accepted ADR 0017 exists; telemetry remains gated to its closed allowlist. | `spec.md:929-931`, `plan.md:250-253`, `docs/adr/README.md:38-39` |
| Should fix: call-count spend cap | Replaced calls with per-principal estimated-token ceilings using duration × documented 300 tokens/second per video-bearing call plus versioned headroom; unknown inputs fail closed. | `spec.md:366-380`, `spec.md:541-552`, `plan.md:243-249` |
| Should fix: ephemeral playback/screenshots | Stated that closing the source tab leaves no ephemeral playback/screenshot source; retained R2 or digest-verified reattachment is required and provenance is recorded. | `spec.md:296-299`, `spec.md:557-568`, `plan.md:237-242` |
| Should fix: hosted transcript provenance | Defined provider → operator context → Gemini-audio-from-uploaded-file → none, with no ffmpeg and no provenance unless the rung succeeds. | `spec.md:499-505`, `plan.md:161-166` |
| Should fix: local SQL/port lockstep | Bound local SQLite to reserved `local:single-user`, kept shared RunStore SQL in parity, preserved v2/v3 bytes, and kept local JobRepository/MediaStagingAdapter ports principal-free behind hosted wrappers. | `spec.md:191-205`, `spec.md:569-574`, `spec.md:789-791`, `plan.md:46-79` |
| Should fix: hosted threat model gaps | Added explicit controls for isolate-memory DoS, Workflow defaults, secret-bearing D1 exports, Access-sub recycle, and import-overwrite IDOR in both the threat model and ADR 0018. | `docs/THREAT_MODEL.md:38-51`, `docs/adr/0018-hosted-studio-trust-boundary.md:58-66` |
| Should fix: boundary markers collide with hosted activity/executor | Required hosted `/hosted/activity` and hosted executor markers; retained local activity source and `OrchestratedAnalysisJobExecutor` as forbidden while removing generic `/activity` from the deny list. | `spec.md:402-409`, `plan.md:271-278` |
| Should fix: part encoding unspecified | Required raw body plus Content-Length/offset/part/digest headers and explicitly prohibited multipart. | `spec.md:217-221`, `spec.md:464-467`, `plan.md:121-124` |

### Residual Decision Closure

| Former residual | Resolution |
|---|---|
| Zone/account body limit | Phase 6 records the dashboard value because Wrangler cannot read it; 8 MiB stays below the lowest documented tier (`spec.md:43-48`, `plan.md:283-288`). |
| Hosted part size | Decided at 8 MiB; only Task 2.0 failure may reopen it through an ADR amendment (`spec.md:217-231`). |
| Workflow export topology | Assigned solely to Task 3.0; fallback is a sibling Worker with service binding (`plan.md:151-156`). |
| Generate idempotency without a receipt | Platform retry is zero; the attempt becomes indeterminate and only user-linked retry may issue another call (`spec.md:314-321`). |
| Hosted derived transcript | Uses the existing Gemini-audio origin directly from the uploaded file, otherwise none (`spec.md:499-505`). |
| Local synthetic principal | Decided as reserved `local:single-user` (`spec.md:191-205`). |
| Shared versus hosted run routes | Shared `/api/runs` routes remain and receive a principal-bound store; payloads stay byte-stable (`spec.md:201-205`). |
| ADR 0017 | Accepted on the Attempt 2 base `8ce93fa`; no telemetry appendix substitute is needed. |
| Gemini-key rotation | Disable uploads, abort/delete exact active sessions, clear their ciphertext, rotate, then reenable; unconfirmed cleanup stays visible (`spec.md:240-245`). |

---

## Re-review checkpoint: r2

The following adversarial re-review is appended verbatim from the fleet artifact
`~/.herdr-fleet/frame-of-mind/assets/hosted-plan-review-r2.md`. It evaluates the
revised plan at its pinned head and authorizes Slice 1 only.

# Adversarial Plan Re-Review r2: Hosted Studio

**Track:** `hosted-studio_20260822`
**Reviewed:** 2026-08-22
**Head SHA:** `a4a93f48e80f23116d3a8591bc477fd95930500a`
**Base:** `8ce93fa391a01528cdb81ebbd7021ee031738433`
**Worktree:** `~/repos/fom-hosted-review` (detached, read-only)
**r1 SHA:** `c3dc88bbd46fc30f4ef8041fc5daff4a5c2303e8` (historical checkpoint in `conductor/tracks/hosted-studio_20260822/review.md`)

> Gate: same bar as r1. Attack is on the revised plan's executable assumptions.
> Cloudflare Workflows `StepConfig` defaults and Workers body/memory limits were
> re-fetched on 2026-08-22, not taken from r1 or training data.

## Executive Summary

The revision encoded the hub resolutions. All four r1 blockers and all ten
should-fixes are **RESOLVED** in the spec/plan text. Live Cloudflare docs still
match the cited defaults (`timeout: "10 minutes"`, `retries.limit: 5`, Free/Pro
body **100 MB**, isolate memory **128 MB**). Task 1.3 now lists every production
viewer/import SQL path in `apps/web/server/api/runs/*.ts`, `server/data/*.ts`,
and `sql.ts`; none of those runtime statements is still missing.

**Slice 1 (Tasks 1.1–1.3) is SAFE_TO_IMPLEMENT and deployable to
`fom.flickerventures.com` now**, independent of Phases 2–8, once its own
stop/go passes: two principals cannot see or mutate each other's runs, proven
by HTTP contract against a built Worker, with hosted creation dark. That slice
is security hardening of the already-deployed viewer, not a Studio.

Phases 2–8 remain gated on Task 2.0 / 3.0. One new Phase 3 should-fix: uncaught
`NonRetryableError` fails the Workflow instance and skips later steps, which
collides with the cleanup-always-runs requirement. It does not affect Slice 1.

## Grounded Findings — r1 Rows Re-Verified

| Sev | r1 finding | Rating | Revised evidence |
|---|---|---|---|
| Blocker | Unproven Worker/Nitro streaming of large parts | **RESOLVED** | Task 2.0 is a hard stop/go: synthetic body ≥ 8 MiB, pipe `request.body`, prove H3/Nitro never `readBody()`, measure two concurrent uploads, contract-change-on-failure before Tasks 2.1+. `spec.md:43-51`, `spec.md:217-231`, `spec.md:477-479`, `plan.md:101-109`, `plan.md:142-146` |
| Blocker | Wrong Workflows timeout/retry assumption vs current docs | **RESOLVED** | Spec cites the sleeping-and-retrying guide URL and the live defaults `timeout: "10 minutes"` / `retries.limit: 5` with exponential backoff. Every `step.do` gets explicit 15-minute config, strictly greater than `MODEL_REQUEST_TIMEOUT_MS` (still `10 * 60_000` at `src/adapters/gemini.ts:57`). Provider steps use `retries.limit: 0`, pre-call receipt, `NonRetryableError` after success-without-receipt, crash-after-Gemini must not generate twice, user retry = new instance. `spec.md:52-60`, `spec.md:309-321`, `spec.md:520-525`, `plan.md:167-182`. See New Finding N1 for cleanup interaction — not a regression of this blocker. |
| Blocker | Incomplete principal scoping / unenumerated viewer IDOR | **RESOLVED** | Item tables and registry gain `principal_sub`, composite PKs/FKs, `ON CONFLICT(principal_sub, run_id)`, explicit `run_principal_conflict` before mutation, empty-DB fail-closed backfill, two-principal built-Worker test. Task 1.3 enumerates every r1 checklist path by file:line (see path table below). `spec.md:184-206`, `spec.md:456-462`, `spec.md:619-791`, `plan.md:38-94` |
| Blocker | 95 MB hosted part vs local 64 MiB cap and 128 MB isolate | **RESOLVED** | Hosted raw parts fixed at 8 MiB (or shorter final); `MAX_MEDIA_PART_BYTES` remains 64 MiB (`src/domain/studio-schemas.ts:12`); `DEFAULT_MEDIA_PART_SIZE_BYTES` is already 8 MiB. ADR 0018 records browser → Worker → Gemini as superseding local Phase B R2. `spec.md:217-256`, `spec.md:464-479`, `plan.md:121-137`, `docs/adr/0018-hosted-studio-trust-boundary.md:35-38` |
| Should fix | Gemini offset is resume authority, not D1 receipts | **RESOLVED** | `spec.md:222-227`, `spec.md:466-471`, `plan.md:121-127` |
| Should fix | Nitro `WorkflowEntrypoint` export unproven | **RESOLVED** | Task 3.0 is the sole topology resolver; fallback is sibling Workflows Worker + service binding on the same Access hostname. `spec.md:327-331`, `plan.md:151-156`, `plan.md:191-195` |
| Should fix | ADR 0017 missing at r1 SHA | **RESOLVED** | Attempt 2 rebased onto `8ce93fa`; ADR 0017 exists and is Accepted. `docs/adr/README.md:38-39`, `docs/adr/0017-opt-in-sentry-telemetry.md`, `spec.md:385-391`, `spec.md:929-931`, `plan.md:250-253` |
| Should fix | Call-count spend cap is not a dollar bound | **RESOLVED** | Per-principal estimated-token ceiling: duration × documented 300 tokens/s × video-bearing calls + versioned headroom; unknown inputs fail closed. `spec.md:364-375`, `spec.md:541-548`, `plan.md:243-249` |
| Should fix | Ephemeral hosted review has no playback/screenshots after tab close | **RESOLVED** | Stated plainly; retained R2 or digest-verified reattachment required; provenance recorded. `spec.md:296-298`, `spec.md:564-567`, `plan.md:237-242` |
| Should fix | Hosted transcript ladder unnamed | **RESOLVED** | Provider → operator context → Gemini-audio from the uploaded file → none; no ffmpeg; no fabricated provenance. `spec.md:499-504`, `plan.md:161-166` |
| Should fix | Local SQLite / RunStore lockstep | **RESOLVED** | Reserved `local:single-user`; shared RunStore SQL; local `JobRepository` / `MediaStagingAdapter` stay principal-free behind hosted wrappers; v2/v3 import bytes unchanged. `spec.md:193-205`, `spec.md:573-576`, `spec.md:789-791`, `plan.md:46-79` |
| Should fix | Threat model / ADR 0018 missing hosted rows | **RESOLVED** | Isolate-memory DoS, Workflow default retries, D1 export of encrypted session URLs, Access `sub` recycle, import-overwrite IDOR. `docs/THREAT_MODEL.md:38-51`, `docs/adr/0018-hosted-studio-trust-boundary.md:58-66` |
| Should fix | Bundle gate collides with hosted activity/executor | **RESOLVED** | AD-11 names required hosted markers including `/hosted/activity` and `HostedWorkflowAnalysisJobExecutor`; forbids local activity source and `OrchestratedAnalysisJobExecutor`; generic `/activity` leaves the deny list in Task 6.1. `spec.md:400-413`, `plan.md:271-278` |
| Should fix | Part POST encoding unspecified | **RESOLVED** | Raw body plus Content-Length / offset / part / digest headers; multipart forbidden. `spec.md:217-221`, `spec.md:466-469`, `plan.md:121-124` |

## Slice 1 Question

**Yes. Slice 1 (Tasks 1.1–1.3) is safe to implement and deploy to
`fom.flickerventures.com` now, independent of Phases 2–8**, after — not
instead of — Phase 1's stop/go.

What ships:

- Task 1.1: Access middleware returns validated `sub` (display email only);
  empty-sub service tokens become `service:<common_name>` and are denied on
  browser viewer/import routes (`plan.md:38-45`, `spec.md:154-166`).
- Task 1.2: D1/SQLite principal columns on both run tables, both item tables,
  and the registry; composite keys; empty-DB rehearsal fails closed on a
  non-empty legacy count; sentinel removed by rebuild; hosted creation stays
  dark (`plan.md:46-53`, `spec.md:774-781`).
- Task 1.3: every existing viewer/import path scoped; two-principal HTTP
  contract against a built Worker (`plan.md:54-81`, `plan.md:90-95`).

Why this is independent of the rest:

- No upload, Workflow, composer, spend, or hosted table writes are required
  for the already-deployed review/import surface to become principal-scoped.
- Task 2.0 / 3.0 spikes do not gate identity or viewer SQL.
- Production D1 is still expected empty; a non-empty sentinel count fails
  closed rather than auto-assigning (`spec.md:776-778`). The operator empty-D1
  fact is not in the repository; the fail-closed check is.

Deploy constraints (Slice 1 only):

1. Apply the **principal-scope** migration (run/item/registry rebuild) with the
   Worker that contains the scoped SQL. Do not wait for, or require, the
   `hosted_*` tables that appear later in the same spec sketch.
2. Stop unless the built-Worker two-principal contract passes
   (`plan.md:90-95`).
3. Keep hosted creation routes absent. Slice 1 is not a Studio.
4. Service tokens that today reach `GET/POST /api/runs` with an empty `sub`
   will be denied. That is specified, not an accident (`spec.md:801-803`).

## Viewer / Import Query Paths

Plan Task 1.3 (`plan.md:54-77`) now enumerates:

| Path | Plan citation | Head SHA actual | Scoped change named |
|---|---|---|---|
| `GET /api/runs` | `apps/web/server/api/runs/index.get.ts:12-16` | store at 12, `listRuns` 13-16 | bind principal |
| D1 list/pagination | `apps/web/server/data/d1.ts:45-69` | `listRuns` 45-69 | principal in both union arms + cursor |
| Union SQL | `apps/web/server/data/sql.ts:210-232` | `supportedRunSummariesSql` 210-232 | principal in both arms |
| `GET /api/runs/:id` | `apps/web/server/api/runs/[id].get.ts:9-11` | store 9, `getRun` 10 | `(principal_sub, run_id)` |
| D1 detail | `d1.ts:72-100` | `getRun` 72-101 | both schema versions |
| `POST /api/runs` | `index.post.ts:46-49` | store 46, `importRun(..., email)` 49 | bind authenticated principal (replace email-as-actor ACL) |
| D1 import | `d1.ts:103-155` | `importRun` 103-155 | composite conflict, scoped child delete/insert, `run_principal_conflict` |
| Shared upsert/items SQL | `sql.ts:105-202` | upsert 105-157, insert items 159-189, delete items 191-202 | `ON CONFLICT(principal_sub, run_id)`; child predicates |
| Registry lookup | `d1.ts:145-149` | SELECT 145-147 | principal in predicate |
| Existence probes | `d1.ts:106-111` | 106-111 | principal in predicate |
| SQLite twins | `sqlite.ts:82-185` | `listRuns` 82-105, `getRun` 107-136, `importRun` 138-186 including registry INSERT 154-155 and registry SELECT 156-158 | identical SQL under `local:single-user` |
| Shared schema | `sql.ts:7-103` | `schemaSql` 7-103 | composite keys; bootstrap registry copy includes principal |
| `GET /api/session` | `session.get.ts:1-2` | 1-3 | display-only; never a principal override |
| `GET /api/health` | `health.get.ts:1-5` | 1-5 | data-free |

**Still missing from Task 1.3's file:line list?** No production SQL statement
on `analysis_runs` / `video_analysis_runs` / `analysis_items` /
`video_analysis_items` / `analysis_run_registry` in
`apps/web/server/api/runs/*.ts` or `apps/web/server/data/{d1,sqlite,sql}.ts`
is omitted. Registry INSERT at `d1.ts:119-121` sits inside the listed import
range. SQLite existence/registry statements sit inside `sqlite.ts:82-185`.

Not query statements, but implementers must still touch them (wiring, not a
leftover IDOR path):

- `createD1RunStore` / `getRunStore` at `d1.ts:32-43` and
  `createLocalRunStoreFromDatabase` at `sqlite.ts:75-80` currently take no
  principal. Spec AD-3 binds the store at construction (`spec.md:193-203`)
  because `RunStore` methods in `types.ts:14-18` have no principal argument.
- `encodeRunCursor` / `decodeRunCursor` at `types.ts:29-40` are a 3-tuple of
  `(completed_at, imported_at, run_id)`. Spec requires principal-bound cursor
  state (`spec.md:788-789`); SQL `principal_sub = ?` already prevents
  cross-principal leakage if the store is closed over the caller.

Test-only unscoped SQL in `apps/web/test/sqlite.test.ts` and `d1.test.ts`
(including `SELECT ... FROM analysis_items WHERE run_id = ?`) is outside the
r1 production checklist. It must be updated in the same slice or it will keep
passing against unscoped helpers.

## Plan Viability By Slice

### Slice 1 — Tasks 1.1–1.3 (identity, migration, scoped viewer/import)

**Viable to implement and deploy now** after the built-Worker two-principal
gate. Hosted creation remains dark. This is the first shippable cut.

### Slice 2 — Phase 2 upload

Still gated on Task 2.0. Part size and encoding are corrected; streaming is
not yet measured. Not authorized by this verdict.

### Slice 3 — Phase 3 Workflows

StepConfig defaults are now cited correctly and Task 3.0 exists. Still gated
on that spike plus New Finding N1 (cleanup vs `NonRetryableError`). Not
authorized by this verdict.

### Slice 4 — Phases 4–6 team-mode Studio

Depends on Slices 1–3. First usable hosted composer → activity → review loop.

### Slice 5 — Phases 7–8 Tier B

Still correctly blocked on the Phase 6 gate.

## Research Findings (re-fetched 2026-08-22)

- [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
  (updated 2026-07-09): default `WorkflowStepConfig` is still
  `{ retries: { limit: 5, delay: 10000, backoff: "exponential" }, timeout: "10 minutes" }`.
  `"30 minutes"` remains a custom-config example. `NonRetryableError` "will
  fail immediately, no further steps will be invoked, and the Workflow will
  not be retried." Rollback handlers and `try...catch` around a step are the
  documented ways to still run cleanup. Spec citations at `spec.md:52-60`
  match the defaults.
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
  (updated 2026-06-15): wall clock per step unlimited; CPU per step default
  30 seconds / max 5 minutes; non-stream step result 1 MiB; max retries per
  step 10,000. Spec `spec.md:53-55` and `spec.md:963-965` remain correct.
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/):
  request body is an **account plan** limit — Free/Pro **100 MB**, Business
  200 MB, Enterprise 500 MB default. Isolate memory **128 MB per isolate, not
  per request**. Paid CPU default 30 seconds, configurable to 5 minutes. HTTP
  duration unlimited while the client stays connected. Spec `spec.md:43-48`
  matches; 8 MiB is below the lowest documented body tier. Zone/account
  ceiling still requires a dashboard check because Wrangler cannot read it
  (`spec.md:968-970`, `plan.md:283-288`).

## New Findings

| Sev | Finding | Evidence | Slice impact |
|---|---|---|---|
| Should fix | **N1.** Uncaught `NonRetryableError` aborts the Workflow instance and skips later steps, including `cleanup`. The revision added the r1-required non-retryable pattern (`spec.md:316-318`, `spec.md:523-524`, `plan.md:170-171`) without reconciling FR-07's "cleanup runs after success, failure, or cancellation" (`spec.md:528-529`). Current Cloudflare docs say no further steps run unless the throw is caught or a rollback handler is registered. A crashed-after-Gemini-success path can therefore skip Gemini-file deletion until the 48-hour Files API expiry. | [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) fetched 2026-08-22 | Phase 3 only. Wrap provider steps so cleanup still runs, or register rollback. Does not block Slice 1. |
| Nit | **N2.** API surface table lists `GET /api/runs` and `GET /api/runs/:id` but omits `POST /api/runs` (`spec.md:604-606`), while AD-3 and Task 1.3 keep import as a shared principal-bound route (`spec.md:201-203`, `plan.md:63-68`). | Spec table vs AD-3 | Docs only. |

No new blocker. The revision does not reintroduce 95 MB parts, unscoped
viewer SQL, silent Workflow retries, or an unproven-as-gated streaming
contract.

## Residuals

Former r1 residuals remain decided or assigned to Task 2.0 / 3.0
(`spec.md:968-978`, `review.md:279-292`). Additional notes for implementers,
none blocking Slice 1:

- Slice 1's D1 migration is the principal-scope rebuild of the five projection
  tables plus registry (`plan.md:46-53`). The `hosted_media_sessions` /
  `hosted_analysis_jobs` / spend / connections tables in the same spec sketch
  (`spec.md:666-741`) wait for later phases even if they share the sketch
  filename.
- Bind principal in the store constructors (`d1.ts:32-43`, `sqlite.ts:75-80`),
  not only in the listed SQL ranges. Local CLI (`apps/web/scripts/import-run.ts`)
  and `server-local/studio-jobs/runtime.ts` keep working if SQLite closes over
  `local:single-user`.
- At Task 3.3, confirm against `@cloudflare/workers-types` that
  `retries.limit: 0` means zero retries (one attempt), matching the field name
  rather than the example comment "total number of attempts".
- Update test-only unscoped item SELECTs in `apps/web/test/{sqlite,d1}.test.ts`
  in the same slice as the schema change.

## Author-Side Reader Checks

| Reader question | Canonical answer |
|---|---|
| Can Slice 1 land on `fom.flickerventures.com` without upload/Workflows code? | Yes, after the two-principal built-Worker gate. Creation stays dark. |
| Are any r1 viewer/import SQL paths still unlisted? | No. See path table. Constructors/cursors are wiring, not missing queries. |
| Do cited Workflows/Workers numbers still match live docs? | Yes. Defaults `timeout: "10 minutes"`, `retries.limit: 5`; body Free/Pro 100 MB; isolate 128 MB; 8 MiB under the lowest tier. |
| Is the whole hosted Studio safe to implement? | No. Only Slice 1. Phases 2–8 stay behind Task 2.0 / 3.0 and N1. |
| What identifies a user after Slice 1? | Validated Access JWT `sub`. Email is display/`imported_by` only. |
| Does local Studio keep working? | Yes if shared SQL uses `local:single-user` and job/media ports stay principal-free. |

## Review Verdict

**SAFE_TO_IMPLEMENT (Slice 1 only)**

Authorize implementation and production deploy of Tasks 1.1–1.3 (Access
principal middleware, empty-DB fail-closed principal migration, fully scoped
viewer + import) on `fom.flickerventures.com` after Phase 1's stop/go.
Do not authorize Phase 2+ until Task 2.0 and Task 3.0 pass, and fold N1 into
Phase 3 before Workflows run against Gemini.

DONE fom-hosted-plan-review-r2
