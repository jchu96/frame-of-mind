import * as Sentry from "@sentry/nuxt";
import {
  normalizeTelemetryTags,
  SanitizedTelemetryError,
  type TelemetryTags,
} from "../../../src/lib/sentry-telemetry";

const telemetryEnabled = Boolean(process.env.SENTRY_DSN?.trim());

export async function captureStudioException(
  code: string,
  tags: TelemetryTags,
): Promise<string | undefined> {
  if (!telemetryEnabled) return undefined;
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
