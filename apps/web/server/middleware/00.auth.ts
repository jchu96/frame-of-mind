import { getHeader, getRequestIP } from "h3";
import { verifyCloudflareAccessJwt } from "../utils/access";
import {
  isTrustedLoopbackRequest,
  normalizeTeamDomain,
  parseAuthMode,
} from "../utils/auth-policy";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  let mode;
  try {
    mode = parseAuthMode(config.authMode);
  } catch {
    throw createError({ statusCode: 503, statusMessage: "Authentication is misconfigured." });
  }

  event.context.frameOfMindUser = { authMode: mode };
  if (mode === "off") {
    const remoteAllowed = config.allowUnauthenticatedRemote === true
      || config.allowUnauthenticatedRemote === "true";
    const loopbackRequest = isTrustedLoopbackRequest(
      getHeader(event, "host"),
      getRequestIP(event, { xForwardedFor: false }),
      process.env.NITRO_HOST || process.env.HOST,
    );
    if (!remoteAllowed && !loopbackRequest) {
      throw createError({
        statusCode: 403,
        statusMessage: "Unauthenticated mode is restricted to localhost.",
      });
    }
    return;
  }

  const token = getHeader(event, "cf-access-jwt-assertion");
  const audience = String(config.cloudflareAccessAud || "");
  if (!token || !audience) {
    throw createError({ statusCode: 403, statusMessage: "Cloudflare Access is required." });
  }

  try {
    const teamDomain = normalizeTeamDomain(config.cloudflareAccessTeamDomain);
    const identity = await verifyCloudflareAccessJwt(token, teamDomain, audience);
    event.context.frameOfMindUser = {
      authMode: mode,
      ...(identity.email ? { email: identity.email } : {}),
    };
  } catch {
    throw createError({ statusCode: 403, statusMessage: "Cloudflare Access token is invalid." });
  }
});
