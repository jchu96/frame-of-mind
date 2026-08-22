import { defineEventHandler, getQuery } from "h3";
import { hostedJobView } from "../../../workflows/src/contracts.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import { throwHostedJobHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  try {
    const requested = Number(getQuery(event).limit ?? 100);
    const limit = Number.isSafeInteger(requested) && requested >= 1
      && requested <= 100
      ? requested
      : 100;
    const runtime = getHostedWorkflowExecutor(event);
    const page = await runtime.repository.listAttempts(
      runtime.principalSub,
      limit,
    );
    return { jobs: page.attempts.map(hostedJobView) };
  } catch (error) {
    throwHostedJobHttpError(error);
  }
});
