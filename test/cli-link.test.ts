import { execFileSync } from "node:child_process";
import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliFixture } from "./helpers/cli-build.js";

describe("linked", () => {
  it("--version through a symlink prints the package version", async () => {
    const root = await buildCliFixture();
    try {
      const link = join(root, "frameofmind");
      await symlink(join(root, "dist", "cli.js"), link);
      const expected = JSON.parse(await readFile("package.json", "utf8")).version;
      expect(execFileSync("node", [link, "--version"], { encoding: "utf8" }).trim()).toBe(expected);
      expect(execFileSync("bun", ["src/cli.ts", "--version"], { encoding: "utf8" }).trim()).toBe(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
