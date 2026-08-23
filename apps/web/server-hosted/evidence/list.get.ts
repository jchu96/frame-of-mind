import { defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { runIdSchema } from "../../../../src/domain/schemas.js";
import { getHostedEvidenceRuntime, throwHostedEvidenceHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  try {
    const runId = runIdSchema.parse(getRouterParam(event, "id"));
    const runtime = getHostedEvidenceRuntime(event);
    setResponseHeader(event, "cache-control", "no-store");
    return await runtime.service.list(runtime.principalSub, runId);
  } catch (error) {
    throwHostedEvidenceHttpError(error);
  }
});
