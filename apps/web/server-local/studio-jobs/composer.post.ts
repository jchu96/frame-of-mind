import { defineEventHandler, setResponseStatus } from "h3";
import {
  composerPayloadSchema,
} from "../../../../src/domain/studio-schemas.js";
import { loadRecipe } from "../../../../src/recipes/index.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getLocalMediaStaging } from "../studio-media/service.js";
import { StudioJobInputUnavailableError } from "./analysis-options.js";
import { getStudioJobApi } from "./api-service.js";
import { translateComposerJob } from "./composer-translate.js";
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
    let resolvedRecipe;
    try {
      resolvedRecipe = await loadRecipe(payload.recipe.id);
    } catch {
      throw new StudioJobInputUnavailableError("recipe_not_found");
    }
    const mediaSession = await (await getLocalMediaStaging()).get(
      payload.mediaSessionId,
    );
    const request = translateComposerJob({
      payload,
      mediaSession,
      resolvedRecipe,
      now,
    });
    const result = await getStudioJobApi().create(request, now);
    setResponseStatus(event, result.kind === "created" ? 201 : 200);
    return result;
  } catch (error) {
    throwJobHttpError(error);
  }
});
