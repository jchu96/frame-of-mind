import {
  createError,
  defineEventHandler,
  getRouterParam,
} from "h3";
import { z } from "zod";
import type { RuntimeSecretName } from "../../../../src/domain/studio-ports.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getStudioConnectionService } from "./connections.js";

const secretNameSchema = z.enum(["gemini-api-key", "granola-api-key"]);

export default defineEventHandler(async (event) => {
  assertTrustedJsonMutation(event);
  const name = secretNameSchema.safeParse(getRouterParam(event, "name"));
  if (!name.success) {
    throw createError({
      statusCode: 404,
      statusMessage: "Runtime secret is not supported.",
    });
  }
  return getStudioConnectionService().clearSessionSecret(
    name.data as RuntimeSecretName,
  );
});
