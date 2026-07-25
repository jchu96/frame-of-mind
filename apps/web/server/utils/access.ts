import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const keySets = new Map<string, JWTVerifyGetKey>();

export async function verifyCloudflareAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<{ email?: string }> {
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
  return typeof payload.email === "string" ? { email: payload.email } : {};
}
