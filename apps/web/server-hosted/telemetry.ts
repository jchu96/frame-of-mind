import type { H3Event } from "h3";
import {
  hostedTelemetryEventSchema,
  type HostedTelemetryEvent,
  type HostedTelemetryPort,
} from "../../workflows/src/telemetry-contract.js";

interface HostedTelemetryServiceBinding {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export function getHostedRouteTelemetry(event: H3Event): HostedTelemetryPort {
  const service = event.context.cloudflare?.env.HOSTED_WORKFLOWS as
    | HostedTelemetryServiceBinding
    | undefined;
  if (!service) return NOOP_HOSTED_TELEMETRY;
  return {
    enabled: true,
    async emit(input: HostedTelemetryEvent) {
      const telemetryEvent = hostedTelemetryEventSchema.parse(input);
      await service.fetch("http://hosted-workflows.internal/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(telemetryEvent),
      }).catch(() => undefined);
    },
  };
}

// Phase 2 will consume this narrow interface at its upload boundary. Keeping
// it here avoids inventing upload persistence while that slice remains gated.
export type HostedUploadTelemetryPort = Pick<HostedTelemetryPort, "emit">;

const NOOP_HOSTED_TELEMETRY: HostedTelemetryPort = {
  enabled: false,
  async emit() {},
};
