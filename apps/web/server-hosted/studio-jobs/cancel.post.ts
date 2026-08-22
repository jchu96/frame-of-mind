import { defineEventHandler, getRouterParam } from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { hostedJobView } from "../../../workflows/src/contracts.js";
import { HostedRepositoryError } from "../../../workflows/src/repository.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import { throwHostedJobHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const runtime = getHostedWorkflowExecutor(event);
    const attempt = await runtime.repository.requestCancellation(
      runtime.principalSub,
      parseOpaqueResourceId(getRouterParam(event, "id")),
      new Date().toISOString(),
    );
    if (!attempt) throw new HostedRepositoryError("hosted_attempt_not_found");
    return { job: hostedJobView(attempt) };
  } catch (error) {
    throwHostedJobHttpError(error);
  }
});
