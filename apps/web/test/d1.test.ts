import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { createD1RunStore } from "../server/data/d1";
import {
  importValues,
  itemJsonBatches,
  MAX_D1_JSON_PARAMETER_BYTES,
} from "../server/data/sql";
import type { RunRow } from "../server/data/types";
import { RunProjectionVersionConflictError } from "../server/data/types";
import { RunPrincipalConflictError, encodeRunCursor } from "../server/data/types";
import { runFixture, videoRunFixture } from "./fixtures";
import { analysisDigest } from "../../../src/domain/integrity";

const principalA = { principal: "user-subject-a", email: "same@example.test" };
const principalB = { principal: "user-subject-b", email: "same@example.test" };

class FakeStatement {
  values: unknown[] = [];

  constructor(readonly database: FakeD1, readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async all<T>() {
    const principal = String(this.values[0]);
    return {
      results: [
        ...this.database.runs.values(),
        ...this.database.videoRuns.values(),
      ].filter((row) => row.principal_sub === principal) as T[],
    };
  }

  async first<T>() {
    if (this.sql.includes("UNION ALL") && this.sql.includes("principal_sub <>")) {
      const runId = String(this.values[0]);
      const principal = String(this.values[1]);
      const registration = this.database.registry.get(runId);
      const row = this.database.runs.get(runId) ?? this.database.videoRuns.get(runId);
      const owner = registration?.principal ?? row?.principal_sub;
      return (owner && owner !== principal ? { principal_sub: owner } : null) as T | null;
    }
    if (this.sql.startsWith("SELECT schema_version FROM analysis_run_registry")) {
      const registration = this.database.registry.get(String(this.values[1]));
      return (registration?.principal === String(this.values[0])
        ? { schema_version: registration.schemaVersion }
        : null) as T | null;
    }
    if (this.sql.includes("SELECT principal_sub FROM analysis_run_registry")) {
      const registration = this.database.registry.get(String(this.values[0]));
      return (registration && registration.principal !== String(this.values[1])
        ? { principal_sub: registration.principal }
        : null) as T | null;
    }
    if (this.sql.startsWith("SELECT 1 AS found")) {
      const rows = this.sql.includes("video_analysis_runs")
        ? this.database.videoRuns
        : this.database.runs;
      const row = rows.get(String(this.values[1]));
      return (row?.principal_sub === String(this.values[0]) ? { found: 1 } : null) as T | null;
    }
    const rows = this.sql.includes("video_analysis_runs")
      ? this.database.videoRuns
      : this.database.runs;
    const row = rows.get(String(this.values[1]));
    return (row?.principal_sub === String(this.values[0]) ? row : null) as T | null;
  }
}

class FakeD1 {
  readonly runs = new Map<string, RunRow>();
  readonly videoRuns = new Map<string, RunRow>();
  readonly registry = new Map<string, {
    principal: string;
    schemaVersion: 2 | 3;
    email: string | null;
  }>();
  readonly items = new Map<string, unknown[][]>();
  lastBatchLength = 0;

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    this.lastBatchLength = statements.length;
    for (const statement of statements) {
      if (statement.sql.startsWith("INSERT OR IGNORE INTO analysis_run_registry")) {
        const runId = String(statement.values[1]);
        if (!this.registry.has(runId)) {
          this.registry.set(runId, {
            principal: String(statement.values[0]),
            email: statement.values[2] === null ? null : String(statement.values[2]),
            schemaVersion: statement.values[3] as 2 | 3,
          });
        }
      } else if (statement.sql.includes("INSERT INTO analysis_runs")) {
        const value = statement.values;
        const registration = this.registry.get(String(value[2]));
        if (registration?.principal !== String(value[0]) || registration.schemaVersion !== 2) continue;
        this.runs.set(String(value[2]), {
          principal_sub: String(value[0]),
          principal_email: value[1] === null ? null : String(value[1]),
          schema_version: 2,
          context_mode: "meeting",
          run_id: String(value[2]),
          meeting_id: String(value[3]),
          meeting_title: value[4] === null ? null : String(value[4]),
          provider: value[5] as RunRow["provider"],
          transport: value[6] as RunRow["transport"],
          recipe_id: String(value[7]),
          recipe_label: String(value[8]),
          model: String(value[9]),
          started_at: String(value[10]),
          completed_at: String(value[11]),
          match_notes: String(value[12]),
          accepted_count: Number(value[13]),
          rejected_count: Number(value[14]),
          analysis_json: String(value[15]),
          manifest_json: String(value[16]),
          outcome_json: value[17] === null ? null : String(value[17]),
          imported_at: String(value[18]),
          imported_by: value[19] === null ? null : String(value[19]),
        });
      } else if (statement.sql.includes("INSERT INTO video_analysis_runs")) {
        const value = statement.values;
        const registration = this.registry.get(String(value[2]));
        if (registration?.principal !== String(value[0]) || registration.schemaVersion !== 3) continue;
        this.videoRuns.set(String(value[2]), {
          principal_sub: String(value[0]),
          principal_email: value[1] === null ? null : String(value[1]),
          schema_version: 3,
          context_mode: "none",
          run_id: String(value[2]),
          meeting_id: null,
          meeting_title: null,
          provider: null,
          transport: null,
          recipe_id: String(value[3]),
          recipe_label: String(value[4]),
          model: String(value[5]),
          started_at: String(value[6]),
          completed_at: String(value[7]),
          match_notes: String(value[8]),
          accepted_count: Number(value[9]),
          rejected_count: Number(value[10]),
          analysis_json: String(value[11]),
          manifest_json: String(value[12]),
          outcome_json: value[13] === null ? null : String(value[13]),
          imported_at: String(value[14]),
          imported_by: value[15] === null ? null : String(value[15]),
        });
      } else if (
        statement.sql.includes("DELETE FROM analysis_items")
        || statement.sql.includes("DELETE FROM video_analysis_items")
      ) {
        const principal = String(statement.values[0]);
        const runId = String(statement.values[1]);
        const expectedVersion = statement.sql.includes("video_analysis_items") ? 3 : 2;
        const registration = this.registry.get(runId);
        if (registration?.principal === principal && registration.schemaVersion === expectedVersion) {
          this.items.set(runId, []);
        }
      } else if (
        statement.sql.includes("INSERT INTO analysis_items")
        || statement.sql.includes("INSERT INTO video_analysis_items")
      ) {
        const principal = String(statement.values[0]);
        const rows = JSON.parse(String(statement.values[2])) as Array<Record<string, unknown>>;
        const expectedVersion = statement.sql.includes("video_analysis_items") ? 3 : 2;
        for (const row of rows) {
          const runId = String(row.runId);
          const registration = this.registry.get(runId);
          if (registration?.principal !== principal || registration.schemaVersion !== expectedVersion) continue;
          this.items.set(runId, [...(this.items.get(runId) || []), Object.values(row)]);
        }
      }
    }
    return statements.map(() => ({ success: true }));
  }
}

