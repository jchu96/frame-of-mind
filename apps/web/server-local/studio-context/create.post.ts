import {
  defineEventHandler,
  setResponseStatus,
} from "h3";
import { assertTrustedMutation } from "../../server/utils/request-security.js";
import {
  parseContextUploadHeaders,
  throwContextHttpError,
} from "./http.js";
import { getLocalContextFileStaging } from "./service.js";

export default defineEventHandler(async (event) => {
  assertTrustedMutation(event);
  try {
    const headers = parseContextUploadHeaders(event);
    const receipt = await (await getLocalContextFileStaging()).stage({
      ...headers,
      bytes: event.node.req,
    });
    setResponseStatus(event, 201);
    return receipt;
  } catch (error) {
    throwContextHttpError(error);
  }
});
