import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { H3Event } from "h3";
import {
  clearLocalRunStore,
  configureLocalRunStore,
  createLocalRunStore,
  getRunStore,
} from "../server/data/sqlite";
import { schemaSql } from "../server/data/sql";
import type { RunStore } from "../server/data/types";
import { runFixture, videoRunFixture } from "./fixtures";
import { analysisDigest } from "../../../src/domain/integrity";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("local SQLite projection", () => {
  test("shares and unregisters the configured process run store by path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-web-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runs.sqlite");
    const first = emptyRunStore();
    const replacement = emptyRunStore();
    const runtimeGlobal = globalThis as typeof globalThis & {
      useRuntimeConfig?: (event: H3Event) => { sqlitePath: string };
    };
    const previousRuntimeConfig = runtimeGlobal.useRuntimeConfig;
    runtimeGlobal.useRuntimeConfig = () => ({ sqlitePath: path });

    try {
      configureLocalRunStore(path, first);
      expect(await getRunStore({} as H3Event)).toBe(first);
      clearLocalRunStore(path, replacement);
      expect(await getRunStore({} as H3Event)).toBe(first);
      clearLocalRunStore(path, first);
      configureLocalRunStore(path, replacement);
      expect(await getRunStore({} as H3Event)).toBe(replacement);
      clearLocalRunStore(path, replacement);
    } finally {
      clearLocalRunStore(path, first);
      clearLocalRunStore(path, replacement);
      if (previousRuntimeConfig) {
        runtimeGlobal.useRuntimeConfig = previousRuntimeConfig;
      } else {
        delete runtimeGlobal.useRuntimeConfig;
      }
    }
  });

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

  test("imports and reads video-only v3 without meeting projection fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-web-test-"));
    temporaryDirectories.push(directory);
    const store = createLocalRunStore(join(directory, "runs.sqlite"));
    const input = await videoRunFixture();

    expect(await store.importRun(input, "tester@example.com")).toEqual({
      runId: input.manifest.runId,
      created: true,
    });
    expect((await store.listRuns({ limit: 50 })).runs[0]).toEqual(
      expect.objectContaining({
        schemaVersion: 3,
        contextMode: "none",
        acceptedCount: 1,
      }),
    );
    expect((await store.listRuns({ limit: 50 })).runs[0])
      .not.toHaveProperty("meetingId");
    await expect(store.getRun(input.manifest.runId)).resolves.toMatchObject({
      schemaVersion: 3,
      contextMode: "none",
      analysis: { context: { mode: "none" } },
      manifest: { context: { mode: "none" } },
    });
  });

  test("rejects a run ID reused across v2 and v3 projection tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-web-test-"));
    temporaryDirectories.push(directory);
    const store = createLocalRunStore(join(directory, "runs.sqlite"));
    const meeting = runFixture();
    const video = await videoRunFixture();
    video.analysis.runId = meeting.analysis.runId;
    video.manifest.runId = meeting.manifest.runId;
    video.manifest.analysisSha256 = await analysisDigest(video.analysis);

    await store.importRun(meeting);
    await expect(store.importRun(video)).rejects.toThrow(
      "another schema version",
    );
    await expect(store.getRun(meeting.manifest.runId)).resolves.toMatchObject({
      schemaVersion: 2,
      contextMode: "meeting",
    });
  });

  test("keeps D1 migrations in sync with local bootstrap SQL", async () => {
    const migrations = await Promise.all([
      "0001_initial.sql",
      "0002_video_only_projection.sql",
    ].map((name) => readFile(
      new URL(`../db/migrations/${name}`, import.meta.url),
      "utf8",
    )));
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    expect(normalize(migrations.join("\n"))).toBe(normalize(schemaSql));
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

function emptyRunStore(): RunStore {
  return {
    async listRuns() {
      return { runs: [] };
    },
    async getRun() {
      return null;
    },
    async importRun(input) {
      return { runId: input.manifest.runId, created: true };
    },
  };
}
