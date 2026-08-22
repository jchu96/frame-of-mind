import { config as loadDotenv } from "dotenv";
import * as Sentry from "@sentry/bun";
import { scrubSentryEvent } from "./lib/sentry-telemetry.js";

loadDotenv({ quiet: true });

const dsn = process.env.SENTRY_DSN?.trim() ?? "";

export const CLI_TELEMETRY_ENABLED = dsn.length > 0;

if (CLI_TELEMETRY_ENABLED) {
  Sentry.init({
    dsn,
    _metadata: {
      sdk: {
        name: "sentry.javascript.bun",
        version: Sentry.SDK_VERSION,
        integrations: [],
        packages: [],
      },
    },
    environment: "cli",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    beforeSendTransaction: () => null,
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      return scrubSentryEvent(
        event as unknown as import("./lib/sentry-telemetry.js").ScrubbableSentryEvent,
      ) as typeof event | null;
    },
  });
}
