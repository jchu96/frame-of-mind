import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileOAuthProvider,
  OAuthCallback,
  configRoot,
  resolveMcpEndpoint,
} from "../src/adapters/bluedot-oauth.js";
import { DEFAULT_BLUEDOT_MCP_URL } from "../src/adapters/bluedot-mcp.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("OAuth credential storage", () => {
  it("clears revoked tokens so the SDK can restart browser authorization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-oauth-"));
    directories.push(directory);
    const path = join(directory, "tokens.json");
    const provider = new FileOAuthProvider("http://127.0.0.1/callback", path, () => {});
    provider.saveTokens({ access_token: "expired", token_type: "Bearer" });
    provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8")).tokens).toBeUndefined();
  });

  it("restores restrictive permissions on an existing token path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-oauth-"));
    directories.push(directory);
    const path = join(directory, "tokens.json");
    await writeFile(path, "{}");
    await chmod(path, 0o644);
    const provider = new FileOAuthProvider("http://127.0.0.1/callback", path, () => {});
    provider.saveTokens({ access_token: "private", token_type: "Bearer" });
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it("isolates custom HTTPS origins from canonical bearer credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-oauth-"));
    directories.push(directory);
    const canonicalPath = join(directory, "bluedot-oauth.json");
    const canonical = resolveMcpEndpoint(
      "bluedot",
      DEFAULT_BLUEDOT_MCP_URL,
      DEFAULT_BLUEDOT_MCP_URL,
      canonicalPath,
    );
    const custom = resolveMcpEndpoint(
      "bluedot",
      "https://mcp.example.test/service",
      DEFAULT_BLUEDOT_MCP_URL,
      canonicalPath,
    );
    expect(custom.tokenPath).not.toBe(canonical.tokenPath);

    const provider = new FileOAuthProvider(
      "http://127.0.0.1/callback",
      canonical.tokenPath,
      () => {},
      "state",
      canonical.url.toString(),
    );
    provider.saveTokens({ access_token: "canonical-secret", token_type: "Bearer" });
    const wrongResource = new FileOAuthProvider(
      "http://127.0.0.1/callback",
      canonical.tokenPath,
      () => {},
      "state",
      custom.url.toString(),
    );
    expect(wrongResource.tokens()).toBeUndefined();
  });

  it("rejects insecure or credential-bearing MCP endpoints", () => {
    expect(() => resolveMcpEndpoint(
      "bluedot",
      "http://mcp.example.test",
      DEFAULT_BLUEDOT_MCP_URL,
      "/tmp/token.json",
    )).toThrow(/HTTPS/);
    expect(() => resolveMcpEndpoint(
      "bluedot",
      "https://user:secret@mcp.example.test",
      DEFAULT_BLUEDOT_MCP_URL,
      "/tmp/token.json",
    )).toThrow(/embedded credentials/);
  });

  it("does not resolve a relative XDG config path against the working directory", () => {
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "relative-config";
    try {
      expect(configRoot()).not.toContain("relative-config");
      expect(configRoot()).toMatch(/\.config$/);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });

  it("ignores unrelated paths and invalid state until the valid callback arrives", async () => {
    const port = await availablePort();
    const callback = new OAuthCallback(port, "Test provider");
    await callback.listen();
    try {
      expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404);
      expect((await fetch(
        `http://127.0.0.1:${port}/callback?code=attacker&state=wrong`,
      )).status).toBe(400);
      expect((await fetch(
        `http://127.0.0.1:${port}/callback?code=legitimate&state=${callback.state}`,
      )).status).toBe(200);
      await expect(callback.code).resolves.toBe("legitimate");
    } finally {
      callback.close();
    }
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
