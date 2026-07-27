import {
  defineEventHandler,
  getRouterParam,
} from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { jobCancelRequestSchema } from "../../../../src/domain/studio-schemas.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getStudioJobApi } from "./api-service.js";
import { readJobJson, throwJobHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    jobCancelRequestSchema.parse(await readJobJson(event));
    return await getStudioJobApi().cancel(
      parseOpaqueResourceId(getRouterParam(event, "id")),
      new Date().toISOString(),
    );
  } catch (error) {
    throwJobHttpError(error);
  }
});
