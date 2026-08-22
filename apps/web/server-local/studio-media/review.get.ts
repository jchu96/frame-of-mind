import {
  createError,
  defineEventHandler,
  getHeader,
  getRouterParam,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import { getStudioReviewMedia } from "./review-service.js";

export default defineEventHandler(async (event) => {
  if (event.method !== "GET") {
    setResponseHeader(event, "allow", "GET");
    throw createError({
      statusCode: 405,
      statusMessage: "Only GET is supported for retained media.",
    });
  }
  if (getHeader(event, "if-range")) {
    throw createError({
      statusCode: 400,
      statusMessage: "Conditional media ranges are not supported.",
    });
  }

  const result = await getStudioReviewMedia().open(
    getRouterParam(event, "id") ?? "",
    getHeader(event, "range"),
  );
  if (result.kind === "not_found") {
    throw createError({ statusCode: 404, statusMessage: "Retained media was not found." });
  }

  setResponseHeader(event, "accept-ranges", "bytes");
  setResponseHeader(event, "cache-control", "no-store");
  setResponseHeader(event, "content-disposition", "inline");
  setResponseHeader(event, "x-content-type-options", "nosniff");
  if (result.kind === "range_not_satisfiable") {
    setResponseStatus(event, 416);
    setResponseHeader(event, "content-range", `bytes */${result.size}`);
    return "";
  }

  const { response } = result;
  setResponseHeader(event, "content-type", response.mimeType);
  setResponseHeader(event, "content-length", String(response.contentLength));
  if (response.range) {
    setResponseStatus(event, 206);
    setResponseHeader(
      event,
      "content-range",
      `bytes ${response.range.start}-${response.range.end}/${response.range.total}`,
    );
  }
  return response.body;
});
