import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { H3Event } from "h3";
import { analysisRunSchema, runManifestSchema, type RunImport } from "../../../../src/domain/schemas";
import type { StoredRun } from "../../shared/types";
import {
  importValues,
  insertItemSql,
  itemValues,
  schemaSql,
  upsertRunSql,
} from "./sql";
import { rowToSummary, type RunRow, type RunStore } from "./types";

const stores = new Map<string, RunStore>();

export async function getRunStore(event: H3Event): Promise<RunStore> {
  const config = useRuntimeConfig(event);
  const path = resolve(String(config.sqlitePath));
  const existing = stores.get(path);
  if (existing) return existing;
  const store = createLocalRunStore(path);
  stores.set(path, store);
  return store;
}

export function createLocalRunStore(path: string): RunStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true });
  chmodSync(path, 0o600);
  database.exec(schemaSql);
  database.exec("PRAGMA foreign_keys = ON;");

  return {
    async listRuns() {
      const rows = database.query<RunRow, []>(
        "SELECT * FROM analysis_runs ORDER BY completed_at DESC, imported_at DESC",
      ).all();
      return rows.map(rowToSummary);
    },

    async getRun(runId) {
      const row = database.query<RunRow, [string]>(
        "SELECT * FROM analysis_runs WHERE run_id = ?",
      ).get(runId);
      if (!row) return null;
      return {
        ...rowToSummary(row),
        matchNotes: row.match_notes,
        analysis: analysisRunSchema.parse(JSON.parse(row.analysis_json)),
        manifest: runManifestSchema.parse(JSON.parse(row.manifest_json)),
      } satisfies StoredRun;
    },

    async importRun(input, actor) {
      const existing = database.query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM analysis_runs WHERE run_id = ?",
      ).get(input.manifest.runId);
      const write = database.transaction((payload: RunImport, importedBy?: string) => {
        database.query(upsertRunSql).run(...importValues(payload, importedBy));
        database.query("DELETE FROM analysis_items WHERE run_id = ?").run(payload.manifest.runId);
        const insert = database.query(insertItemSql);
        payload.analysis.items.forEach((item, index) => {
          insert.run(...itemValues(payload.manifest.runId, item, index));
        });
      });
      write(input, actor);
      return { runId: input.manifest.runId, created: !existing };
    },
  };
}
