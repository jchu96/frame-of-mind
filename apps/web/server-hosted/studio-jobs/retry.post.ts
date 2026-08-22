import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import {
  hostedJobView,
  hostedRetryRequestSchema,
} from "../../../workflows/src/contracts.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import { getHostedRouteTelemetry } from "../telemetry.js";
import {
  hostedJobErrorCode,
  hostedSpendPolicy,
  newHostedOpaqueId,
  readHostedJobJson,
  throwHostedJobHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  const telemetry = getHostedRouteTelemetry(event);
  try {
    const runtime = getHostedWorkflowExecutor(event);
    const request = hostedRetryRequestSchema.parse(await readHostedJobJson(event));
    const now = new Date().toISOString();
    const spendPolicy = hostedSpendPolicy(event);
    await runtime.repository.ensurePrincipalSpendCap({
      principalSub: runtime.principalSub,
      ...(runtime.principalEmail
        ? { principalEmail: runtime.principalEmail }
        : {}),
      capUnits: spendPolicy.principalCapUnits,
      occurredAt: now,
    });
    const result = await runtime.repository.createLinkedRetry({
      principalSub: runtime.principalSub,
      parentAttemptId: parseOpaqueResourceId(getRouterParam(event, "id")),
      idempotencyKey: request.idempotencyKey,
      createdAt: now,
      attemptId: newHostedOpaqueId("attempt"),
      workflowInstanceId: newHostedOpaqueId("workflow"),
    });
    await telemetry.emit({
      area: "spend",
      outcome: "succeeded",
      code: "spend_retry_reservation_created",
      stage: "queued",
      jobId: result.attempt.attemptId,
      recipeId: result.attempt.input.recipe.id,
      recipeRevision: result.attempt.input.recipe.revision,
      model: result.attempt.input.model,
      studioMode: "hosted",
    });
    const dispatch = await runtime.executor.dispatch(result.attempt.attemptId);
    setResponseStatus(event, result.replayed ? 200 : 201);
    return {
      job: hostedJobView(result.attempt),
      dispatch: { replayed: dispatch.replayed },
    };
  } catch (error) {
    await telemetry.emit({
      area: "spend",
      outcome: "failed",
      code: hostedJobErrorCode(error),
      stage: "queued",
      routeClass: "hosted_job_retry",
      studioMode: "hosted",
    });
    throwHostedJobHttpError(error);
  }
});
