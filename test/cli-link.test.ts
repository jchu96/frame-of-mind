import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCliFixture } from "./helpers/cli-build.js";

describe("linked", () => {
  let root: string | undefined;
  let link: string;
  let globalBin: string;
  let expected: string;
  // Compilation has a separate 60-second setup budget on shared machines.
  // The runtime assertions retain Vitest's default five-second test timeout.
  beforeAll(async () => {
    root = await buildCliFixture();
    link = join(root, "frameofmind");
    await symlink(join(root, "dist", "cli.js"), link);
    // The layout `bun link` makes: a relative bin link into a global package
    // directory that is itself a link to the checkout.
    await mkdir(join(root, "global", "bin"), { recursive: true });
    await mkdir(join(root, "global", "install", "node_modules"), { recursive: true });
    await symlink(root, join(root, "global", "install", "node_modules", "frameofmind"));
    globalBin = join(root, "global", "bin", "frameofmind");
    await symlink("../install/node_modules/frameofmind/dist/cli.js", globalBin);
    await chmod(join(root, "dist", "cli.js"), 0o755);
    expected = JSON.parse(await readFile("package.json", "utf8")).version;
  }, 60_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("--version through a symlink prints the package version", () => {
    expect(execFileSync("node", [link, "--version"], { encoding: "utf8" }).trim()).toBe(expected);
    expect(execFileSync("bun", ["src/cli.ts", "--version"], { encoding: "utf8" }).trim()).toBe(expected);
  });

  it.each([
    ["node", ["node"]],
    ["bun", ["bun"]],
    ["its shebang", []],
  ])("--help through the bun-link symlink layout prints usage under %s", (_runner, prefix) => {
    const [command, ...args] = [...prefix, globalBin, "--help"];
    const result = spawnSync(command!, args, { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage: frameofmind /);
  });

  it("a launcher that imports the built CLI still runs it instead of exiting silently", async () => {
    const launcher = join(root!, "launcher.mjs");
    await writeFile(launcher, `await import(${JSON.stringify(pathToFileURL(join(root!, "dist", "cli.js")).href)});\n`);
    const result = spawnSync("node", [launcher, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage: frameofmind /);
  });
});
