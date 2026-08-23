import { toWebRequest } from "h3";
import { runWithRequestState } from "@better-auth/core/context";
import { createBetterAuth } from "../../utils/better-auth";
import { parseAuthMode, usesBetterAuth } from "../../utils/auth-policy";

export default defineEventHandler((event) => {
  const mode = parseAuthMode(useRuntimeConfig(event).authMode);
  if (!usesBetterAuth(mode)) {
    throw createError({ statusCode: 404, statusMessage: "Not found." });
  }
  return runWithRequestState(
    new WeakMap(),
    () => createBetterAuth(event).handler(toWebRequest(event)),
  );
});
