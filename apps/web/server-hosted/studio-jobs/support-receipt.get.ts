import {
  defineEventHandler,
  getRouterParam,
  setResponseHeader,
} from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { hostedJobView, hostedMediaView } from "../../../workflows/src/contracts.js";
import { HostedRepositoryError } from "../../../workflows/src/repository.js";
import { hostedStage } from "../studio-ui/hosted-adapter.js";
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
    const mediaReceipt = await runtime.repository.getMediaReceipt(
      runtime.principalSub,
      attempt.input.mediaId,
    );
    const view = hostedJobView(attempt);
    const mediaView = mediaReceipt ? hostedMediaView(mediaReceipt) : undefined;
    const receipt = `${[
      "Frame of Mind support receipt v1",
      `job_id=${view.id}`,
      `stage=${hostedStage(view.stage)}`,
      `terminal_code=${view.errorCode ?? "none"}`,
      `created_at=${view.createdAt}`,
      `updated_at=${view.updatedAt}`,
      `terminal_at=${isTerminal(view.stage) ? view.updatedAt : "none"}`,
      `cancellation_requested_at=${view.cancellationRequestedAt ?? "none"}`,
      `provider_id=${view.receipt.context.provider ?? "none"}`,
      `recipe_id=${view.receipt.recipe.id}`,
      `media_retention_state=${view.receipt.retention}`,
      `media_retention_expires_at=${mediaView?.expiresAt ?? "none"}`,
      `cleanup_state=${view.cleanupCompleted ? "completed" : "pending"}`,
    ].join("\n")}\n`;
    setResponseHeader(event, "content-type", "text/plain; charset=utf-8");
    setResponseHeader(event, "cache-control", "no-store");
    return receipt;
  } catch (error) {
    throwHostedJobHttpError(error);
  }
});

function isTerminal(stage: ReturnType<typeof hostedJobView>["stage"]): boolean {
  return ["succeeded", "failed", "canceled", "indeterminate"].includes(stage);
}
