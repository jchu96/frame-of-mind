import * as Sentry from "@sentry/nuxt";
import { scrubSentryEvent } from "../../src/lib/sentry-telemetry";

const dsn = process.env.SENTRY_DSN?.trim() ?? "";
const localStudio = process.env.FRAME_OF_MIND_STUDIO === "1"
  && process.env.NITRO_PRESET !== "cloudflare-worker";

if (dsn) {
  Sentry.init({
    dsn,
    _metadata: {
      sdk: {
        name: "sentry.javascript.nuxt",
        version: Sentry.SDK_VERSION,
        integrations: [],
        packages: [],
      },
    },
    environment: localStudio ? "local-studio" : "review-hosted",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    enableNitroErrorHandler: false,
    beforeSendTransaction: () => null,
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      return scrubSentryEvent(
        event as unknown as import("../../src/lib/sentry-telemetry").ScrubbableSentryEvent,
      ) as typeof event | null;
    },
  });
}
