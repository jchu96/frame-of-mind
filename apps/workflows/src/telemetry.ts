import {
  normalizeTelemetryTags,
  scrubSentryEvent,
} from "../../../src/lib/sentry-telemetry.js";
import {
  hostedTelemetryEventSchema,
  type HostedTelemetryEvent,
  type HostedTelemetryPort,
} from "./telemetry-contract.js";

export * from "./telemetry-contract.js";

export interface HostedTelemetryEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
}

export type HostedTelemetryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createHostedTelemetry(
  env: HostedTelemetryEnv,
  send: HostedTelemetryFetch = fetch,
): HostedTelemetryPort {
  const dsn = parseSentryDsn(env.SENTRY_DSN);
  if (!dsn) return NOOP_HOSTED_TELEMETRY;
  return {
    enabled: true,
    async emit(input) {
      const event = hostedTelemetryEventSchema.parse(input);
      const eventId = crypto.randomUUID().replaceAll("-", "");
      const scrubbed = scrubSentryEvent({
        event_id: eventId,
        timestamp: Date.now() / 1_000,
        level: event.outcome === "failed" || event.outcome === "timeout"
          ? "error"
          : "info",
        platform: "cloudflare",
        ...(safeOptionalMetadata(env.SENTRY_ENVIRONMENT)
          ? { environment: env.SENTRY_ENVIRONMENT?.trim() }
          : {}),
        ...(safeOptionalMetadata(env.SENTRY_RELEASE)
          ? { release: env.SENTRY_RELEASE?.trim() }
          : {}),
        sdk: { name: "frame-of-mind-hosted", version: "1" },
        exception: { values: [{ value: event.code }] },
        tags: normalizeTelemetryTags(event),
      });
      if (!scrubbed) return;
      const envelope = [
        JSON.stringify({ event_id: eventId, dsn: dsn.publicDsn }),
        JSON.stringify({ type: "event" }),
        JSON.stringify(scrubbed),
      ].join("\n");
      await send(dsn.envelopeUrl, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope" },
        body: envelope,
      }).catch(() => undefined);
    },
  };
}

export const NOOP_HOSTED_TELEMETRY: HostedTelemetryPort = {
  enabled: false,
  async emit() {},
};

function parseSentryDsn(value: string | undefined): {
  envelopeUrl: string;
  publicDsn: string;
} | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.username || url.password) return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = segments.pop();
    if (!projectId || !/^\d+$/.test(projectId)) return undefined;
    const prefix = segments.length ? `/${segments.join("/")}` : "";
    const publicDsn = `${url.protocol}//${url.username}@${url.host}${prefix}/${projectId}`;
    return {
      publicDsn,
      envelopeUrl: `${url.origin}${prefix}/api/${projectId}/envelope/`
        + `?sentry_key=${encodeURIComponent(url.username)}&sentry_version=7`,
    };
  } catch {
    return undefined;
  }
}

function safeOptionalMetadata(value: string | undefined): boolean {
  return Boolean(value?.trim())
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value!.trim());
}
