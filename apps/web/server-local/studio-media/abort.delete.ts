import {
  defineEventHandler,
  getRouterParam,
} from "h3";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { throwMediaHttpError } from "./http.js";
import { getLocalMediaStaging } from "./service.js";

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    return await (await getLocalMediaStaging()).abort(
      getRouterParam(event, "id") || "",
    );
  } catch (error) {
    throwMediaHttpError(error);
  }
});
