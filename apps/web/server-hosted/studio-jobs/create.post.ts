import { defineEventHandler, setResponseStatus } from "h3";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import {
  hostedJobCreateRequestSchema,
} from "../../../workflows/src/contracts.js";
import { createHostedJob } from "./create-service.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import {
  readHostedJobJson,
  throwHostedJobHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    getHostedWorkflowExecutor(event);
    const request = hostedJobCreateRequestSchema.parse(
      await readHostedJobJson(event),
    );
    const result = await createHostedJob(event, request);
    setResponseStatus(event, result.status);
    return result.body;
  } catch (error) {
    throwHostedJobHttpError(error);
  }
});
