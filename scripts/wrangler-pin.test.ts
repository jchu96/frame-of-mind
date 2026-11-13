import { expect, test } from "bun:test";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Incident 2026-11-12: root scripts resolved an ancestor's incompatible Wrangler.
// Retire when Wrangler is pinned at the root and all supported runners resolve it there.
test("scripts use the workspace Wrangler pin", async () => {
  const violations: string[] = [];
  for (const path of await readdir(import.meta.dir, { recursive: true })) {
    const absolutePath = join(import.meta.dir, path);
    if (!(await lstat(absolutePath)).isFile()) continue;
    const source = await readFile(absolutePath, "utf8");
    // Shell commands and adjacent argv literals, including multiline arrays.
    const unpinned = /\bbunx(?:\s+|["'`]\s*,\s*["'`])wrangler\b/g;
    for (const match of source.matchAll(unpinned)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`scripts/${path}:${line} [unpinned-wrangler]`);
    }
  }
  expect(violations, violations.join("\n")).toEqual([]);
});
