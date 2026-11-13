import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

it("release versions match the newest changelog section", () => {
  const newestRelease = read("CHANGELOG.md").match(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m);
  expect(newestRelease, "newest numbered changelog section must exist").not.toBeNull();
  const version = newestRelease![1];
  expect(JSON.parse(read("package.json")).version).toBe(version);
  expect(JSON.parse(read("apps/web/package.json")).version).toBe(version);
  const documented = read("docs/VERSIONING.md").match(/^\| CLI\/package \| `([^`]+)` \|/m);
  expect(documented, "CLI/package version row must exist").not.toBeNull();
  expect(documented![1]).toBe(version);
  const runbook = read("docs/RUNBOOK.md");
  const current = runbook.match(/^\| Current version\s*\| `([^`]+)`/m);
  expect(current, "RUNBOOK current-version row must exist").not.toBeNull();
  expect(current![1], "RUNBOOK current version").toBe(version);
  const expected = runbook.match(/Expected version:\s*```text\r?\n([^\r\n]+)\r?\n```/);
  expect(expected, "RUNBOOK installation expected version must exist").not.toBeNull();
  expect(expected![1], "RUNBOOK installation expected version").toBe(version);
});

it("the CLI --version equals package.json after a version bump fixture", async () => {
  const { execFileSync } = await import("node:child_process");
  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { buildCliFixture } = await import("./helpers/cli-build.js");
  const root = await buildCliFixture("9.8.7");
  try {
    expect(execFileSync("node", [join(root, "dist", "cli.js"), "--version"], { encoding: "utf8" }).trim()).toBe("9.8.7");
  } finally { await rm(root, { recursive: true, force: true }); }
});
