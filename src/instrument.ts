import { config as loadDotenv } from "dotenv";
import * as Sentry from "@sentry/bun";
import { scrubSentryEvent } from "./lib/sentry-telemetry.js";
import {
  scrubSentryTransactionEvent,
  type ScrubbableTransactionEvent,
} from "./lib/telemetry-trace.js";

loadDotenv({ quiet: true });

const dsn = process.env.SENTRY_DSN?.trim() ?? "";

export const CLI_TELEMETRY_ENABLED = dsn.length > 0;

// Tracing is a second, separately opted-in signal (ADR 0022): a DSN alone
// keeps the ADR 0017 codes-only posture; spans flow only when the operator
// also sets FRAME_OF_MIND_TRACING=1.
export const CLI_TRACING_ENABLED = CLI_TELEMETRY_ENABLED
  && process.env.FRAME_OF_MIND_TRACING === "1";

function tracesSampleRate(): number {
  if (!CLI_TRACING_ENABLED) return 0;
  const raw = Number(process.env.FRAME_OF_MIND_TRACES_SAMPLE_RATE ?? "1");
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 1;
}

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
    tracesSampleRate: tracesSampleRate(),
    defaultIntegrations: false,
    beforeSendTransaction: CLI_TRACING_ENABLED
      ? (event) =>
        scrubSentryTransactionEvent(
          event as unknown as ScrubbableTransactionEvent,
        ) as unknown as typeof event | null
      : () => null,
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      return scrubSentryEvent(
        event as unknown as import("./lib/sentry-telemetry.js").ScrubbableSentryEvent,
      ) as typeof event | null;
    },
  });
}
