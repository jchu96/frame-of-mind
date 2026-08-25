import {
  containsSensitiveTelemetryText,
  isSafeTelemetryCode,
} from "./telemetry-code.js";

// Identifier-shaped values only: model IDs may carry dots
// ("gemini-3.7-flash"), everything else mirrors the telemetry-code pattern.
const TRACE_VALUE_PATTERN = /^[a-z][a-z0-9._:-]{0,119}$/i;

// Content-free analysis tracing (ADR 0022, extending ADR 0017's invariant):
// spans describe the SHAPE of a run — stages, models, token counts, outcome
// arithmetic — never its content. Everything here is pure and provider-free
// so shared consumers (services, adapters, the hosted Workflows Worker's
// envelope port) can import it without pulling a Sentry SDK; the SDK-backed
// tracer lives in sentry-tracer.ts and is wired only by the CLI entry.

export const ANALYSIS_SPAN_OPS = [
  "gen_ai.invoke_agent",
  "gen_ai.chat",
  "analysis.stage",
] as const;
export type AnalysisSpanOp = (typeof ANALYSIS_SPAN_OPS)[number];

// Closed name vocabulary: a span name is an identifier, never a sentence, so
// no free text can ride in the description field.
export const ANALYSIS_SPAN_NAMES = [
  "analyze run",
  "gemini transcribe",
  "gemini index",
  "gemini interrogate",
  "stage transcribe",
  "stage upload",
  "stage index",
  "stage interrogate",
  "stage publish",
] as const;
export type AnalysisSpanName = (typeof ANALYSIS_SPAN_NAMES)[number];

// Per-key validators: a value is admitted only when its KEY expects exactly
// that kind of value. Structural fields are closed enums, the model is
// grammar-checked against provider model-ID shapes, counts must be safe
// non-negative integers, and no generic "identifier-shaped" rule exists —
// operator-authored strings (custom recipe metadata, filenames, meeting-like
// IDs, hex digests) have no key that accepts them.
const nonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bool = (value: unknown): value is boolean => typeof value === "boolean";
const oneOf = (...allowed: string[]) => {
  const set = new Set(allowed);
  return (value: unknown): value is string => typeof value === "string" && set.has(value);
};
// Gemini/Gemma model IDs only — the sensitive-content screen still applies.
const GEMINI_MODEL_PATTERN = /^(gemini|gemma)[a-z0-9.-]{0,60}$/;
const modelId = (value: unknown): value is string =>
  typeof value === "string"
  && GEMINI_MODEL_PATTERN.test(value)
  && !containsSensitiveTelemetryText(value);

// Built-in recipe IDs plus the "custom" bucket. Operator-authored custom
// recipe IDs never leave the process; callers map them to "custom".
export const BUILT_IN_RECIPE_TRACE_IDS = [
  "issue-review",
  "decisions",
  "requirements",
  "action-items",
  "repo-plan",
  "communication-coaching",
] as const;

export const TRACE_ATTRIBUTE_VALIDATORS = {
  "gen_ai.operation.name": oneOf("chat", "invoke_agent"),
  "gen_ai.provider.name": oneOf("google_genai"),
  "gen_ai.request.model": modelId,
  "gen_ai.usage.input_tokens": nonNegativeInt,
  "gen_ai.usage.output_tokens": nonNegativeInt,
  "gen_ai.usage.total_tokens": nonNegativeInt,
  "frame_of_mind.stage": oneOf("upload", "publish"),
  "frame_of_mind.recipe_id": oneOf(...BUILT_IN_RECIPE_TRACE_IDS, "custom"),
  "frame_of_mind.depth": oneOf("standard", "deep"),
  "frame_of_mind.context_mode": oneOf("bluedot", "granola", "file", "none"),
  "frame_of_mind.max_moments": nonNegativeInt,
  "frame_of_mind.window": nonNegativeInt,
  "frame_of_mind.windows": nonNegativeInt,
  "frame_of_mind.candidate_ordinal": nonNegativeInt,
  "frame_of_mind.candidate_accepted": bool,
  "frame_of_mind.candidate_failure_code": oneOf(
    "response_missing",
    "invalid_json",
    "schema_validation",
    "evidence_out_of_range",
    "generation_failed",
  ),
  "frame_of_mind.candidates_indexed": nonNegativeInt,
  "frame_of_mind.candidates_selected": nonNegativeInt,
  "frame_of_mind.candidates_omitted_by_limit": nonNegativeInt,
  "frame_of_mind.candidates_validated": nonNegativeInt,
  "frame_of_mind.candidates_accepted": nonNegativeInt,
  "frame_of_mind.candidates_rejected": nonNegativeInt,
  "frame_of_mind.candidates_failed": nonNegativeInt,
  "frame_of_mind.outcome": oneOf("complete", "partial", "failed"),
  "frame_of_mind.byte_count": nonNegativeInt,
  "frame_of_mind.duration_ms": nonNegativeInt,
  "frame_of_mind.derived_transcript": bool,
} as const;

