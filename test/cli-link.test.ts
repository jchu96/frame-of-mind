import { execFileSync } from "node:child_process";
import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCliFixture } from "./helpers/cli-build.js";

describe("linked", () => {
  let root: string | undefined;
  let link: string;
  let expected: string;
  // Compilation has a separate 60-second setup budget on shared machines.
  // The runtime assertions retain Vitest's default five-second test timeout.
  beforeAll(async () => {
    root = await buildCliFixture();
    link = join(root, "frameofmind");
    await symlink(join(root, "dist", "cli.js"), link);
    expected = JSON.parse(await readFile("package.json", "utf8")).version;
  }, 60_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("--version through a symlink prints the package version", () => {
    expect(execFileSync("node", [link, "--version"], { encoding: "utf8" }).trim()).toBe(expected);
    expect(execFileSync("bun", ["src/cli.ts", "--version"], { encoding: "utf8" }).trim()).toBe(expected);
  });
});
