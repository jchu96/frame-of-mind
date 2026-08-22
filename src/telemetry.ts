import * as Sentry from "@sentry/bun";
import { CLI_TELEMETRY_ENABLED } from "./instrument.js";
import {
  normalizeTelemetryTags,
  SanitizedTelemetryError,
  type TelemetryTags,
} from "./lib/sentry-telemetry.js";

export function isCliTelemetryEnabled(): boolean {
  return CLI_TELEMETRY_ENABLED;
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
