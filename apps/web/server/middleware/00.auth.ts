import { getHeader, getRequestIP, type H3Event } from "h3";
import { verifyCloudflareAccessJwt } from "../utils/access";
import {
  isTrustedLoopbackRequest,
  normalizeTeamDomain,
  parseAuthMode,
  usesBetterAuth,
  usesCloudflareAccess,
} from "../utils/auth-policy";
import { principalFromBetterAuthSession } from "../utils/better-auth";
import { getHostedRouteTelemetry } from "#frame-hosted-telemetry";

export default defineEventHandler(async (event) => {
  const path = event.path.split("?", 1)[0] || "";
  const hostedRoute = path === "/api/hosted"
    || path.startsWith("/api/hosted/")
    || path === "/hosted"
    || path.startsWith("/hosted/");
  const authRoute = path === "/api/auth" || path.startsWith("/api/auth/");
  const hostedTelemetry = hostedRoute ? getHostedRouteTelemetry(event) : undefined;
  const config = useRuntimeConfig(event);
  let mode;
  try {
    mode = parseAuthMode(config.authMode);
  } catch {
    const failClosedHosted = hostedRoute || config.hostedWorkflowsEnabled === true;
    await hostedTelemetry?.emit({
      area: "access",
      outcome: "failed",
      code: "access_configuration_unavailable",
      routeClass: "hosted_api",
      status: failClosedHosted ? 403 : 503,
      studioMode: "hosted",
    });
    throw createError({
      statusCode: failClosedHosted ? 403 : 503,
      statusMessage: "Authentication is misconfigured.",
    });
  }

  event.context.frameOfMindUser = { authMode: mode };
  if (mode === "off") {
    if (hostedRoute && config.hostedWorkflowsEnabled === true) {
      throw createError({ statusCode: 403, statusMessage: "Hosted authentication is required." });
    }
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

  if (usesCloudflareAccess(mode)) {
    const identity = await authenticateCloudflareAccess(event, hostedTelemetry);
    event.context.frameOfMindAccessIdentity = {
      sub: identity.sub,
      ...(identity.email ? { email: identity.email } : {}),
    };
    if (mode === "cloudflare-access") {
      event.context.frameOfMindPrincipal = {
        principal: identity.principal,
        ...(identity.email ? { email: identity.email } : {}),
      };
      event.context.frameOfMindUser = {
        authMode: mode,
        ...(identity.email ? { email: identity.email } : {}),
      };
      await denyServiceBrowserPrincipal(identity.principal, path, hostedTelemetry);
      await emitAccessSuccess(hostedTelemetry);
      return;
    }
    if (identity.principal.startsWith("service:")) {
      throw createError({
        statusCode: 403,
        statusMessage: "A user Access identity is required.",
        data: { code: "access_user_principal_required" },
      });
    }
    await emitAccessSuccess(hostedTelemetry);
  }

  if (!usesBetterAuth(mode)) return;
  if (authRoute) return;
  const identity = await principalFromBetterAuthSession(event);
  if (!identity) {
    await hostedTelemetry?.emit({
      area: "access",
      outcome: "failed",
      code: "better_auth_session_missing",
      routeClass: "hosted_api",
      status: 403,
      studioMode: "hosted",
    });
    throw createError({ statusCode: 403, statusMessage: "A Better Auth session is required." });
  }
  event.context.frameOfMindPrincipal = identity;
  event.context.frameOfMindUser = { authMode: mode, email: identity.email };
  await hostedTelemetry?.emit({
    area: "access",
    outcome: "succeeded",
    code: "better_auth_session_valid",
    routeClass: "hosted_api",
    status: 200,
    studioMode: "hosted",
  });
});

async function authenticateCloudflareAccess(
  event: H3Event,
  hostedTelemetry: ReturnType<typeof getHostedRouteTelemetry> | undefined,
) {
  const config = useRuntimeConfig(event);
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
    return await verifyCloudflareAccessJwt(token, teamDomain, audience);
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
}

async function denyServiceBrowserPrincipal(
  principal: string,
  path: string,
  hostedTelemetry: ReturnType<typeof getHostedRouteTelemetry> | undefined,
): Promise<void> {
  if (
    !principal.startsWith("service:")
    || !(
      path === "/api/runs"
      || path.startsWith("/api/runs/")
      || path === "/api/hosted"
      || path.startsWith("/api/hosted/")
    )
  ) return;
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

async function emitAccessSuccess(
  hostedTelemetry: ReturnType<typeof getHostedRouteTelemetry> | undefined,
): Promise<void> {
  await hostedTelemetry?.emit({
    area: "access",
    outcome: "succeeded",
    code: "access_assertion_valid",
    routeClass: "hosted_api",
    status: 200,
    studioMode: "hosted",
  });
}
