import { describe, expect, test } from "bun:test";
import {
  isLoopbackHost,
  isLoopbackAddress,
  normalizeTeamDomain,
  parseAuthMode,
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

  test("accepts only explicit auth modes", () => {
    expect(parseAuthMode("cloudflare-access")).toBe("cloudflare-access");
    expect(() => parseAuthMode("maybe")).toThrow();
  });

  test("accepts only Cloudflare Access team origins", () => {
    expect(normalizeTeamDomain("https://team.cloudflareaccess.com/"))
      .toBe("https://team.cloudflareaccess.com");
    expect(() => normalizeTeamDomain("https://example.com")).toThrow();
  });
});
