import { describe, expect, test } from "bun:test";
import {
  isLoopbackAddress,
  isLoopbackHost,
  isTrustedLoopbackRequest,
  normalizeTeamDomain,
  parseAuthMode,
  usesBetterAuth,
  usesCloudflareAccess,
} from "../server/utils/auth-policy";

describe("authentication policy", () => {
  test("allows unauthenticated mode only on loopback by default", () => {
    expect(isLoopbackHost("127.0.0.1:3000")).toBe(true);
    expect(isLoopbackHost("localhost:3000")).toBe(true);
    expect(isLoopbackHost("[::1]:3000")).toBe(true);
    expect(isLoopbackHost("review.example.com")).toBe(false);
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.0.2.4")).toBe(false);
  });

  test("falls back to an explicit loopback listener when Bun omits the peer address", () => {
    expect(isTrustedLoopbackRequest(
      "127.0.0.1:3000",
      undefined,
      "127.0.0.1",
    )).toBe(true);
    expect(isTrustedLoopbackRequest(
      "127.0.0.1:3000",
      undefined,
      "0.0.0.0",
    )).toBe(false);
    expect(isTrustedLoopbackRequest(
      "attacker.example",
      undefined,
      "127.0.0.1",
    )).toBe(false);
  });

  test("accepts only explicit auth modes", () => {
    expect(parseAuthMode("off")).toBe("off");
    expect(parseAuthMode("cloudflare-access")).toBe("cloudflare-access");
    expect(parseAuthMode("better-auth")).toBe("better-auth");
    expect(parseAuthMode("cloudflare-access+better-auth"))
      .toBe("cloudflare-access+better-auth");
    expect(() => parseAuthMode("maybe")).toThrow();
  });

  test("composes the inner and outer auth boundaries explicitly", () => {
    expect(usesCloudflareAccess("cloudflare-access")).toBe(true);
    expect(usesCloudflareAccess("cloudflare-access+better-auth")).toBe(true);
    expect(usesCloudflareAccess("better-auth")).toBe(false);
    expect(usesBetterAuth("better-auth")).toBe(true);
    expect(usesBetterAuth("cloudflare-access+better-auth")).toBe(true);
    expect(usesBetterAuth("cloudflare-access")).toBe(false);
  });

  test("accepts only Cloudflare Access team origins", () => {
    expect(normalizeTeamDomain("https://team.cloudflareaccess.com/"))
      .toBe("https://team.cloudflareaccess.com");
    expect(() => normalizeTeamDomain("https://example.com")).toThrow();
  });
});
