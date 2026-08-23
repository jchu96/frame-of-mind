import type { SessionInfo } from "../../shared/types";

function authErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const payload = (error as { data?: unknown }).data;
  if (!payload || typeof payload !== "object") return undefined;
  const direct = (payload as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const nested = (payload as { data?: unknown }).data;
  return nested && typeof nested === "object"
    && typeof (nested as { code?: unknown }).code === "string"
    ? (nested as { code: string }).code
    : undefined;
}

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server || to.path === "/sign-in") return;

  const { data: session, error } = await useFetch<SessionInfo>("/api/session", {
    headers: useRequestHeaders(["cookie"]),
    key: "hosted-auth-navigation-session",
    getCachedData: () => undefined,
  });
  const betterAuthMode = session.value?.authMode === "better-auth"
    || session.value?.authMode === "cloudflare-access+better-auth";
  if (!betterAuthMode && authErrorCode(error.value) !== "better_auth_session_missing") return;
  if (session.value?.principal) return;

  const next = safeHostedNext(to.fullPath);
  return navigateTo({ path: "/sign-in", query: next === "/" ? undefined : { next } });
});