export type TraceAttributeKey = keyof typeof TRACE_ATTRIBUTE_VALIDATORS;
export const TRACE_ATTRIBUTE_KEYS = Object.keys(
  TRACE_ATTRIBUTE_VALIDATORS,
) as TraceAttributeKey[];

export type TraceAttributeValue = string | number | boolean;
export type TraceAttributes = Partial<Record<TraceAttributeKey, TraceAttributeValue>>;

const ALLOWED_SPAN_OPS = new Set<string>(ANALYSIS_SPAN_OPS);
const ALLOWED_SPAN_NAMES = new Set<string>(ANALYSIS_SPAN_NAMES);
// Sentry's SDK stamps internal bookkeeping onto span data. Fixed keys only;
// values must be SDK-identifier shaped and pass the sensitive screen.
const SENTRY_INTERNAL_ATTRIBUTE_KEYS = new Set([
  "sentry.op",
  "sentry.origin",
  "sentry.source",
  "sentry.sample_rate",
]);
const sentryInternalValue = (value: unknown): value is string | number =>
  (typeof value === "number" && Number.isFinite(value))
  || (typeof value === "string"
    && TRACE_VALUE_PATTERN.test(value)
    && !containsSensitiveTelemetryText(value));

export function isSafeTraceAttribute(key: string, value: unknown): boolean {
  const validator = (TRACE_ATTRIBUTE_VALIDATORS as Record<
    string,
    ((candidate: unknown) => boolean) | undefined
  >)[key];
  if (validator) return validator(value);
  if (SENTRY_INTERNAL_ATTRIBUTE_KEYS.has(key)) return sentryInternalValue(value);
  return false;
}

export function scrubTraceAttributes(
  data: Record<string, unknown> | undefined,
): Record<string, TraceAttributeValue> {
  if (!data) return {};
  const scrubbed: Record<string, TraceAttributeValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!isSafeTraceAttribute(key, value)) continue;
    scrubbed[key] = value as TraceAttributeValue;
  }
  return scrubbed;
}

// The injectable tracing port. Services and adapters depend on this shape
// only; the default is inert so hosted and un-opted-in runs pay nothing.
export interface AnalysisSpan {
  setAttributes(attributes: TraceAttributes): void;
}

export interface AnalysisTracer {
  span<T>(
    descriptor: { op: AnalysisSpanOp; name: AnalysisSpanName; attributes?: TraceAttributes },
    callback: (span: AnalysisSpan) => Promise<T>,
  ): Promise<T>;
}

const INERT_SPAN: AnalysisSpan = { setAttributes: () => {} };

export const NOOP_ANALYSIS_TRACER: AnalysisTracer = {
  span: (_descriptor, callback) => callback(INERT_SPAN),
};

// --- Transaction scrubbing -------------------------------------------------
// Mirrors scrubSentryEvent's construction discipline: never edit-and-forward
// the SDK event; build a new one from a closed allowlist and drop anything
// that fails validation.

