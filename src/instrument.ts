import { applicationSetting } from "./lib/application-settings.js";
import * as Sentry from "@sentry/bun";
import { IS_RELEASE_BUNDLE } from "./version.js";
import { scrubSentryEvent } from "./lib/sentry-telemetry.js";
import {
  scrubSentryTransactionEvent,
  type ScrubbableTransactionEvent,
} from "./lib/telemetry-trace.js";


let initialized: {enabled: boolean; tracing: boolean} | undefined;

// Resolve folder settings only when a command actually needs telemetry.
export function cliInstrumentation() {
  if (initialized) return initialized;
  const dsn = applicationSetting("SENTRY_DSN")?.trim() ?? "";
  const tracing = !!dsn && applicationSetting("FRAME_OF_MIND_TRACING") === "1";
  initialized = {enabled: !!dsn, tracing};
  if (!dsn) return initialized;
  const raw = tracing ? Number(applicationSetting("FRAME_OF_MIND_TRACES_SAMPLE_RATE") ?? "1") : 0;
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
    tracesSampleRate: Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 1,
    defaultIntegrations: false,
    ...(IS_RELEASE_BUNDLE && { registerEsmLoaderHooks: false }),
    beforeSendTransaction: tracing
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
  return initialized;
}
