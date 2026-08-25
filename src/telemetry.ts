import * as Sentry from "@sentry/bun";
import { CLI_TELEMETRY_ENABLED, CLI_TRACING_ENABLED } from "./instrument.js";
import { createSentryAnalysisTracer } from "./lib/sentry-tracer.js";
import type { AnalysisTracer } from "./lib/telemetry-trace.js";
import {
  normalizeTelemetryTags,
  SanitizedTelemetryError,
  type TelemetryTags,
} from "./lib/sentry-telemetry.js";

export function isCliTelemetryEnabled(): boolean {
  return CLI_TELEMETRY_ENABLED;
}

export function isCliTracingEnabled(): boolean {
  return CLI_TRACING_ENABLED;
}

/** The CLI's tracer, or undefined when tracing is not opted in. */
export function cliAnalysisTracer(): AnalysisTracer | undefined {
  return CLI_TRACING_ENABLED ? createSentryAnalysisTracer() : undefined;
}

export async function captureCliException(
  code: string,
  tags: TelemetryTags,
): Promise<string | undefined> {
  if (!CLI_TELEMETRY_ENABLED) return undefined;
  const eventId = Sentry.captureException(
    new SanitizedTelemetryError(code),
    { tags: normalizeTelemetryTags({ ...tags, code }) },
  );
  if (process.env.SENTRY_DEBUG === "1") {
    process.stderr.write(`Sentry event id: ${eventId}\n`);
  }
  await Sentry.flush(2_000).catch(() => false);
  return eventId;
}
