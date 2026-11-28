import { applicationSetting } from "./lib/application-settings.js";
import * as Sentry from "@sentry/bun";
import { cliInstrumentation } from "./instrument.js";
import { createSentryAnalysisTracer } from "./lib/sentry-tracer.js";
import type { AnalysisTracer } from "./lib/telemetry-trace.js";
import {
  normalizeTelemetryTags,
  SanitizedTelemetryError,
  type TelemetryTags,
} from "./lib/sentry-telemetry.js";

export function isCliTelemetryEnabled(): boolean {
  return cliInstrumentation().enabled;
}

export function isCliTracingEnabled(): boolean {
  return cliInstrumentation().tracing;
}

/** The CLI's tracer, or undefined when tracing is not opted in. */
export function cliAnalysisTracer(): AnalysisTracer | undefined {
  return cliInstrumentation().tracing ? createSentryAnalysisTracer() : undefined;
}

/**
 * Drain the transport before the short-lived CLI process exits; without
 * this, successful traces are delivery-racy (errors already flush via
 * captureCliException). Never throws.
 */
export async function flushCliTelemetry(): Promise<void> {
  if (!cliInstrumentation().enabled) return;
  await Sentry.flush(2_000).catch(() => false);
}

export async function captureCliException(
  code: string,
  tags: TelemetryTags,
): Promise<string | undefined> {
  if (!cliInstrumentation().enabled) return undefined;
  const eventId = Sentry.captureException(
    new SanitizedTelemetryError(code),
    { tags: normalizeTelemetryTags({ ...tags, code }) },
  );
  if (applicationSetting("SENTRY_DEBUG") === "1") {
    process.stderr.write(`Sentry event id: ${eventId}\n`);
  }
  await Sentry.flush(2_000).catch(() => false);
  return eventId;
}
