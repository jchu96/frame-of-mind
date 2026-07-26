import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createLocalRunStore } from "../server/data/sqlite";
import { schemaSql } from "../server/data/sql";
import { runFixture } from "./fixtures";
import { analysisDigest } from "../../../src/domain/integrity";

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
    expect((await store.listRuns({ limit: 50 })).runs[0]).toMatchObject({
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

  test("keyset-paginates stable summary rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-web-test-"));
    temporaryDirectories.push(directory);
    const store = createLocalRunStore(join(directory, "runs.sqlite"));
    for (const index of [1, 2, 3]) {
      const input = runFixture();
      const runId = `20260725T12000${index}Z-page`;
      input.analysis.runId = runId;
      input.manifest.runId = runId;
      input.manifest.completedAt = `2026-07-25T12:0${index}:00.000Z`;
      input.manifest.analysisSha256 = await analysisDigest(input.analysis);
      await store.importRun(input);
    }
    const first = await store.listRuns({ limit: 2 });
    expect(first.runs.map((run) => run.runId)).toEqual([
      "20260725T120003Z-page",
      "20260725T120002Z-page",
    ]);
    expect(first.nextCursor).toBeDefined();
    const second = await store.listRuns({ limit: 2, cursor: first.nextCursor });
    expect(second.runs.map((run) => run.runId)).toEqual(["20260725T120001Z-page"]);
  });

  test("rejects a tampered meeting title projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-web-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runs.sqlite");
    const store = createLocalRunStore(path);
    const input = runFixture();
    await store.importRun(input);
    const database = new Database(path);
    database.query("UPDATE analysis_runs SET meeting_title = ? WHERE run_id = ?")
      .run("Tampered title", input.manifest.runId);
    database.close();
    expect(store.getRun(input.manifest.runId)).rejects.toThrow(/projection/);
  });

  test("hides legacy v1 projection rows until they are re-imported as v2", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-web-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runs.sqlite");
    const store = createLocalRunStore(path);
    const input = runFixture();
    await store.importRun(input);
    const database = new Database(path);
    const analysis = { ...input.analysis, schemaVersion: 1 };
    const manifest = { ...input.manifest, schemaVersion: 1 };
    database.query(
      "UPDATE analysis_runs SET analysis_json = ?, manifest_json = ? WHERE run_id = ?",
    ).run(JSON.stringify(analysis), JSON.stringify(manifest), input.manifest.runId);
    database.close();
    expect((await store.listRuns({ limit: 50 })).runs).toHaveLength(0);
    expect(await store.getRun(input.manifest.runId)).toBeNull();
  });

  test("hides malformed legacy JSON instead of failing the whole run list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-web-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runs.sqlite");
    const store = createLocalRunStore(path);
    const input = runFixture();
    await store.importRun(input);
    const database = new Database(path);
    database.query("UPDATE analysis_runs SET analysis_json = ? WHERE run_id = ?")
      .run("{", input.manifest.runId);
    database.close();
    expect((await store.listRuns({ limit: 50 })).runs).toHaveLength(0);
    expect(await store.getRun(input.manifest.runId)).toBeNull();
  });
});
