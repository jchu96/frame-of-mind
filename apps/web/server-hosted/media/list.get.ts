import {
  createError,
  defineEventHandler,
  getQuery,
  setResponseHeader,
} from "h3";
import {
  getHostedMediaRuntime,
  throwHostedMediaHttpError,
} from "./http.js";

export default defineEventHandler(async (event) => {
  try {
    if (getQuery(event).state !== "open") {
      throw createError({
        statusCode: 422,
        statusMessage: "Hosted media state is invalid.",
        data: { code: "invalid_hosted_media_state" },
      });
    }
    const runtime = getHostedMediaRuntime(event);
    setResponseHeader(event, "cache-control", "no-store");
    return { sessions: await runtime.service.listOpen(runtime.principalSub) };
  } catch (error) {
    throwHostedMediaHttpError(error);
  }
});
