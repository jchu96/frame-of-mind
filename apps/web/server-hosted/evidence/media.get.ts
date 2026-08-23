import { defineEventHandler, getHeader, getRouterParam, setResponseHeader, setResponseStatus } from "h3";
import { runIdSchema } from "../../../../src/domain/schemas.js";
import { getHostedEvidenceRuntime, throwHostedEvidenceHttpError } from "./http.js";
import { parseHostedByteRange } from "./range.js";

export default defineEventHandler(async (event) => {
  try {
    if (getHeader(event, "if-range")) {
      throw createError({ statusCode: 400, statusMessage: "Conditional ranges are unsupported." });
    }
    const runId = runIdSchema.parse(getRouterParam(event, "id"));
    const runtime = getHostedEvidenceRuntime(event);
    const info = await runtime.service.mediaInfo(runtime.principalSub, runId);
    const requestedRange = getHeader(event, "range");
    const range = parseHostedByteRange(requestedRange, info.total);
    if (requestedRange && !range) {
      setResponseStatus(event, 416);
      setResponseHeader(event, "content-range", `bytes */${info.total}`);
      return "";
    }
    const result = await runtime.service.openMedia(runtime.principalSub, runId, range);
    setResponseHeader(event, "accept-ranges", "bytes");
    setResponseHeader(event, "cache-control", "private, no-store");
    setResponseHeader(event, "content-disposition", "inline");
    setResponseHeader(event, "x-content-type-options", "nosniff");
    setResponseHeader(event, "content-type", result.mimeType);
    const contentLength = range ? range.end - range.start + 1 : result.total;
    setResponseHeader(event, "content-length", contentLength);
    if (range) {
      setResponseStatus(event, 206);
      setResponseHeader(event, "content-range", `bytes ${range.start}-${range.end}/${result.total}`);
    }
    setResponseHeader(event, "x-fom-recording-sha256", info.recordingSha256);
    return result.object.body;
  } catch (error) {
    throwHostedEvidenceHttpError(error);
  }
});
