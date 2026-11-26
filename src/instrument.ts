import { applicationSetting } from "./lib/application-settings.js";
import * as Sentry from "@sentry/bun";
import { IS_RELEASE_BUNDLE } from "./version.js";
import { scrubSentryEvent } from "./lib/sentry-telemetry.js";
import {
  scrubSentryTransactionEvent,
  type ScrubbableTransactionEvent,
} from "./lib/telemetry-trace.js";


const dsn = applicationSetting("SENTRY_DSN")?.trim() ?? "";

export const CLI_TELEMETRY_ENABLED = dsn.length > 0;

// Tracing is a second, separately opted-in signal (ADR 0022): a DSN alone
// keeps the ADR 0017 codes-only posture; spans flow only when the operator
// also sets FRAME_OF_MIND_TRACING=1.
export const CLI_TRACING_ENABLED = CLI_TELEMETRY_ENABLED
  && applicationSetting("FRAME_OF_MIND_TRACING") === "1";

function tracesSampleRate(): number {
  if (!CLI_TRACING_ENABLED) return 0;
  const raw = Number(applicationSetting("FRAME_OF_MIND_TRACES_SAMPLE_RATE") ?? "1");
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
    ...(IS_RELEASE_BUNDLE && { registerEsmLoaderHooks: false }),
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
