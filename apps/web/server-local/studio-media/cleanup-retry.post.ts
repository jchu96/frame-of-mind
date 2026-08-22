import { defineEventHandler, getRouterParam } from "h3";
import { z } from "zod";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { readMediaJson, throwMediaHttpError } from "./http.js";
import { getLocalMediaStaging } from "./service.js";
import { retryFailedMediaCleanup } from "./cleanup-retry.js";

const emptyRequestSchema = z.object({}).strict();

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    emptyRequestSchema.parse(await readMediaJson(event));
    return await retryFailedMediaCleanup(
      await getLocalMediaStaging(),
      getRouterParam(event, "id") || "",
    );
  } catch (error) {
    throwMediaHttpError(error);
  }
});
