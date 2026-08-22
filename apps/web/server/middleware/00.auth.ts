import { getHeader, getRequestIP } from "h3";
import { verifyCloudflareAccessJwt } from "../utils/access";
import {
  isTrustedLoopbackRequest,
  normalizeTeamDomain,
  parseAuthMode,
} from "../utils/auth-policy";
import { getHostedRouteTelemetry } from "#frame-hosted-telemetry";

export default defineEventHandler(async (event) => {
  const path = event.path.split("?", 1)[0] || "";
  const hostedTelemetry = path === "/api/hosted" || path.startsWith("/api/hosted/")
    ? getHostedRouteTelemetry(event)
    : undefined;
  const config = useRuntimeConfig(event);
  let mode;
  let identity: Awaited<ReturnType<typeof verifyCloudflareAccessJwt>>;
  try {
    mode = parseAuthMode(config.authMode);
  } catch {
    await hostedTelemetry?.emit({
      area: "access",
      outcome: "failed",
      code: "access_configuration_unavailable",
      routeClass: "hosted_api",
      status: 503,
      studioMode: "hosted",
    });
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
    await hostedTelemetry?.emit({
      area: "access",
      outcome: "failed",
      code: "access_assertion_missing",
      routeClass: "hosted_api",
      status: 403,
      studioMode: "hosted",
    });
    throw createError({ statusCode: 403, statusMessage: "Cloudflare Access is required." });
  }

  try {
    const allowInsecureFixture = config.cloudflareAccessAllowInsecureTestJwks === true
      || config.cloudflareAccessAllowInsecureTestJwks === "true";
    const teamDomain = normalizeTeamDomain(
      config.cloudflareAccessTeamDomain,
      allowInsecureFixture,
    );
    identity = await verifyCloudflareAccessJwt(token, teamDomain, audience);
  } catch {
    await hostedTelemetry?.emit({
      area: "access",
      outcome: "failed",
      code: "access_assertion_invalid",
      routeClass: "hosted_api",
      status: 403,
      studioMode: "hosted",
    });
    throw createError({ statusCode: 403, statusMessage: "Cloudflare Access token is invalid." });
  }
  event.context.frameOfMindPrincipal = {
    principal: identity.principal,
    ...(identity.email ? { email: identity.email } : {}),
  };
  event.context.frameOfMindUser = {
    authMode: mode,
    ...(identity.email ? { email: identity.email } : {}),
  };
  if (
    identity.principal.startsWith("service:")
    && (
      path === "/api/runs"
      || path.startsWith("/api/runs/")
      || path === "/api/hosted"
      || path.startsWith("/api/hosted/")
    )
  ) {
    await hostedTelemetry?.emit({
      area: "access",
      outcome: "failed",
      code: "access_service_principal_denied",
      routeClass: "hosted_api",
      status: 403,
      studioMode: "hosted",
    });
    throw createError({
      statusCode: 403,
      statusMessage: "Service principals cannot use browser run routes.",
      data: { code: "service_principal_browser_route_denied" },
    });
  }
  await hostedTelemetry?.emit({
    area: "access",
    outcome: "succeeded",
    code: "access_assertion_valid",
    routeClass: "hosted_api",
    status: 200,
    studioMode: "hosted",
  });
});
