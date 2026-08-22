import { defineEventHandler, getRouterParam } from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { hostedMediaView } from "../../../workflows/src/contracts.js";
import { HostedRepositoryError } from "../../../workflows/src/repository.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import { throwHostedJobHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  try {
    const runtime = getHostedWorkflowExecutor(event);
    const receipt = await runtime.repository.getMediaReceipt(
      runtime.principalSub,
      parseOpaqueResourceId(getRouterParam(event, "id")),
    );
    if (!receipt) throw new HostedRepositoryError("hosted_media_not_found");
    return { media: hostedMediaView(receipt) };
  } catch (error) {
    throwHostedJobHttpError(error);
  }
});
