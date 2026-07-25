import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRunStore } from "../server/data/sqlite";
import { schemaSql } from "../server/data/sql";
import { runFixture } from "./fixtures";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("local SQLite projection", () => {
  test("imports, lists, reads, and refreshes a run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-web-test-"));
    temporaryDirectories.push(directory);
    const store = createLocalRunStore(join(directory, "runs.sqlite"));
    const input = runFixture();

    expect(await store.importRun(input, "tester@example.com")).toEqual({
      runId: input.manifest.runId,
      created: true,
    });
    expect((await store.listRuns())[0]).toMatchObject({
      acceptedCount: 1,
      rejectedCount: 0,
      importedBy: "tester@example.com",
    });
    expect((await store.getRun(input.manifest.runId))?.analysis.items[0]?.result.title)
      .toBe("Use the portable contract");
    expect((await store.importRun(input)).created).toBe(false);
    expect((await stat(join(directory, "runs.sqlite"))).mode & 0o077).toBe(0);
  });

  test("keeps the D1 migration in sync with local bootstrap SQL", async () => {
    const migration = await readFile(
      new URL("../db/migrations/0001_initial.sql", import.meta.url),
      "utf8",
    );
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    expect(normalize(migration)).toBe(normalize(schemaSql));
  });
});
