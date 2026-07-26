import { stat } from "node:fs/promises";
import {
  createError,
  defineEventHandler,
  getHeader,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import { spikePaths } from "./config.js";
import { parseSingleByteRange } from "./range.js";

export default defineEventHandler(async (event) => {
  const { sealed } = spikePaths();
  const file = Bun.file(sealed);
  let size: number;
  try {
    size = (await stat(sealed)).size;
  } catch {
    throw createError({ statusCode: 404, statusMessage: "Synthetic media is not sealed." });
  }

  setResponseHeader(event, "accept-ranges", "bytes");
  setResponseHeader(event, "cache-control", "no-store");
  setResponseHeader(event, "content-disposition", "inline");
  setResponseHeader(event, "content-type", "application/octet-stream");
  const rangeHeader = getHeader(event, "range");
  if (!rangeHeader) {
    setResponseHeader(event, "content-length", String(size));
    return file.stream();
  }

  const range = parseSingleByteRange(rangeHeader, size);
  if (!range) {
    setResponseStatus(event, 416);
    setResponseHeader(event, "content-range", `bytes */${size}`);
    return "";
  }

  const length = range.end - range.start + 1;
  setResponseStatus(event, 206);
  setResponseHeader(
    event,
    "content-range",
    `bytes ${range.start}-${range.end}/${size}`,
  );
  setResponseHeader(event, "content-length", String(length));
  return file.slice(range.start, range.end + 1).stream();
});
