import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileOAuthProvider } from "../src/adapters/bluedot-oauth.js";

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
});
