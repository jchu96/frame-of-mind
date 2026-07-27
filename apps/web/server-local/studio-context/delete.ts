import {
  defineEventHandler,
  getRouterParam,
  sendNoContent,
} from "h3";
import { assertTrustedMutation } from "../../server/utils/request-security.js";
import { throwContextHttpError } from "./http.js";
import { getLocalContextFileStaging } from "./service.js";

export default defineEventHandler(async (event) => {
  assertTrustedMutation(event);
  try {
    await (await getLocalContextFileStaging()).delete(
      getRouterParam(event, "id") || "",
    );
    return sendNoContent(event);
  } catch (error) {
    throwContextHttpError(error);
  }
});
