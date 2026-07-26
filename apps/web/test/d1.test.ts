import { describe, expect, test } from "bun:test";
import { createD1RunStore } from "../server/data/d1";
import {
  itemJsonBatches,
  MAX_D1_JSON_PARAMETER_BYTES,
} from "../server/data/sql";
import type { RunRow } from "../server/data/types";
import { runFixture } from "./fixtures";
import { analysisDigest } from "../../../src/domain/integrity";

class FakeStatement {
  values: unknown[] = [];

  constructor(readonly database: FakeD1, readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async all<T>() {
    return { results: [...this.database.runs.values()] as T[] };
  }

  async first<T>() {
    if (this.sql.startsWith("SELECT 1 AS found")) {
      return (this.database.runs.has(String(this.values[0])) ? { found: 1 } : null) as T | null;
    }
    return (this.database.runs.get(String(this.values[0])) || null) as T | null;
  }
}

class FakeD1 {
  readonly runs = new Map<string, RunRow>();
  readonly items = new Map<string, unknown[][]>();
  lastBatchLength = 0;

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    this.lastBatchLength = statements.length;
    for (const statement of statements) {
      if (statement.sql.includes("INSERT INTO analysis_runs")) {
        const value = statement.values;
        this.runs.set(String(value[0]), {
          run_id: String(value[0]),
          meeting_id: String(value[1]),
          meeting_title: value[2] === null ? null : String(value[2]),
          provider: value[3] as RunRow["provider"],
          transport: value[4] as RunRow["transport"],
          recipe_id: String(value[5]),
          recipe_label: String(value[6]),
          model: String(value[7]),
          started_at: String(value[8]),
          completed_at: String(value[9]),
          match_notes: String(value[10]),
          accepted_count: Number(value[11]),
          rejected_count: Number(value[12]),
          analysis_json: String(value[13]),
          manifest_json: String(value[14]),
          imported_at: String(value[15]),
          imported_by: value[16] === null ? null : String(value[16]),
        });
      } else if (statement.sql.startsWith("DELETE FROM analysis_items")) {
        this.items.set(String(statement.values[0]), []);
      } else if (statement.sql.includes("INSERT INTO analysis_items")) {
        const rows = JSON.parse(String(statement.values[0])) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const runId = String(row.runId);
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
    const store = createD1RunStore(database as unknown as D1Database);
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

  test("uses a bounded transactional batch for 1000 small analysis items", async () => {
    const database = new FakeD1();
    const store = createD1RunStore(database as unknown as D1Database);
    const input = runFixture();
    input.analysis.items = Array.from({ length: 1_000 }, () => structuredClone(input.analysis.items[0]!));
    input.manifest.analysisSha256 = await analysisDigest(input.analysis);
    await store.importRun(input);
    expect(database.lastBatchLength).toBe(3);
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
    const store = createD1RunStore(database as unknown as D1Database);
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
    const store = createD1RunStore(database as unknown as D1Database);
    const input = runFixture();
    await store.importRun(input);
    database.runs.get(input.manifest.runId)!.model = "tampered-projection";
    expect(store.getRun(input.manifest.runId)).rejects.toThrow(/projection/);
  });
});
