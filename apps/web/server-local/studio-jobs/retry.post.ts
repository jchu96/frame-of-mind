import {
  defineEventHandler,
  getRouterParam,
  setResponseStatus,
} from "h3";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { jobRetryRequestSchema } from "../../../../src/domain/studio-schemas.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getStudioJobApi } from "./api-service.js";
import { readJobJson, throwJobHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const input = jobRetryRequestSchema.parse(await readJobJson(event));
    const result = await getStudioJobApi().retry(
      parseOpaqueResourceId(getRouterParam(event, "id")),
      input,
      new Date().toISOString(),
    );
    setResponseStatus(event, result.kind === "created" ? 201 : 200);
    return result;
  } catch (error) {
    throwJobHttpError(error);
  }
});
