import {
  createError,
  defineEventHandler,
  getRequestWebStream,
  setCookie,
  setResponseHeader,
} from "h3";
import { z } from "zod";
import {
  LOCAL_STUDIO_CLEAN_PATH,
  LOCAL_STUDIO_COOKIE_NAME,
  getConfiguredLocalStudioSession,
  localStudioCookieOptions,
} from "./session.js";
import {
  readLimitedText,
  RequestBodyTooLargeError,
} from "../../server/utils/request-body.js";
import { assertTrustedJsonMutation } from "../../server/utils/request-security.js";

const bootstrapBodySchema = z.object({
  token: z.string().min(32).max(512),
}).strict();
const maximumBootstrapBytes = 1_024;

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "cache-control", "no-store");
  setResponseHeader(event, "referrer-policy", "no-referrer");
  assertTrustedJsonMutation(event);

  let body: unknown;
  try {
    const rawBody = await readLimitedText(
      getRequestWebStream(event),
      maximumBootstrapBytes,
    );
    body = JSON.parse(rawBody);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw createError({
        statusCode: 413,
        statusMessage: "Bootstrap request is too large.",
      });
    }
    throw createError({
      statusCode: 400,
      statusMessage: "Bootstrap request must be valid JSON.",
    });
  }
  const parsed = bootstrapBodySchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: "A bootstrap capability is required.",
    });
  }

  try {
    const sessionToken = getConfiguredLocalStudioSession()
      .exchangeBootstrap(parsed.data.token);
    setCookie(
      event,
      LOCAL_STUDIO_COOKIE_NAME,
      sessionToken,
      localStudioCookieOptions(),
    );
  } catch {
    throw createError({
      statusCode: 403,
      statusMessage: "Bootstrap capability is invalid or already used.",
    });
  }

  return { redirect: LOCAL_STUDIO_CLEAN_PATH };
});
