import { config as loadDotenv } from "dotenv";
import * as Sentry from "@sentry/bun";
import { scrubSentryEvent } from "./lib/sentry-telemetry.js";

loadDotenv({ quiet: true });

const dsn = process.env.SENTRY_DSN?.trim() ?? "";

export const CLI_TELEMETRY_ENABLED = dsn.length > 0;

Sentry.init({
  dsn: dsn || undefined,
  enabled: CLI_TELEMETRY_ENABLED,
  environment: "cli",
  sendDefaultPii: false,
  tracesSampleRate: 0,
  defaultIntegrations: false,
  beforeBreadcrumb: () => null,
  beforeSend(event) {
    return scrubSentryEvent(event as typeof event & import("./lib/sentry-telemetry.js").ScrubbableSentryEvent);
  },
});
