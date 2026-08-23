import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const keySets = new Map<string, JWTVerifyGetKey>();

export interface CloudflareAccessIdentity {
  sub: string;
  email?: string;
  principal: string;
}

function boundedClaim(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) return undefined;
  if (value.trim() !== value) return undefined;
  return value;
}

export async function verifyCloudflareAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<CloudflareAccessIdentity> {
  let keySet = keySets.get(teamDomain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keySet);
  }
  const { payload } = await jwtVerify(token, keySet, {
    issuer: teamDomain,
    audience,
    algorithms: ["RS256"],
  });
  if (typeof payload.sub !== "string") {
    throw new Error("Cloudflare Access subject is missing.");
  }
  const email = boundedClaim(payload.email);
  if (payload.sub === "") {
    const commonName = boundedClaim(payload.common_name);
    if (!commonName) throw new Error("Cloudflare Access service identity is invalid.");
    return {
      sub: "",
      principal: `service:${commonName}`,
      ...(email ? { email } : {}),
    };
  }
  const sub = boundedClaim(payload.sub);
  if (
    !sub
    || sub === "__legacy_unclaimed__"
    || sub.startsWith("service:")
    || sub.startsWith("local:")
    || sub.startsWith("ba:")
  ) {
    throw new Error("Cloudflare Access user subject is invalid.");
  }
  return {
    sub,
    principal: sub,
    ...(email ? { email } : {}),
  };
}
