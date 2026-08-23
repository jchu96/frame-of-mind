// Seeds the client with whether the Better Auth session guard applies, so the
// global route middleware can fail closed even when /api/session is unreachable.
// The auth mode is private runtime config; only this boolean reaches the page.
export default defineNuxtPlugin((nuxtApp) => {
  const mode = String(useRuntimeConfig().authMode ?? "off");
  nuxtApp.payload.hostedAuthGuard = mode === "better-auth" || mode === "cloudflare-access+better-auth";
});
