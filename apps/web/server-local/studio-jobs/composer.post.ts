import { defineEventHandler, setResponseStatus } from "h3";
import {
  composerPayloadSchema,
} from "../../../../src/domain/studio-schemas.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getLocalMediaStaging } from "../studio-media/service.js";
import { StudioJobInputUnavailableError } from "./analysis-options.js";
import { getStudioJobApi } from "./api-service.js";
import { resolveComposerRecipe } from "./composer-recipe.js";
import {
  translateComposerJob,
  translateComposerReplay,
} from "./composer-translate.js";
import { readJobJson, throwJobHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const payload = composerPayloadSchema.parse(await readJobJson(event));
    if ("custom" in payload.recipe) {
      throw new StudioJobInputUnavailableError(
        "custom_recipe_staging_unavailable",
      );
    }
    const now = new Date().toISOString();
    const resolvedRecipe = await resolveComposerRecipe(payload.recipe.id);
    const api = getStudioJobApi();
    const existing = await api.findByIdempotencyKey(payload.idempotencyKey);
    const mediaSession = await (await getLocalMediaStaging()).get(
      payload.mediaSessionId,
    );
    const translation = { payload, mediaSession, resolvedRecipe, now };
    const request = existing
      ? translateComposerReplay(translation)
      : translateComposerJob(translation);
    const result = await api.create(request, now);
    setResponseStatus(event, result.kind === "created" ? 201 : 200);
    return result;
  } catch (error) {
    throwJobHttpError(error);
  }
});
