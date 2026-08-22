import * as Sentry from "@sentry/nuxt";
import { scrubSentryEvent } from "../../src/lib/sentry-telemetry";

const config = useRuntimeConfig();
const dsn = String(config.public.sentryDsn ?? "").trim();

Sentry.init({
  dsn: dsn || undefined,
  enabled: dsn.length > 0,
  environment: config.public.studioEnabled ? "local-studio" : "review-hosted",
  sendDefaultPii: false,
  tracesSampleRate: 0,
  defaultIntegrations: false,
  beforeBreadcrumb: () => null,
  beforeSend(event) {
    return scrubSentryEvent(event as typeof event & import("../../src/lib/sentry-telemetry").ScrubbableSentryEvent);
  },
});
