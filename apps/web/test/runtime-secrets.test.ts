import { describe, expect, test } from "bun:test";
import { ProcessRuntimeSecretResolver } from "../server-local/studio-configuration/runtime-secrets";

describe("Studio runtime secret resolution", () => {
  test("prefers environment values over process-session values", async () => {
    const resolver = new ProcessRuntimeSecretResolver({
      GEMINI_API_KEY: "environment-gemini-key",
    });
    await resolver.setSession("gemini-api-key", "session-gemini-key");

    expect(await resolver.resolve("gemini-api-key")).toBe(
      "environment-gemini-key",
    );
    expect(await resolver.status("gemini-api-key")).toEqual({
      name: "gemini-api-key",
      present: true,
      source: "environment",
    });
  });

  test("keeps entered keys in process memory and never returns them in status", async () => {
    const resolver = new ProcessRuntimeSecretResolver({});
    const secret = "session-only-granola-key";
    await resolver.setSession("granola-api-key", secret);

    expect(await resolver.resolve("granola-api-key")).toBe(secret);
    const status = await resolver.status("granola-api-key");
    expect(status).toEqual({
      name: "granola-api-key",
      present: true,
      source: "session",
    });
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  test("disconnect clears only the session value", async () => {
    const resolver = new ProcessRuntimeSecretResolver({
      GRANOLA_API_KEY: "persistent-env-key",
    });
    await resolver.setSession("granola-api-key", "temporary-key");
    await resolver.clearSession("granola-api-key");

    expect(await resolver.resolve("granola-api-key")).toBe("persistent-env-key");
    expect((await resolver.status("granola-api-key")).source).toBe("environment");
  });

  test("rejects empty, control-bearing, and oversized secret input", async () => {
    const resolver = new ProcessRuntimeSecretResolver({});
    await expect(
      resolver.setSession("gemini-api-key", ""),
    ).rejects.toThrow(/invalid/i);
    await expect(
      resolver.setSession("gemini-api-key", "line-one\nline-two"),
    ).rejects.toThrow(/invalid/i);
    await expect(
      resolver.setSession("gemini-api-key", "x".repeat(8_193)),
    ).rejects.toThrow(/invalid/i);
  });
});
