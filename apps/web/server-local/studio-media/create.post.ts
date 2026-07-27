import {
  defineEventHandler,
  setResponseStatus,
} from "h3";
import { mediaCreateRequestSchema } from "../../../../src/domain/studio-schemas.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { readMediaJson, throwMediaHttpError } from "./http.js";
import { getLocalMediaStaging } from "./service.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const input = mediaCreateRequestSchema.parse(await readMediaJson(event));
    const staging = await getLocalMediaStaging();
    const session = await staging.create(input);
    setResponseStatus(event, 201);
    return session;
  } catch (error) {
    throwMediaHttpError(error);
  }
});