type ScrubbableSpan = {
  span_id?: unknown;
  parent_span_id?: unknown;
  trace_id?: unknown;
  start_timestamp?: unknown;
  timestamp?: unknown;
  op?: unknown;
  description?: unknown;
  status?: unknown;
  origin?: unknown;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ScrubbableTransactionEvent = {
  type?: unknown;
  event_id?: unknown;
  transaction?: unknown;
  start_timestamp?: unknown;
  timestamp?: unknown;
  platform?: unknown;
  environment?: unknown;
  release?: unknown;
  sdk?: { name?: unknown; version?: unknown; [key: string]: unknown };
  contexts?: { trace?: ScrubbableSpan & { [key: string]: unknown }; [key: string]: unknown };
  spans?: ScrubbableSpan[];
  tags?: Record<string, unknown>;
  [key: string]: unknown;
};

type AllowlistedSpan = {
  span_id: string;
  parent_span_id?: string;
  trace_id: string;
  start_timestamp: number;
  timestamp: number;
  op: string;
  description: string;
  status?: string;
  origin: "manual";
  data: Record<string, TraceAttributeValue>;
};

export type AllowlistedTransactionEvent = {
  type: "transaction";
  event_id?: string;
  transaction: string;
  transaction_info: { source: "custom" };
  start_timestamp?: number;
  timestamp?: number;
  platform?: string;
  environment?: string;
  release?: string;
  sdk?: { name?: string; version?: string };
  contexts: {
    trace: {
      trace_id: string;
      span_id: string;
      op: string;
      origin: "manual";
      status?: string;
      data: Record<string, TraceAttributeValue>;
    };
  };
  spans: AllowlistedSpan[];
  tags?: Record<string, string>;
};

function hex(value: unknown, length: number): string | undefined {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
    ? value
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function spanStatus(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : undefined;
}

function scrubChildSpan(span: ScrubbableSpan): AllowlistedSpan | undefined {
  const spanId = hex(span.span_id, 16);
  const traceId = hex(span.trace_id, 32);
  const start = finite(span.start_timestamp);
  const end = finite(span.timestamp);
  const op = typeof span.op === "string" && ALLOWED_SPAN_OPS.has(span.op) ? span.op : undefined;
  const description = typeof span.description === "string"
      && ALLOWED_SPAN_NAMES.has(span.description)
    ? span.description
    : undefined;
  if (!spanId || !traceId || start === undefined || end === undefined || !op || !description) {
    return undefined;
  }
  const parent = hex(span.parent_span_id, 16);
  const status = spanStatus(span.status);
  return {
    span_id: spanId,
    ...(parent ? { parent_span_id: parent } : {}),
    trace_id: traceId,
    start_timestamp: start,
    timestamp: end,
    op,
    description,
    ...(status ? { status } : {}),
    origin: "manual",
    data: scrubTraceAttributes(span.data),
  };
}

/**
 * Allowlist-construct a transaction event. Returns null (dropping the whole
 * event) when the root transaction is not part of the fixed vocabulary; child
 * spans outside the vocabulary are dropped individually.
 */
export function scrubSentryTransactionEvent(
  event: ScrubbableTransactionEvent,
): AllowlistedTransactionEvent | null {
  if (event.type !== "transaction") return null;
  const transaction = typeof event.transaction === "string"
      && ALLOWED_SPAN_NAMES.has(event.transaction)
    ? event.transaction
    : undefined;
  const trace = event.contexts?.trace;
  const traceId = hex(trace?.trace_id, 32);
  const rootSpanId = hex(trace?.span_id, 16);
  const rootOp = typeof trace?.op === "string" && ALLOWED_SPAN_OPS.has(trace.op)
    ? trace.op
    : undefined;
  if (!transaction || !traceId || !rootSpanId || !rootOp) return null;
  const rootStatus = spanStatus(trace?.status);
  return {
    type: "transaction",
    ...(hex(event.event_id, 32) ? { event_id: hex(event.event_id, 32)! } : {}),
    transaction,
    transaction_info: { source: "custom" },
    ...(finite(event.start_timestamp) !== undefined
      ? { start_timestamp: finite(event.start_timestamp)! }
      : {}),
    ...(finite(event.timestamp) !== undefined ? { timestamp: finite(event.timestamp)! } : {}),
    ...(typeof event.platform === "string" ? { platform: event.platform.slice(0, 40) } : {}),
    ...(typeof event.environment === "string"
      ? { environment: event.environment.slice(0, 40) }
      : {}),
    ...(typeof event.release === "string" && isSafeTelemetryCode(event.release.toLowerCase())
      ? { release: event.release }
      : {}),
    ...(event.sdk && typeof event.sdk.name === "string" && typeof event.sdk.version === "string"
      ? { sdk: { name: event.sdk.name.slice(0, 60), version: event.sdk.version.slice(0, 40) } }
      : {}),
    contexts: {
      trace: {
        trace_id: traceId,
        span_id: rootSpanId,
        op: rootOp,
        origin: "manual",
        ...(rootStatus ? { status: rootStatus } : {}),
        data: scrubTraceAttributes(trace?.data),
      },
    },
    spans: (Array.isArray(event.spans) ? event.spans : [])
      .map(scrubChildSpan)
      .filter((span): span is AllowlistedSpan => span !== undefined),
  };
}
