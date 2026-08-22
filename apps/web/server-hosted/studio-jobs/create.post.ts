import { defineEventHandler, setResponseStatus } from "h3";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import {
  hostedJobCreateRequestSchema,
} from "../../../workflows/src/contracts.js";
import { createHostedJob } from "./create-service.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import { getHostedRouteTelemetry } from "../telemetry.js";
import {
  hostedJobErrorCode,
  readHostedJobJson,
  throwHostedJobHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  const telemetry = getHostedRouteTelemetry(event);
  try {
    getHostedWorkflowExecutor(event);
    const request = hostedJobCreateRequestSchema.parse(
      await readHostedJobJson(event),
    );
    const result = await createHostedJob(event, request);
    setResponseStatus(event, result.status);
    return result.body;
  } catch (error) {
    await telemetry.emit({
      area: "spend",
      outcome: "failed",
      code: hostedJobErrorCode(error),
      stage: "queued",
      routeClass: "hosted_job_create",
      studioMode: "hosted",
    });
    throwHostedJobHttpError(error);
  }
});
