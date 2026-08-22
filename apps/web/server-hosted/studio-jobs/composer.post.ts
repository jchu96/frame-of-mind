import { defineEventHandler, setResponseStatus } from "h3";
import {
  composerPayloadSchema,
  type MediaSession,
} from "../../../../src/domain/studio-schemas.js";
import { builtInRecipe, digestRecipe } from "../../../../src/recipes/index.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { translateComposerJob } from "../../app/studio/composer-translate.js";
import { hostedJobCreateRequestSchema } from "../../../workflows/src/contracts.js";
import { createHostedJob } from "./create-service.js";
import { getHostedWorkflowExecutor } from "./executor.js";
import { readHostedJobJson, throwHostedJobHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const runtime = getHostedWorkflowExecutor(event);
    const payload = composerPayloadSchema.parse(await readHostedJobJson(event));
    const media = await runtime.repository.requireUsableMediaReceipt(
      runtime.principalSub,
      payload.mediaSessionId,
      new Date().toISOString(),
    );
    const recipe = "id" in payload.recipe
      ? builtInRecipe(payload.recipe.id)
      : undefined;
    const translated = translateComposerJob({
      payload,
      mediaSession: hostedStudioMediaSession(media),
      resolvedRecipe: recipe
        ? {
            recipe,
            custom: false,
            sha256: await digestRecipe(recipe),
            revision: recipe.revision ?? "builtin-2026-08-11.1",
          }
        : undefined,
      now: new Date().toISOString(),
    });
    const request = hostedJobCreateRequestSchema.parse({
      idempotencyKey: translated.idempotencyKey,
      mediaId: translated.input.mediaSessionId,
      context: translated.input.context,
      recipeId: translated.input.recipe.id,
      model: translated.input.model,
      ...(translated.input.focus ? { focus: translated.input.focus } : {}),
      ...(translated.input.transcriptOffsetSeconds !== undefined
        ? { transcriptOffsetSeconds: translated.input.transcriptOffsetSeconds }
        : {}),
    });
    const result = await createHostedJob(event, request);
    setResponseStatus(event, result.status);
    return result.body;
  } catch (error) {
    throwHostedJobHttpError(error);
  }
});

function hostedStudioMediaSession(
  receipt: Awaited<ReturnType<
    ReturnType<typeof getHostedWorkflowExecutor>["repository"]["requireUsableMediaReceipt"]
  >>,
): MediaSession {
  return {
    id: receipt.mediaId,
    status: "sealed",
    expectedBytes: 1,
    receivedBytes: 1,
    partSizeBytes: 1,
    parts: [{
      part: 0,
      offset: 0,
      bytes: 1,
      sha256: receipt.sha256,
      receivedAt: receipt.sealedAt,
    }],
    mimeType: receipt.mimeType,
    sha256: receipt.sha256,
    retention: {
      mode: receipt.retention,
      expiresAt: receipt.expiresAt,
    },
    createdAt: receipt.sealedAt,
    updatedAt: receipt.sealedAt,
  };
}
