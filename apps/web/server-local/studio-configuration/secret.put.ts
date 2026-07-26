import {
  createError,
  defineEventHandler,
  getRequestWebStream,
  getRouterParam,
} from "h3";
import { z } from "zod";
import type { RuntimeSecretName } from "../../../../src/domain/studio-ports.js";
import {
  readLimitedText,
  RequestBodyTooLargeError,
} from "../../server/utils/request-body.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getStudioConnectionService } from "./connections.js";

const secretNameSchema = z.enum(["gemini-api-key", "granola-api-key"]);
const secretBodySchema = z.object({
  value: z.string().min(8).max(8_192),
}).strict();
const maximumSecretRequestBytes = 10 * 1_024;

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  const name = secretNameSchema.safeParse(getRouterParam(event, "name"));
  if (!name.success) {
    throw createError({
      statusCode: 404,
      statusMessage: "Runtime secret is not supported.",
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(await readLimitedText(
      getRequestWebStream(event),
      maximumSecretRequestBytes,
    ));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw createError({
        statusCode: 413,
        statusMessage: "Runtime secret request is too large.",
      });
    }
    throw createError({
      statusCode: 400,
      statusMessage: "Runtime secret request must be valid JSON.",
    });
  }
  const parsed = secretBodySchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: "Runtime secret value is invalid.",
    });
  }
  try {
    return await getStudioConnectionService().setSessionSecret(
      name.data as RuntimeSecretName,
      parsed.data.value,
    );
  } catch {
    throw createError({
      statusCode: 422,
      statusMessage: "Runtime secret value is invalid.",
    });
  }
});
