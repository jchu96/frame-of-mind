import { describe, expect, test } from "bun:test";
import {
  isBetterAuthPublicPath,
  isLoopbackAddress,
  isLoopbackHost,
  isTrustedLoopbackRequest,
  normalizeTeamDomain,
  parseAuthMode,
  usesBetterAuth,
  usesCloudflareAccess,
} from "../server/utils/auth-policy";
import { safeHostedNext } from "../shared/utils/hosted-auth";

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

  test("limits the Better Auth public surface to sign-in and framework assets", () => {
    for (const path of [
      "/sign-in",
      "/api/auth/sign-in/social",
      "/_nuxt/app.js",
      "/favicon.svg",
      "/favicon.ico",
      "/robots.txt",
      "/__nuxt_error",
    ]) expect(isBetterAuthPublicPath(path)).toBe(true);

    for (const path of [
      "/",
      "/sign-in/extra",
      "/favicon/extra",
      "/api/session",
      "/api/runs",
      "/hosted/activity",
    ]) expect(isBetterAuthPublicPath(path)).toBe(false);
  });

  test("accepts only same-origin relative hosted return paths", () => {
    expect(safeHostedNext("/runs/abc")).toBe("/runs/abc");
    expect(safeHostedNext("/runs/abc?tab=details#finding-1"))
      .toBe("/runs/abc?tab=details#finding-1");
    expect(safeHostedNext(["/hosted/activity", "/ignored"])).toBe("/hosted/activity");
    for (const value of [
      undefined,
      "",
      "runs/abc",
      "https://evil.example",
      "/https://evil.example",
      "//evil.example/path",
      "/\\evil.example/path",
      "/runs/abc\nSet-Cookie: bad",
    ]) expect(safeHostedNext(value)).toBe("/");
  });

  test("accepts only Cloudflare Access team origins", () => {
    const teamDomain = ["team", "cloudflareaccess", "com"].join(".");
    expect(normalizeTeamDomain(`https://${teamDomain}/`))
      .toBe(`https://${teamDomain}`);
    expect(() => normalizeTeamDomain("https://example.com")).toThrow();
  });
});

test("Better Auth public paths are exact and reject traversal", () => {
  for (const path of ["/favicons", "/favicon", "/_nuxt", "/_nuxt/..%2fapi/hosted/jobs", "/_nuxt/../api/hosted/jobs", "/sign-in/", "/Sign-In"]) {
    expect(isBetterAuthPublicPath(path)).toBe(false);
  }
  for (const path of ["/favicon.ico", "/favicon.svg", "/_nuxt/entry.js", "/sign-in"]) {
    expect(isBetterAuthPublicPath(path)).toBe(true);
  }
});
