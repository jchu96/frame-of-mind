import type { H3Event } from "h3";
import type { HostedTelemetryPort } from "../../../workflows/src/telemetry-contract.js";

const NOOP_HOSTED_TELEMETRY: HostedTelemetryPort = {
  enabled: false,
  async emit() {},
};

export function getHostedRouteTelemetry(_event: H3Event): HostedTelemetryPort {
  return NOOP_HOSTED_TELEMETRY;
}
