import {
  createError,
  defineEventHandler,
  getRouterParam,
  setResponseStatus,
} from "h3";
import { z } from "zod";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";
import { getStudioConnectionService } from "./connections.js";

const oauthProviderSchema = z.enum(["bluedot", "granola"]);

export default defineEventHandler((event) => {
  assertTrustedJsonMutation(event);
  const provider = oauthProviderSchema.safeParse(
    getRouterParam(event, "provider"),
  );
  if (!provider.success) {
    throw createError({
      statusCode: 404,
      statusMessage: "OAuth provider is not supported.",
    });
  }
  const started = getStudioConnectionService().startOAuth(provider.data);
  setResponseStatus(event, started ? 202 : 200);
  return { accepted: started, provider: provider.data };
});
