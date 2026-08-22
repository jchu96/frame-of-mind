import * as Sentry from "@sentry/nuxt";
import { scrubSentryEvent } from "../../src/lib/sentry-telemetry";

const config = useRuntimeConfig();
const dsn = String(config.public.sentryDsn ?? "").trim();

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
    environment: config.public.studioEnabled ? "local-studio" : "review-hosted",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    beforeSendTransaction: () => null,
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      return scrubSentryEvent(
        event as unknown as import("../../src/lib/sentry-telemetry").ScrubbableSentryEvent,
      ) as typeof event | null;
    },
  });
}
