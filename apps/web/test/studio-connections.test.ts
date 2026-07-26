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

  test("reports a sanitized provider failure when stored OAuth status cannot be read", async () => {
    const service = new StudioConnectionService(
      new ProcessRuntimeSecretResolver({}),
      () => {
        throw new Error("sensitive endpoint failure");
      },
    );

    const status = await service.status();
    expect(status.providers).toEqual([
      {
        provider: "gemini",
        connected: false,
        source: "none",
        lifetime: "none",
      },
      {
        provider: "bluedot",
        connected: false,
        source: "none",
        lifetime: "none",
        failureCode: "oauth_status_failed",
      },
      {
        provider: "granola",
        connected: false,
        source: "none",
        lifetime: "none",
        failureCode: "oauth_status_failed",
      },
    ]);
    expect(JSON.stringify(status)).not.toContain("sensitive endpoint failure");
  });

  test("does not attach Granola OAuth metadata to an active API-key transport", async () => {
    const secrets = new ProcessRuntimeSecretResolver({});
    const service = new StudioConnectionService(
      secrets,
      () => true,
      async () => {},
    );

    expect(service.startOAuth("granola")).toBe(true);
    await Bun.sleep(0);
    await secrets.setSession("granola-api-key", "session-granola-secret");

    const granola = (await service.status()).providers.find(
      (provider) => provider.provider === "granola",
    );
    expect(granola).toEqual({
      provider: "granola",
      connected: true,
      source: "session",
      lifetime: "process",
    });
  });

  test("clears a transient OAuth status failure after a successful read", async () => {
    let shouldFail = true;
    const service = new StudioConnectionService(
      new ProcessRuntimeSecretResolver({}),
      () => {
        if (shouldFail) throw new Error("temporary status failure");
        return true;
      },
    );

    expect(
      (await service.status()).providers.find(
        (provider) => provider.provider === "bluedot",
      )?.failureCode,
    ).toBe("oauth_status_failed");
    shouldFail = false;
    expect(
      (await service.status()).providers.find(
        (provider) => provider.provider === "bluedot",
      ),
    ).toEqual({
      provider: "bluedot",
      connected: true,
      source: "oauth",
      lifetime: "persistent-oauth",
    });
  });
});
