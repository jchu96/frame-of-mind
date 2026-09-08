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
