import { defineEventHandler, getQuery, getRouterParam } from "h3";
import { z } from "zod";
import { parseOpaqueResourceId } from "../../../../src/domain/studio-identifiers.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getHostedMediaRuntime, readHostedMediaJson, throwHostedMediaHttpError } from "./http.js";

const querySchema = z.object({
  cap: z.string().length(64).regex(/^[a-f0-9]+$/),
}).passthrough();
const bodySchema = z.object({
  parts: z.array(z.object({
    partNumber: z.number().int().min(1).max(10_000),
    etag: z.string().min(1).max(256),
  }).strict()).min(1).max(10_000),
}).strict();

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  try {
    const runtime = getHostedMediaRuntime(event);
    const query = querySchema.parse(getQuery(event));
    const body = bodySchema.parse(await readHostedMediaJson(event));
    await runtime.service.completeRetainedUpload({
      principalSub: runtime.principalSub,
      mediaId: parseOpaqueResourceId(getRouterParam(event, "id")),
      capability: query.cap,
      parts: body.parts,
    });
    return { ok: true, state: "complete" };
  } catch (error) {
    throwHostedMediaHttpError(error);
  }
});
