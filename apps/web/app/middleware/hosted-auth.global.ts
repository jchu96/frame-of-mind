import type { SessionInfo } from "../../shared/types";

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server || to.path === "/sign-in") return;
  // Only Better Auth modes own a client-side guard; local Studio and
  // Access-only deployments never redirect here.
  if (useNuxtApp().payload.hostedAuthGuard !== true) return;

  const { data: session } = await useFetch<SessionInfo>("/api/session", {
    headers: useRequestHeaders(["cookie"]),
    key: "hosted-auth-navigation-session",
    getCachedData: () => undefined,
  });
  // A readable session with a principal is the only thing that lets a
  // navigation through. Any error — including a network failure or a 500 from
  // /api/session — fails closed to the sign-in page (review: the guard must
  // never fail open). Access-only deployments still answer 200 + principal, so
  // they are unaffected.
  if (session.value?.principal && session.value.accessState === "approved") return;
  if (session.value?.principal) {
    if (to.path === "/request-access") return;
    return navigateTo("/request-access");
  }
  // No principal (error, 403, empty) → sign in.

  const next = safeHostedNext(to.fullPath);
  return navigateTo({ path: "/sign-in", query: next === "/" ? undefined : { next } });
});
