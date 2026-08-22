import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import {
  hostedJobView,
  hostedRetryRequestSchema,
} from "../../../workflows/src/contracts.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import {
  hostedReservationUnits,
  newHostedOpaqueId,
  readHostedJobJson,
  throwHostedJobHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const request = hostedRetryRequestSchema.parse(await readHostedJobJson(event));
    const runtime = getHostedWorkflowExecutor(event);
    const result = await runtime.repository.createLinkedRetry({
      principalSub: runtime.principalSub,
      parentAttemptId: parseOpaqueResourceId(getRouterParam(event, "id")),
      idempotencyKey: request.idempotencyKey,
      reserveUnits: hostedReservationUnits(event),
      createdAt: new Date().toISOString(),
      attemptId: newHostedOpaqueId("attempt"),
      workflowInstanceId: newHostedOpaqueId("workflow"),
    });
    const dispatch = await runtime.executor.dispatch(result.attempt.attemptId);
    setResponseStatus(event, result.replayed ? 200 : 201);
    return {
      job: hostedJobView(result.attempt),
      dispatch: { replayed: dispatch.replayed },
    };
  } catch (error) {
    throwHostedJobHttpError(error);
  }
});
