export type AuthMode =
  | "off"
  | "cloudflare-access"
  | "better-auth"
  | "cloudflare-access+better-auth";

export function usesCloudflareAccess(mode: AuthMode): boolean {
  return mode === "cloudflare-access" || mode === "cloudflare-access+better-auth";
}

export function usesBetterAuth(mode: AuthMode): boolean {
  return mode === "better-auth" || mode === "cloudflare-access+better-auth";
}

export function isBetterAuthPublicPath(path: string): boolean {
  // Exact files and approved framework-asset prefixes; anything that could
  // walk out of an asset tree (".." or an encoded slash) is not public.
  if (path.includes("..") || /%2f/i.test(path) || path.includes("\\")) return false;
  return path === "/sign-in"
    || path === "/api/auth"
    || path.startsWith("/api/auth/")
    || path.startsWith("/_nuxt/")
    || path.startsWith("/api/_nuxt_icon/")
    || path === "/favicon.ico"
    || path === "/favicon.svg"
    || path === "/robots.txt"
    || path === "/__nuxt_error";
}

export function isBetterAuthLimitedSessionPath(path: string): boolean {
  return path === "/api/session"
    || path === "/request-access"
    || path === "/api/access/request";
}

export function parseAuthMode(value: unknown): AuthMode {
  if (
    value === "off"
    || value === "cloudflare-access"
    || value === "better-auth"
    || value === "cloudflare-access+better-auth"
  ) return value;
  throw new Error(
    "NUXT_AUTH_MODE must be 'off', 'cloudflare-access', 'better-auth', or "
    + "'cloudflare-access+better-auth'.",
  );
}

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function isTrustedLoopbackRequest(
  hostHeader: string | undefined,
  peerAddress: string | undefined,
  listenerHost: string | undefined,
): boolean {
  if (!isLoopbackHost(hostHeader)) return false;
  if (peerAddress) return isLoopbackAddress(peerAddress);
  return isLoopbackHost(listenerHost);
}

export function normalizeTeamDomain(
  value: unknown,
  allowInsecureLoopback = false,
): string {
  const raw = String(value || "").replace(/\/+$/, "");
  const url = new URL(raw);
  const loopbackFixture = allowInsecureLoopback
    && url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "::1")
    && url.pathname === "/";
  if (
    !loopbackFixture
    && (
      url.protocol !== "https:"
      || !url.hostname.endsWith(".cloudflareaccess.com")
      || url.pathname !== "/"
    )
  ) {
    throw new Error("Cloudflare Access team domain must be an HTTPS cloudflareaccess.com origin.");
  }
  return url.origin;
}
