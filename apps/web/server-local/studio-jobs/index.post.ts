import {
  defineEventHandler,
  setResponseStatus,
} from "h3";
import { jobCreateRequestSchema } from "../../../../src/domain/studio-schemas.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getStudioJobApi } from "./api-service.js";
import { readJobJson, throwJobHttpError } from "./http.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const input = jobCreateRequestSchema.parse(await readJobJson(event));
    const result = await getStudioJobApi().create(
      input,
      new Date().toISOString(),
    );
    setResponseStatus(event, result.kind === "created" ? 201 : 200);
    return result;
  } catch (error) {
    throwJobHttpError(error);
  }
});
