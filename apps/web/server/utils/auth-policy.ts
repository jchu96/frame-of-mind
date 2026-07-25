export type AuthMode = "off" | "cloudflare-access";

export function parseAuthMode(value: unknown): AuthMode {
  if (value === "off" || value === "cloudflare-access") return value;
  throw new Error("NUXT_AUTH_MODE must be 'off' or 'cloudflare-access'.");
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

export function normalizeTeamDomain(value: unknown): string {
  const raw = String(value || "").replace(/\/+$/, "");
  const url = new URL(raw);
  if (
    url.protocol !== "https:"
    || !url.hostname.endsWith(".cloudflareaccess.com")
    || url.pathname !== "/"
  ) {
    throw new Error("Cloudflare Access team domain must be an HTTPS cloudflareaccess.com origin.");
  }
  return url.origin;
}
