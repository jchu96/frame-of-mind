import { describe, expect, test } from "bun:test";
import { StudioConnectionService } from "../server-local/studio-configuration/connections";
import { ProcessRuntimeSecretResolver } from "../server-local/studio-configuration/runtime-secrets";

describe("Studio connection status", () => {
  test("reports provenance and lifetime without returning credential values", async () => {
    const geminiSecret = "environment-gemini-secret";
    const granolaSecret = "session-granola-secret";
    const secrets = new ProcessRuntimeSecretResolver({
      GEMINI_API_KEY: geminiSecret,
    });
    await secrets.setSession("granola-api-key", granolaSecret);
    const service = new StudioConnectionService(
      secrets,
      (provider) => provider === "bluedot",
    );

    const status = await service.status();
    expect(status.providers).toEqual([
      {
        provider: "gemini",
        connected: true,
        source: "environment",
        lifetime: "process",
      },
      {
        provider: "bluedot",
        connected: true,
        source: "oauth",
        lifetime: "persistent-oauth",
      },
      {
        provider: "granola",
        connected: true,
        source: "session",
        lifetime: "process",
      },
    ]);
    expect(JSON.stringify(status)).not.toContain(geminiSecret);
    expect(JSON.stringify(status)).not.toContain(granolaSecret);
  });

  test("deduplicates in-flight OAuth initiation", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const service = new StudioConnectionService(
      new ProcessRuntimeSecretResolver({}),
      () => false,
      () => pending,
    );

    expect(service.startOAuth("bluedot")).toBe(true);
    expect(service.startOAuth("bluedot")).toBe(false);
    finish?.();
    await pending;
    await Bun.sleep(0);
    expect(service.startOAuth("bluedot")).toBe(true);
  });
});
