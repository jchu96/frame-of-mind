import { describe, expect, test } from "bun:test";
import { createD1RunStore } from "../server/data/d1";
import type { RunRow } from "../server/data/types";
import { runFixture } from "./fixtures";

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

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
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
        const runId = String(statement.values[0]);
        this.items.set(runId, [...(this.items.get(runId) || []), statement.values]);
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
    expect((await store.listRuns())[0]).toMatchObject({
      meetingTitle: "Product review",
      acceptedCount: 1,
      importedBy: "tester@example.com",
    });
    expect((await store.getRun(input.manifest.runId))?.analysis.items[0]?.result.title)
      .toBe("Use the portable contract");
    expect((await store.importRun(input)).created).toBe(false);
    expect(database.items.get(input.manifest.runId)).toHaveLength(1);
  });
});
