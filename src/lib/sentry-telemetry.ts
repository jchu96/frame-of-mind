const TELEMETRY_CODE_PATTERN = /^[a-z][a-z0-9_:-]{0,119}$/;

export const TELEMETRY_TAG_KEYS = [
  "code",
  "stage",
  "jobId",
  "recipeId",
  "recipeRevision",
  "model",
  "durationMs",
  "studioMode",
  "version",
] as const;

export type TelemetryTagKey = (typeof TELEMETRY_TAG_KEYS)[number];
export type TelemetryTags = Partial<Record<TelemetryTagKey, string | number | boolean>>;

type TelemetryExceptionValue = {
  type?: string;
  value?: string;
  stacktrace?: unknown;
  mechanism?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ScrubbableSentryEvent = {
  message?: string;
  exception?: {
    values?: TelemetryExceptionValue[];
    [key: string]: unknown;
  };
  stacktrace?: unknown;
  extra?: Record<string, unknown>;
  breadcrumbs?: unknown[];
  request?: {
    data?: unknown;
    cookies?: unknown;
    headers?: unknown;
    [key: string]: unknown;
  };
  user?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  transaction?: string;
  modules?: Record<string, string>;
  server_name?: string;
  debug_meta?: unknown;
  [key: string]: unknown;
};

const SENSITIVE_TEXT_PATTERNS = [
  /(?:^|[\s"'(])\/(?:Users|home|private|tmp|var|opt|etc)\/[^\s"')]+/i,
  /\b[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s]*/,
  /https?:\/\/[^\s]+\?[^\s]*/i,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\b(?:GEMINI|GRANOLA|SENTRY|API)[_-]?(?:API[_-]?)?(?:KEY|TOKEN)\s*[:=]\s*\S+/i,
  /\b(?:sk|key|token|secret)[_-][0-9A-Za-z_-]{16,}\b/i,
  /\b[a-f0-9]{64}\b/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\bnot_[0-9A-Za-z_-]{8,}\b/,
  /\b(?:meeting|recording)[_-]id\s*[:=]\s*[0-9A-Za-z_-]+\b/i,
];

const ALLOWED_TAG_KEYS = new Set<string>(TELEMETRY_TAG_KEYS);

export class SanitizedTelemetryError extends Error {
  override readonly name = "SanitizedTelemetryError";

  constructor(readonly code: string) {
    super(code);
  }
}

export function isSafeTelemetryCode(value: string): boolean {
  return TELEMETRY_CODE_PATTERN.test(value)
    && !SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

export function telemetryCodeFromError(
  error: unknown,
  fallback: string,
): string {
  if (error && typeof error === "object") {
    const telemetryCode = (error as { telemetryCode?: unknown }).telemetryCode;
    if (typeof telemetryCode === "string" && isSafeTelemetryCode(telemetryCode)) {
      return telemetryCode;
    }
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      return `gemini_http_${status}`;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && isSafeTelemetryCode(code)) return code;
  }
  return isSafeTelemetryCode(fallback) ? fallback : "unexpected_failure";
}

export function normalizeTelemetryTags(tags: TelemetryTags): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags)
      .filter(([key, value]) =>
        ALLOWED_TAG_KEYS.has(key) && isSafeMetadataValue(value)
      )
      .map(([key, value]) => [key, String(value).slice(0, 240)]),
  );
}

export function scrubSentryEvent<T extends ScrubbableSentryEvent>(event: T): T | null {
  const messages = [
    event.message,
    ...(event.exception?.values?.map((value) => value.value) ?? []),
  ].filter((value): value is string => typeof value === "string");

  if (
    messages.length === 0
    || messages.some((value) =>
      !isSafeTelemetryCode(value)
      || SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value))
    )
  ) {
    return null;
  }

  delete event.extra;
  delete event.breadcrumbs;
  delete event.user;
  delete event.stacktrace;
  delete event.transaction;
  delete event.modules;
  delete event.server_name;
  delete event.debug_meta;
  delete event.request;

  event.tags = filterMetadata(event.tags);
  event.contexts = filterMetadata(event.contexts);
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((value) => ({
      type: "SanitizedTelemetryError",
      value: value.value,
      ...(value.mechanism
        ? {
            mechanism: {
              handled: value.mechanism.handled,
              type: value.mechanism.type,
            },
          }
        : {}),
    }));
  }
  return event;
}

function filterMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(metadata).filter(([key, value]) =>
      ALLOWED_TAG_KEYS.has(key) && isSafeContextValue(value)
    ),
  );
  return Object.keys(filtered).length ? filtered : undefined;
}

function isSafeContextValue(value: unknown): boolean {
  if (isSafeMetadataValue(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1
    && entries[0]?.[0] === "value"
    && isSafeMetadataValue(entries[0][1]);
}

function isSafeMetadataValue(value: unknown): value is string | number | boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value)
    && !SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}