describe("D1 projection contract", () => {
  test("imports, lists, reads, and refreshes through the shared RunStore API", async () => {
    const database = new FakeD1();
    const store = createD1RunStore(database as unknown as D1Database, principalA);
    const input = runFixture();

    expect(await store.importRun(input, "tester@example.com")).toEqual({
      runId: input.manifest.runId,
      created: true,
    });
    expect((await store.listRuns({ limit: 50 })).runs[0]).toMatchObject({
      meetingTitle: "Product review",
      acceptedCount: 1,
      importedBy: "tester@example.com",
    });
    expect((await store.getRun(input.manifest.runId))?.analysis.items[0]?.result.title)
      .toBe("Use the portable contract");
    expect((await store.importRun(input)).created).toBe(false);
    expect(database.items.get(input.manifest.runId)).toHaveLength(1);
  });

  test("keeps video-only v3 projection behavior in parity with SQLite", async () => {
    const database = new FakeD1();
    const store = createD1RunStore(database as unknown as D1Database, principalA);
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
    });
  });

  test("rejects a run ID reused across v2 and v3 projection tables", async () => {
    const database = new FakeD1();
    const store = createD1RunStore(database as unknown as D1Database, principalA);
    const meeting = runFixture();
    const video = await videoRunFixture();
    video.analysis.runId = meeting.analysis.runId;
    video.manifest.runId = meeting.manifest.runId;
    video.manifest.analysisSha256 = await analysisDigest(video.analysis);

    await store.importRun(meeting);
    await expect(store.importRun(video)).rejects.toThrow(
      "another schema version",
    );
    expect(database.videoRuns.size).toBe(0);
  });

  test("uses a bounded transactional batch for 1000 small analysis items", async () => {
    const database = new FakeD1();
    const store = createD1RunStore(database as unknown as D1Database, principalA);
    const input = runFixture();
    input.analysis.items = Array.from({ length: 1_000 }, () => structuredClone(input.analysis.items[0]!));
    input.manifest.analysisSha256 = await analysisDigest(input.analysis);
    await store.importRun(input);
    expect(database.lastBatchLength).toBe(4);
    expect(database.items.get(input.manifest.runId)).toHaveLength(1_000);
  });

  test("keeps expanded projection parameters below the D1 value limit", () => {
    const input = runFixture();
    input.analysis.items = Array.from({ length: 700 }, (_, index) => {
      const item = structuredClone(input.analysis.items[0]!);
      item.result.summary = `${index}: ${"x".repeat(1_000)}`;
      item.candidate.summary = `${index}: ${"y".repeat(1_000)}`;
      return item;
    });
    const batches = itemJsonBatches(input.manifest.runId, input.analysis.items);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(new TextEncoder().encode(batch).byteLength)
        .toBeLessThanOrEqual(MAX_D1_JSON_PARAMETER_BYTES);
    }
  });

  test("imports a sub-2 MiB analysis through multiple bounded item expansions", async () => {
    const database = new FakeD1();
    const store = createD1RunStore(database as unknown as D1Database, principalA);
    const input = runFixture();
    input.analysis.items = Array.from({ length: 700 }, (_, index) => {
      const item = structuredClone(input.analysis.items[0]!);
      item.result.summary = `${index}: ${"x".repeat(1_000)}`;
      item.candidate.summary = `${index}: ${"y".repeat(1_000)}`;
      return item;
    });
    input.manifest.analysisSha256 = await analysisDigest(input.analysis);
    await store.importRun(input);
    expect(database.lastBatchLength).toBeGreaterThan(3);
    expect(database.lastBatchLength).toBeLessThan(10);
    expect(database.items.get(input.manifest.runId)).toHaveLength(700);
  });

  test("rejects a normalized projection that diverges from its bound bundle", async () => {
    const database = new FakeD1();
    const store = createD1RunStore(database as unknown as D1Database, principalA);
    const input = runFixture();
    await store.importRun(input);
    database.runs.get(input.manifest.runId)!.model = "tampered-projection";
    expect(store.getRun(input.manifest.runId)).rejects.toThrow(/projection/);
  });

  test("isolates two principals and rejects cross-principal run ID reuse", async () => {
    const database = new FakeD1();
    const storeA = createD1RunStore(database as unknown as D1Database, principalA);
    const storeB = createD1RunStore(database as unknown as D1Database, principalB);
    const runA = runFixture();
    const runB = await videoRunFixture();

    await storeA.importRun(runA, principalA.email);
    expect((await storeB.listRuns({ limit: 10 })).runs).toEqual([]);
    await expect(storeB.getRun(runA.manifest.runId)).resolves.toBeNull();
    await expect(storeB.importRun(runA, principalB.email)).rejects.toBeInstanceOf(
      RunPrincipalConflictError,
    );

    await storeB.importRun(runB, principalB.email);
    expect((await storeA.listRuns({ limit: 10 })).runs.map((run) => run.runId))
      .toEqual([runA.manifest.runId]);
    expect((await storeB.listRuns({ limit: 10 })).runs.map((run) => run.runId))
      .toEqual([runB.manifest.runId]);

    // Pagination cursors are opaque pagination keys only: they never carry
    // the Access `sub`, and a cursor pasted by another principal pages over
    // that principal's own rows rather than revealing the owner's.
    const cursorA = encodeRunCursor({
      run_id: runA.manifest.runId,
      completed_at: "2026-08-22T00:00:00.000Z",
      imported_at: "2026-08-22T00:00:00.000Z",
    } as Parameters<typeof encodeRunCursor>[0]);
    expect(decodeURIComponent(cursorA)).not.toContain(principalA.principal);
    const pagedByB = await storeB.listRuns({ limit: 10, cursor: cursorA });
    expect(pagedByB.runs.every((run) => run.runId !== runA.manifest.runId)).toBe(true);
  });

  test("uses real local D1 semantics for migrations, mixed versions, and collisions", async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "frame-of-mind-projection-test" },
    });
    try {
      const database = await miniflare.getD1Database("DB");
      const migrations = await Promise.all([
        "0001_initial.sql",
        "0002_video_only_projection.sql",
        "0003_principal_scope.sql",
        "0011_run_outcome_projection.sql",
      ].map((name) => readFile(
        new URL(`../db/migrations/${name}`, import.meta.url),
        "utf8",
      )));
      for (const migration of migrations) {
        await applyD1Migration(database, migration);
      }
      const sentinel = await database.prepare(`
        SELECT
          (SELECT count(*) FROM analysis_runs WHERE principal_sub = '__legacy_unclaimed__')
          + (SELECT count(*) FROM analysis_items WHERE principal_sub = '__legacy_unclaimed__')
          + (SELECT count(*) FROM analysis_run_registry WHERE principal_sub = '__legacy_unclaimed__')
          + (SELECT count(*) FROM video_analysis_runs WHERE principal_sub = '__legacy_unclaimed__')
          + (SELECT count(*) FROM video_analysis_items WHERE principal_sub = '__legacy_unclaimed__')
          AS count
      `).first<{ count: number }>();
      expect(sentinel?.count).toBe(0);
      const store = createD1RunStore(database as unknown as D1Database, principalA);
      const meeting = runFixture();
      const video = await videoRunFixture();

      await store.importRun(meeting, "tester@example.com");
      await store.importRun(video, "tester@example.com");
      const listed = await store.listRuns({ limit: 10 });
      expect(listed.runs.map((run) => run.schemaVersion).sort()).toEqual([2, 3]);
      await expect(store.getRun(meeting.manifest.runId)).resolves.toMatchObject({
        schemaVersion: 2,
        contextMode: "meeting",
      });
      await expect(store.getRun(video.manifest.runId)).resolves.toMatchObject({
        schemaVersion: 3,
        contextMode: "none",
      });

      const collision = await videoRunFixture();
      collision.analysis.runId = meeting.analysis.runId;
      collision.manifest.runId = meeting.manifest.runId;
      collision.manifest.analysisSha256 = await analysisDigest(collision.analysis);
      await expect(store.importRun(collision)).rejects.toBeInstanceOf(
        RunProjectionVersionConflictError,
      );

      const itemsBefore = await database.prepare(
        `SELECT candidate_json, result_json FROM analysis_items
         WHERE principal_sub = ? AND run_id = ? ORDER BY item_index`,
      ).bind(principalA.principal, meeting.manifest.runId).all();
      const runBefore = await database.prepare(
        `SELECT analysis_json FROM analysis_runs
         WHERE principal_sub = ? AND run_id = ?`,
      ).bind(principalA.principal, meeting.manifest.runId).first<{ analysis_json: string }>();
      await database.prepare(
        `UPDATE analysis_run_registry SET schema_version = 3
         WHERE principal_sub = ? AND run_id = ?`,
      ).bind(principalA.principal, meeting.manifest.runId).run();
      meeting.analysis.items[0]!.result.summary = "must not be projected";
      meeting.manifest.analysisSha256 = await analysisDigest(meeting.analysis);
      await expect(store.importRun(meeting)).rejects.toBeInstanceOf(
        RunProjectionVersionConflictError,
      );
      const itemsAfter = await database.prepare(
        `SELECT candidate_json, result_json FROM analysis_items
         WHERE principal_sub = ? AND run_id = ? ORDER BY item_index`,
      ).bind(principalA.principal, meeting.manifest.runId).all();
      const runAfter = await database.prepare(
        `SELECT analysis_json FROM analysis_runs
         WHERE principal_sub = ? AND run_id = ?`,
      ).bind(principalA.principal, meeting.manifest.runId).first<{ analysis_json: string }>();
      expect(itemsAfter.results).toEqual(itemsBefore.results);
      expect(runAfter?.analysis_json).toBe(runBefore?.analysis_json);

      const atomic = await videoRunFixture();
      atomic.analysis.runId = "20260822T120000Z-atomic-publication";
      atomic.manifest.runId = atomic.analysis.runId;
      atomic.manifest.analysisSha256 = await analysisDigest(atomic.analysis);
      const digestMismatch = structuredClone(atomic);
      digestMismatch.manifest.analysisSha256 = "0".repeat(64);
      await expect(store.importRun(digestMismatch)).rejects.toThrow();
      const schemaMismatch = structuredClone(atomic) as unknown as {
        analysis: typeof atomic.analysis;
        manifest: Record<string, unknown>;
      };
      schemaMismatch.manifest.schemaVersion = 2;
      await expect(store.importRun(schemaMismatch as never)).rejects.toThrow();
      await database.prepare(`
        CREATE TRIGGER reject_atomic_publication_item
        BEFORE INSERT ON video_analysis_items
        WHEN NEW.run_id = '${atomic.analysis.runId}'
        BEGIN SELECT RAISE(ABORT, 'forced_atomic_publication_failure'); END
      `).run();
      await expect(store.importRun(atomic)).rejects.toThrow(
        /forced_atomic_publication_failure/,
      );
      for (const table of [
        "analysis_run_registry",
        "video_analysis_runs",
        "video_analysis_items",
      ]) {
        const row = await database.prepare(
          `SELECT count(*) AS count FROM ${table} WHERE principal_sub = ? AND run_id = ?`,
        ).bind(principalA.principal, atomic.analysis.runId).first<{ count: number }>();
        expect(row?.count).toBe(0);
      }
    } finally {
      await miniflare.dispose();
    }
  });

  test("fails the D1 principal migration closed with a named legacy-row error", async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "frame-of-mind-legacy-migration-test" },
    });
    try {
      const database = await miniflare.getD1Database("DB");
      const [initial, video, principalMigration] = await Promise.all([
        "0001_initial.sql",
        "0002_video_only_projection.sql",
        "0003_principal_scope.sql",
      ].map((name) => readFile(
        new URL(`../db/migrations/${name}`, import.meta.url),
        "utf8",
      )));
      await applyD1Migration(database, initial!);
      const input = runFixture();
      const legacyValues = importValues(
        input,
        principalA.principal,
        principalA.email,
        "legacy@example.test",
      ).slice(2, -2);
      // The legacy 0001-era schema predates outcome_json; drop that value so
      // the positional insert matches the 17 legacy columns.
      legacyValues.splice(15, 1);
      await database.prepare(`
        INSERT INTO analysis_runs (
          run_id, meeting_id, meeting_title, provider, transport, recipe_id,
          recipe_label, model, started_at, completed_at, match_notes,
          accepted_count, rejected_count, analysis_json, manifest_json,
          imported_at, imported_by
        ) VALUES (${Array.from({ length: 17 }, () => "?").join(", ")})
      `).bind(...legacyValues).run();
      await applyD1Migration(database, video!);
      await expect(applyD1Migration(database, principalMigration!)).rejects.toThrow(
        /principal_scope_requires_empty_legacy_tables/,
      );
      const columns = await database.prepare(
        "SELECT name FROM pragma_table_info('analysis_runs') WHERE name = 'principal_sub'",
      ).all();
      expect(columns.results).toEqual([]);
      expect((await database.prepare(
        "SELECT count(*) AS count FROM analysis_runs",
      ).first<{ count: number }>())?.count).toBe(1);
    } finally {
      await miniflare.dispose();
    }
  });
});

async function applyD1Migration(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  sql: string,
): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
  await database.batch(statements);
}
