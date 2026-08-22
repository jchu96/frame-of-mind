import { defineEventHandler, setResponseStatus } from "h3";
import { DEFAULT_GEMINI_MODEL } from "../../../../src/adapters/gemini-model.js";
import { builtInRecipe, digestRecipe } from "../../../../src/recipes/index.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import {
  hostedJobCreateRequestSchema,
  hostedJobView,
  type HostedAttemptInput,
} from "../../../workflows/src/contracts.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import {
  hostedSpendPlan,
  hostedSpendPolicy,
  newHostedOpaqueId,
  readHostedJobJson,
  throwHostedJobHttpError,
} from "./http.js";

const BUILT_IN_RECIPE_REVISION = "builtin-2026-07-27.1";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const request = hostedJobCreateRequestSchema.parse(
      await readHostedJobJson(event),
    );
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
        revision: recipe.revision ?? BUILT_IN_RECIPE_REVISION,
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
    const jobId = newHostedOpaqueId("job");
    const attemptId = newHostedOpaqueId("attempt");
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
      jobId,
      attemptId,
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
