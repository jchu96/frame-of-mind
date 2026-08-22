import { defineEventHandler } from "h3";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getHostedRouteTelemetry } from "../telemetry.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import {
  hostedJobErrorCode,
  throwHostedJobHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  const telemetry = getHostedRouteTelemetry(event);
  try {
    const runtime = getHostedWorkflowExecutor(event);
    const result = await runtime.repository.reconcileStaleSpendReservations({
      principalSub: runtime.principalSub,
      occurredAt: new Date().toISOString(),
    });
    await telemetry.emit({
      area: "spend",
      outcome: "succeeded",
      code: "spend_janitor_completed",
      stage: "queued",
      routeClass: "hosted_spend_janitor",
      studioMode: "hosted",
    });
    return { ok: true, ...result };
  } catch (error) {
    await telemetry.emit({
      area: "spend",
      outcome: "failed",
      code: hostedJobErrorCode(error),
      stage: "queued",
      routeClass: "hosted_spend_janitor",
      studioMode: "hosted",
    });
    throwHostedJobHttpError(error);
  }
});
