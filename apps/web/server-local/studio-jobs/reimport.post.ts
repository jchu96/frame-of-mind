import {
  createError,
  defineEventHandler,
  getRouterParam,
} from "h3";
import { z } from "zod";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getRunStore } from "../../server/utils/store.js";
import { getStudioJobApi } from "./api-service.js";
import { resolveLocalRunRoot } from "./analysis-options.js";
import { readJobJson, throwJobHttpError } from "./http.js";
import { reimportPublishedJobRun } from "./run-reimport.js";

const emptyRequestSchema = z.object({}).strict();

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    emptyRequestSchema.parse(await readJobJson(event));
    const id = parseOpaqueResourceId(getRouterParam(event, "id"));
    const detail = await getStudioJobApi().detail(id, {
      afterSequence: 0,
      limit: 1,
    });
    if (!detail) {
      throw createError({
        statusCode: 404,
        statusMessage: "Analysis job was not found.",
        data: { code: "job_not_found" },
      });
    }
    return await reimportPublishedJobRun({
      job: detail.job,
      outputRoot: resolveLocalRunRoot(),
      store: await getRunStore(event),
    });
  } catch (error) {
    throwJobHttpError(error);
  }
});
