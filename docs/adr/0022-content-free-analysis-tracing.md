# ADR 0022: Content-free analysis tracing extends opt-in telemetry

- Status: Accepted
- Date: 2026-08-24
- Amends: [ADR 0017](0017-opt-in-sentry-telemetry.md)

## Invariant

Unchanged from ADR 0017: operational visibility must not turn private
analysis inputs or outputs into a second outbound data path.

## Context

ADR 0017 made error telemetry opt-in and codes-only, with spans "absent by
construction". That leaves real operational questions unanswerable: where a
run's minutes go (transcription vs upload vs interrogation), what each pass
costs in tokens, how often runs truncate to the moment limit, and how
candidate failure codes trend. Sentry's AI-agent tracing conventions
(`gen_ai.*` span ops and attributes) answer exactly these questions, and the
conventions explicitly permit omitting all prompt/response content.

## Decision

The CLI gains a second, separately opted-in telemetry signal: content-free
analysis tracing. It is off unless the operator sets both `SENTRY_DSN` and
`FRAME_OF_MIND_TRACING=1`; a DSN alone keeps the ADR 0017 codes-only posture
unchanged. `FRAME_OF_MIND_TRACES_SAMPLE_RATE` (0–1, default 1) bounds volume.

Spans describe the shape of a run, never its content:

- A root `gen_ai.invoke_agent` transaction named from a closed vocabulary
  ("analyze run") wraps each CLI analysis.
- `gen_ai.chat` spans wrap each provider call (transcribe window, index,
  per-candidate interrogation) carrying provider/model identifiers and token
  deltas (`gen_ai.usage.input_tokens` / `output_tokens` / `total_tokens`).
- `analysis.stage` spans wrap upload and publish; publish carries the
  sanitized outcome status and candidate-count arithmetic, making truncation
  and failure-code rates queryable and alertable.

The content attributes defined by the convention
(`gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.system_instructions`, tool definitions) are never set, and the
scrubber removes them by construction if any future code sets one.

Enforcement follows ADR 0017's allowlist-construction discipline, applied
twice:

1. Span names come from a closed vocabulary of identifiers and attribute
   values must be identifier-shaped or numeric (`isSafeTraceAttributeValue`),
   filtered at set time by the tracer implementation.
2. `beforeSendTransaction` never edits and forwards the SDK event. It
   constructs a new transaction from a closed allowlist; a root transaction
   outside the vocabulary drops the whole event, a child span outside it is
   dropped individually, and every span attribute is re-filtered.

Architecture: services and adapters depend only on a pure, provider-free
tracing port (`AnalysisTracer` in `src/lib/telemetry-trace.ts`, default
inert). The Sentry-backed implementation lives in `src/lib/sentry-tracer.ts`
and is constructed only by the CLI entry path. The Gemini adapter exposes a
non-destructive `usageSnapshot()` for per-span token deltas; the hosted spend
path's draining `takeUsage()` is untouched. Hosted and Studio surfaces are
out of scope: the Nuxt/Cloudflare builds keep ADR 0017's tracing exclusions,
the Workflows Worker keeps its codes-only envelope port, and the orchestrator
tracer defaults to the inert implementation everywhere the CLI did not
inject one.

## Consequences

- Operators who opt in can see stage durations, per-pass token spend, model
  identity, truncation rates, and candidate failure trends in Sentry's AI
  agents views, and alert on them.
- The outbound surface grows only by identifier-shaped names, enum statuses,
  and counts; a regression that attaches content to a span is stripped by two
  independent layers and covered by tests.
- Studio and hosted tracing, if ever wanted, require a further ADR because
  they cross the boundaries ADR 0017 fixed for those surfaces.
