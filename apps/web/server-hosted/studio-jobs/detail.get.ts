import { defineEventHandler, getRouterParam } from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import {
  hostedJobView,
  hostedMediaView,
} from "../../../workflows/src/contracts.js";
import { HostedRepositoryError } from "../../../workflows/src/repository.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import { throwHostedJobHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  try {
    const attemptId = parseOpaqueResourceId(getRouterParam(event, "id"));
    const runtime = getHostedWorkflowExecutor(event);
    const attempt = await runtime.repository.getAttempt(
      runtime.principalSub,
      attemptId,
    );
    if (!attempt) throw new HostedRepositoryError("hosted_attempt_not_found");
    const media = await runtime.repository.getMediaReceipt(
      runtime.principalSub,
      attempt.input.mediaId,
    );
    return {
      job: hostedJobView(attempt),
      ...(media ? { media: hostedMediaView(media) } : {}),
      events: await runtime.repository.events(
        runtime.principalSub,
        attempt.attemptId,
      ),
    };
  } catch (error) {
    throwHostedJobHttpError(error);
  }
});
