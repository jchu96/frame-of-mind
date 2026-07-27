import {
  defineEventHandler,
  getRouterParam,
} from "h3";
import { mediaCompleteRequestSchema } from "../../../../src/domain/studio-schemas.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { readMediaJson, throwMediaHttpError } from "./http.js";
import { getLocalMediaStaging } from "./service.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const input = mediaCompleteRequestSchema.parse(await readMediaJson(event));
    return await (await getLocalMediaStaging()).seal(
      getRouterParam(event, "id") || "",
      { expectedSha256: input.expectedSha256 },
    );
  } catch (error) {
    throwMediaHttpError(error);
  }
});
