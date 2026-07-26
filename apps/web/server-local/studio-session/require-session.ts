import {
  createError,
  defineEventHandler,
  getCookie,
  setResponseHeader,
} from "h3";
import {
  LOCAL_STUDIO_COOKIE_NAME,
  getConfiguredLocalStudioSession,
  requiresLocalStudioSession,
} from "./session.js";

export default defineEventHandler((event) => {
  if (!requiresLocalStudioSession(event.path)) return;

  let authorized = false;
  try {
    authorized = getConfiguredLocalStudioSession().isAuthorized(
      getCookie(event, LOCAL_STUDIO_COOKIE_NAME),
    );
  } catch {
    throw createError({
      statusCode: 503,
      statusMessage: "Local Studio session is not configured.",
    });
  }
  if (!authorized) {
    throw createError({
      statusCode: 401,
      statusMessage: "Local Studio session is required.",
    });
  }
  setResponseHeader(event, "cache-control", "no-store");
});
