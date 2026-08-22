import * as Sentry from "@sentry/nuxt";
import { scrubSentryEvent } from "../../src/lib/sentry-telemetry";

const dsn = process.env.SENTRY_DSN?.trim() ?? "";
const localStudio = process.env.FRAME_OF_MIND_STUDIO === "1"
  && process.env.NITRO_PRESET !== "cloudflare-worker";

Sentry.init({
  dsn: dsn || undefined,
  enabled: dsn.length > 0,
  environment: localStudio ? "local-studio" : "review-hosted",
  sendDefaultPii: false,
  tracesSampleRate: 0,
  defaultIntegrations: false,
  beforeBreadcrumb: () => null,
  beforeSend(event) {
    return scrubSentryEvent(event as typeof event & import("../../src/lib/sentry-telemetry").ScrubbableSentryEvent);
  },
});
