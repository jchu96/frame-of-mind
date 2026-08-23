import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { BETTER_AUTH_IP_ADDRESS_OPTIONS } from "../server/utils/better-auth-ip";

function createRateLimitFixture() {
  return betterAuth({
    baseURL: "http://127.0.0.1:3000",
    secret: "fixture-only-secret-with-at-least-thirty-two-characters",
    database: memoryAdapter({}),
    logger: { disabled: true },
    rateLimit: {
      enabled: true,
      storage: "memory",
      customRules: { "/get-session": { window: 900, max: 3 } },
    },
    advanced: { ipAddress: BETTER_AUTH_IP_ADDRESS_OPTIONS },
  });
}

function requestSession(
  auth: ReturnType<typeof createRateLimitFixture>,
  clientIp?: string,
): Promise<Response> {
  return auth.handler(new Request("http://127.0.0.1:3000/api/auth/get-session", {
    headers: clientIp ? { "cf-connecting-ip": clientIp } : undefined,
  }));
}

describe("Better Auth client-IP rate limiting", () => {
  test("uses separate Cloudflare client buckets and retains a shared no-IP fallback", async () => {
    const auth = createRateLimitFixture();
    const ipA = "192.0.2.41";
    const ipB = "198.51.100.42";

    expect(BETTER_AUTH_IP_ADDRESS_OPTIONS.ipAddressHeaders).toEqual([
      "cf-connecting-ip",
      "x-forwarded-for",
    ]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await requestSession(auth, ipA)).status).toBe(200);
    }
    expect((await requestSession(auth, ipB)).status).toBe(200);
    expect((await requestSession(auth, ipA)).status).toBe(429);
    expect((await requestSession(auth, ipB)).status).toBe(200);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await requestSession(auth)).status).toBe(200);
    }
    expect((await requestSession(auth)).status).toBe(429);
  });
});
