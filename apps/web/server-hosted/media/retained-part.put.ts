import { defineEventHandler, getHeader, getQuery, getRequestWebStream, getRouterParam } from "h3";
import { z } from "zod";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { assertTrustedMutation } from "../../server/utils/request-security.js";
import { getHostedMediaRuntime, throwHostedMediaHttpError } from "./http.js";

const querySchema = z.object({
  cap: z.string().length(64).regex(/^[a-f0-9]+$/),
  partNumber: z.coerce.number().int().min(1).max(10_000),
}).passthrough();

export default defineEventHandler(async (event) => {
  assertTrustedMutation(event);
  try {
    const runtime = getHostedMediaRuntime(event);
    const query = querySchema.parse(getQuery(event));
    const body = getRequestWebStream(event);
    if (!body) throw createError({ statusCode: 400, statusMessage: "Retained part body is required." });
    const contentLength = Number(getHeader(event, "content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
      throw createError({ statusCode: 411, statusMessage: "Retained part length is required." });
    }
    const FixedLength = (globalThis as unknown as {
      FixedLengthStream: new (length: number) => {
        readable: ReadableStream;
        writable: WritableStream;
      };
    }).FixedLengthStream;
    if (!FixedLength) {
      throw createError({ statusCode: 503, statusMessage: "Retained streaming is unavailable." });
    }
    const reservation = await runtime.service.reserveRetainedPart({
      principalSub: runtime.principalSub,
      mediaId: parseOpaqueResourceId(getRouterParam(event, "id")),
      capability: query.cap,
      partNumber: query.partNumber,
      contentLength,
    });
    const fixed = new FixedLength(contentLength);
    const piping = body.pipeTo(fixed.writable);
    try {
      const [part] = await Promise.all([
        runtime.service.uploadRetainedPart(reservation, fixed.readable),
        piping,
      ]);
      return { partNumber: part.partNumber, etag: part.etag };
    } catch (error) {
      await fixed.readable.cancel().catch(() => undefined);
      await runtime.service.releaseRetainedPart(reservation).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    throwHostedMediaHttpError(error);
  }
});
