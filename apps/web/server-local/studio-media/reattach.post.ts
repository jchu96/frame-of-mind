import { defineEventHandler, getRouterParam } from "h3";
import { z } from "zod";
import { opaqueIdSchema } from "../../../../src/domain/studio-identifiers.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getStudioReviewMedia } from "./review-service.js";
import { readMediaJson, throwMediaHttpError } from "./http.js";
import { getRunStore } from "../../server/utils/store.js";
import { MediaStagingError } from "./local-media-staging.js";

const reattachRequestSchema = z.object({
  mediaSessionId: opaqueIdSchema,
}).strict();

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const input = reattachRequestSchema.parse(await readMediaJson(event));
    const runId = getRouterParam(event, "id") ?? "";
    const run = await (await getRunStore(event)).getRun(runId);
    if (!run) {
      throw new MediaStagingError("media_not_found", "Review media was not found.");
    }
    return await getStudioReviewMedia().reattach(
      runId,
      input.mediaSessionId,
      run.manifest.recordingSha256.toLowerCase(),
    );
  } catch (error) {
    throwMediaHttpError(error);
  }
});
