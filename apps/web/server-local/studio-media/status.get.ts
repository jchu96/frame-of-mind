import {
  createError,
  defineEventHandler,
  getRouterParam,
} from "h3";
import { throwMediaHttpError } from "./http.js";
import { getLocalMediaStaging } from "./service.js";

export default defineEventHandler(async (event) => {
  try {
    const session = await (await getLocalMediaStaging()).get(
      getRouterParam(event, "id") || "",
    );
    if (!session) {
      throw createError({
        statusCode: 404,
        statusMessage: "Media session was not found.",
      });
    }
    return session;
  } catch (error) {
    throwMediaHttpError(error);
  }
});
