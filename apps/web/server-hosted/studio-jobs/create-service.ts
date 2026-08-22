import type { H3Event } from "h3";
import { DEFAULT_GEMINI_MODEL } from "../../../../src/adapters/gemini-model.js";
import { builtInRecipe, digestRecipe } from "../../../../src/recipes/index.js";
import {
  hostedJobView,
  type HostedAttemptInput,
  type HostedJobCreateRequest,
} from "../../../workflows/src/contracts.js";
import { getHostedRouteTelemetry } from "../telemetry.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import {
  hostedSpendPlan,
  hostedSpendPolicy,
  newHostedOpaqueId,
} from "./http.js";

export async function createHostedJob(
  event: H3Event,
  request: HostedJobCreateRequest,
) {
  const runtime = getHostedWorkflowExecutor(event);
  const now = new Date().toISOString();
  const media = await runtime.repository.requireUsableMediaReceipt(
    runtime.principalSub,
    request.mediaId,
    now,
  );
  const recipe = builtInRecipe(request.recipeId);
  const spendPlan = hostedSpendPlan(event, media.durationSeconds);
  const immutableInput: HostedAttemptInput = {
    mediaId: media.mediaId,
    mediaSha256: media.sha256,
    context: request.context,
    recipe: {
      id: recipe.id,
      label: recipe.label,
      revision: recipe.revision ?? "builtin-2026-08-11.1",
      sha256: await digestRecipe(recipe),
    },
    model: request.model ?? DEFAULT_GEMINI_MODEL,
    ...(request.focus ? { focus: request.focus } : {}),
    ...(request.transcriptOffsetSeconds !== undefined
      ? { transcriptOffsetSeconds: request.transcriptOffsetSeconds }
      : {}),
    retention: media.retention,
    spendPlan,
  };
  const spendPolicy = hostedSpendPolicy(event);
  await runtime.repository.ensurePrincipalSpendCap({
    principalSub: runtime.principalSub,
    ...(runtime.principalEmail
      ? { principalEmail: runtime.principalEmail }
      : {}),
    capUnits: spendPolicy.principalCapUnits,
    occurredAt: now,
  });
  const result = await runtime.repository.createInitialAttempt({
    principalSub: runtime.principalSub,
    ...(runtime.principalEmail
      ? { principalEmail: runtime.principalEmail }
      : {}),
    idempotencyKey: request.idempotencyKey,
    immutableInput,
    createdAt: now,
    jobId: newHostedOpaqueId("job"),
    attemptId: newHostedOpaqueId("attempt"),
    workflowInstanceId: newHostedOpaqueId("workflow"),
  });
  await getHostedRouteTelemetry(event).emit({
    area: "spend",
    outcome: "succeeded",
    code: "spend_reservation_created",
    stage: "queued",
    jobId: result.attempt.attemptId,
    recipeId: result.attempt.input.recipe.id,
    recipeRevision: result.attempt.input.recipe.revision,
    model: result.attempt.input.model,
    studioMode: "hosted",
  });
  const dispatch = await runtime.executor.dispatch(result.attempt.attemptId);
  return {
    status: result.replayed ? 200 : 201,
    body: {
      job: hostedJobView(result.attempt),
      dispatch: { replayed: dispatch.replayed },
    },
  };
}
