import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { H3Event } from "h3";
import type { RunImport } from "../../../../src/domain/schemas";
import { validateRunImport } from "../../../../src/domain/integrity";
import type { StoredRun } from "../../shared/types";
import {
  importValues,
  insertItemsFromJsonSql,
  itemJsonBatches,
  runSummaryColumns,
  schemaSql,
  upsertRunSql,
} from "./sql";
import {
  decodeRunCursor,
  encodeRunCursor,
  assertStoredRunConsistency,
  rowToSummary,
  type RunRow,
  type RunSummaryRow,
  type RunStore,
} from "./types";

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
  const supportedRun = `CASE
    WHEN json_valid(analysis_json) AND json_valid(manifest_json)
    THEN json_extract(analysis_json, '$.schemaVersion') = 2
      AND json_extract(manifest_json, '$.schemaVersion') = 2
    ELSE 0
  END`;

  return {
    async listRuns({ limit, cursor }) {
      const decoded = decodeRunCursor(cursor);
      const rows = decoded
        ? database.query<RunSummaryRow, [string, string, string, string, string, string, number]>(
          `SELECT ${runSummaryColumns} FROM analysis_runs
           WHERE ${supportedRun} AND (
             completed_at < ?
             OR (completed_at = ? AND imported_at < ?)
             OR (completed_at = ? AND imported_at = ? AND run_id < ?)
           )
           ORDER BY completed_at DESC, imported_at DESC, run_id DESC LIMIT ?`,
        ).all(decoded[0], decoded[0], decoded[1], decoded[0], decoded[1], decoded[2], limit + 1)
        : database.query<RunSummaryRow, [number]>(
          `SELECT ${runSummaryColumns} FROM analysis_runs WHERE ${supportedRun}
           ORDER BY completed_at DESC, imported_at DESC, run_id DESC LIMIT ?`,
        ).all(limit + 1);
      const page = rows.slice(0, limit);
      return {
        runs: page.map(rowToSummary),
        ...(rows.length > limit && page.length
          ? { nextCursor: encodeRunCursor(page[page.length - 1]!) }
          : {}),
      };
    },

    async getRun(runId) {
      const row = database.query<RunRow, [string]>(
        `SELECT * FROM analysis_runs WHERE run_id = ? AND ${supportedRun}`,
      ).get(runId);
      if (!row) return null;
      const input = await validateRunImport({
        analysis: JSON.parse(row.analysis_json),
        manifest: JSON.parse(row.manifest_json),
      });
      assertStoredRunConsistency(row, input);
      return {
        ...rowToSummary(row),
        matchNotes: row.match_notes,
        analysis: input.analysis,
        manifest: input.manifest,
      } satisfies StoredRun;
    },

    async importRun(input, actor) {
      const validated = await validateRunImport(input);
      const existing = database.query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM analysis_runs WHERE run_id = ?",
      ).get(validated.manifest.runId);
      const write = database.transaction((payload: RunImport, importedBy?: string) => {
        database.query(upsertRunSql).run(...importValues(payload, importedBy));
        database.query("DELETE FROM analysis_items WHERE run_id = ?").run(payload.manifest.runId);
        for (const batch of itemJsonBatches(payload.manifest.runId, payload.analysis.items)) {
          database.query(insertItemsFromJsonSql)
            .run(batch);
        }
      });
      write(validated, actor);
      return { runId: validated.manifest.runId, created: !existing };
    },
  };
}
