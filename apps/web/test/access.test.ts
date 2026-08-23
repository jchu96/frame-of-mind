import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { verifyCloudflareAccessJwt } from "../server/utils/access";
import { normalizeTeamDomain } from "../server/utils/auth-policy";

const audience = "frame-of-mind-access-test";
const keyId = "frame-of-mind-test-key";
let privateKey: KeyLike;
let issuer = "";
let jwksServer: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  jwksServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/cdn-cgi/access/certs") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({ keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }] });
    },
  });
  issuer = `http://127.0.0.1:${jwksServer.port}`;
});

afterAll(() => jwksServer.stop(true));

async function token(
  claims: Record<string, unknown>,
  options: { issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}

describe("Cloudflare Access principal identity", () => {
  test("derives a user principal from sub and keeps email display-only", async () => {
    await expect(verifyCloudflareAccessJwt(
      await token({ sub: "user-subject-1", email: "person@example.test" }),
      issuer,
      audience,
    )).resolves.toEqual({
      sub: "user-subject-1",
      email: "person@example.test",
      principal: "user-subject-1",
    });
  });

  test("derives an empty-sub service principal from common_name", async () => {
    await expect(verifyCloudflareAccessJwt(
      await token({ sub: "", common_name: "fixture.access" }),
      issuer,
      audience,
    )).resolves.toEqual({
      sub: "",
      principal: "service:fixture.access",
    });
  });

  test("rejects malformed, wrong-audience, wrong-issuer, and expired assertions", async () => {
    await expect(verifyCloudflareAccessJwt("not-a-jwt", issuer, audience)).rejects.toThrow();
    await expect(verifyCloudflareAccessJwt(
      await token({ sub: "user-subject-1" }, { audience: "wrong-audience" }),
      issuer,
      audience,
    )).rejects.toThrow();
    await expect(verifyCloudflareAccessJwt(
      await token({ sub: "user-subject-1" }, { issuer: `${issuer}/wrong` }),
      issuer,
      audience,
    )).rejects.toThrow();
    await expect(verifyCloudflareAccessJwt(
      await token({ sub: "user-subject-1" }, { expiresIn: "-1s" }),
      issuer,
      audience,
    )).rejects.toThrow();
  });

  test("rejects empty users, malformed services, and reserved principal namespaces", async () => {
    await expect(verifyCloudflareAccessJwt(
      await token({ sub: "" }),
      issuer,
      audience,
    )).rejects.toThrow(/service identity/);
    for (const sub of ["service:forged", "local:single-user", "ba:forged", "__legacy_unclaimed__"]) {
      await expect(verifyCloudflareAccessJwt(
        await token({ sub, email: "same@example.test" }),
        issuer,
        audience,
      )).rejects.toThrow(/user subject/);
    }
  });

  test("allows an insecure JWKS origin only for an explicit loopback fixture", () => {
    expect(() => normalizeTeamDomain(issuer)).toThrow(/HTTPS/);
    expect(normalizeTeamDomain(issuer, true)).toBe(issuer);
    expect(() => normalizeTeamDomain("http://example.test", true)).toThrow(/HTTPS/);
  });
});
