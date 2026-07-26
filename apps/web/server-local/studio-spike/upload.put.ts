import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { createError, defineEventHandler, getHeader } from "h3";
import { MAX_SPIKE_BYTES, spikePaths } from "./config.js";

function sanitizedErrorCode(error: unknown): string {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z0-9_]+$/.test(error.code)
  ) {
    return error.code;
  }
  return "UNKNOWN";
}

export default defineEventHandler(async (event) => {
  const declaredLength = Number(getHeader(event, "content-length"));
  if (
    !Number.isSafeInteger(declaredLength)
    || declaredLength <= 0
    || declaredLength > MAX_SPIKE_BYTES
  ) {
    throw createError({
      statusCode: 413,
      statusMessage: `Synthetic spike uploads require Content-Length from 1 to ${MAX_SPIKE_BYTES}.`,
    });
  }

  const paths = spikePaths();
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await rm(paths.partial, { force: true });
  await rm(paths.sealed, { force: true });

  const writer = Bun.file(paths.partial).writer({ highWaterMark: 256 * 1_024 });
  const digest = createHash("sha256");
  const startHeapBytes = process.memoryUsage().heapUsed;
  const startRssBytes = process.memoryUsage().rss;
  let peakHeapBytes = startHeapBytes;
  let peakRssBytes = startRssBytes;
  let receivedBytes = 0;
  let chunks = 0;
  let closed = false;

  try {
    for await (const value of event.node.req) {
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
      receivedBytes += chunk.byteLength;
      chunks += 1;
      if (receivedBytes > declaredLength || receivedBytes > MAX_SPIKE_BYTES) {
        throw createError({
          statusCode: 413,
          statusMessage: "Synthetic upload exceeded its declared or maximum size.",
        });
      }
      digest.update(chunk);
      const result = await writer.write(chunk);
      if (typeof result === "number" && result < 0) {
        await writer.flush();
      }
      const memory = process.memoryUsage();
      peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
    }
    if (receivedBytes !== declaredLength) {
      throw createError({
        statusCode: 400,
        statusMessage: "Synthetic upload byte count did not match Content-Length.",
      });
    }
    await writer.end();
    closed = true;
    await rename(paths.partial, paths.sealed);
    return {
      receivedBytes,
      chunks,
      sha256: digest.digest("hex"),
      startHeapBytes,
      peakHeapBytes,
      startRssBytes,
      peakRssBytes,
    };
  } catch (error) {
    if (!closed) {
      try {
        await writer.end(error instanceof Error ? error : undefined);
      } catch {
        // Preserve the original bounded/sanitized request failure.
      }
    }
    try {
      await rm(paths.partial, { force: true });
    } catch (cleanupError) {
      console.error("Studio spike partial cleanup failed.", {
        code: sanitizedErrorCode(cleanupError),
      });
    }
    throw error;
  }
});
