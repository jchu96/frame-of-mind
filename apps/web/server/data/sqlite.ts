import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { H3Event } from "h3";
import {
  isRunImportV2,
  isRunImportV3,
  type VersionedRunImport,
} from "../../../../src/domain/schemas";
import { validateVersionedRunImport } from "../../../../src/domain/integrity";
import {
  importValues,
  importVideoValues,
  deleteItemsForRunSql,
  deleteVideoItemsForRunSql,
  insertItemsFromJsonSql,
  insertVideoItemsFromJsonSql,
  itemJsonBatches,
  runSummaryColumns,
  schemaSql,
  supportedRunSummariesSql,
  upsertRunSql,
  upsertVideoRunSql,
} from "./sql";
import {
  decodeRunCursor,
  encodeRunCursor,
  storedRunFrom,
  rowToSummary,
  type RunRow,
  type RunSummaryRow,
  type RunStore,
  RunProjectionVersionConflictError,
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

export function configureLocalRunStore(
  pathValue: string,
  store: RunStore,
): void {
  const path = resolve(pathValue);
  const existing = stores.get(path);
  if (existing && existing !== store) {
    throw new Error("Local run store is already configured for this database.");
  }
  stores.set(path, store);
}

export function clearLocalRunStore(
  pathValue: string,
  store: RunStore,
): void {
  const path = resolve(pathValue);
  if (stores.get(path) === store) stores.delete(path);
}

export function createLocalRunStore(path: string): RunStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true });
  chmodSync(path, 0o600);
  return createLocalRunStoreFromDatabase(database);
}

export function createLocalRunStoreFromDatabase(
  database: Database,
): RunStore {
  database.exec(schemaSql);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  return {
    async listRuns({ limit, cursor }) {
      const decoded = decodeRunCursor(cursor);
      const rows = decoded
        ? database.query<RunSummaryRow, [string, string, string, string, string, string, number]>(
          `SELECT ${runSummaryColumns} FROM (${supportedRunSummariesSql}) AS supported_runs
           WHERE (
             completed_at < ?
             OR (completed_at = ? AND imported_at < ?)
             OR (completed_at = ? AND imported_at = ? AND run_id < ?)
           )
           ORDER BY completed_at DESC, imported_at DESC, run_id DESC LIMIT ?`,
        ).all(decoded[0], decoded[0], decoded[1], decoded[0], decoded[1], decoded[2], limit + 1)
        : database.query<RunSummaryRow, [number]>(
          `SELECT ${runSummaryColumns} FROM (${supportedRunSummariesSql}) AS supported_runs
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
      const meetingRow = database.query<RunRow, [string]>(
        `SELECT 2 AS schema_version, 'meeting' AS context_mode, *
         FROM analysis_runs WHERE run_id = ?
           AND json_valid(analysis_json) AND json_valid(manifest_json)
           AND json_extract(analysis_json, '$.schemaVersion') = 2
           AND json_extract(manifest_json, '$.schemaVersion') = 2`,
      ).get(runId);
      const videoRow = database.query<RunRow, [string]>(
        `SELECT 3 AS schema_version, 'none' AS context_mode,
           run_id, NULL AS meeting_id, NULL AS meeting_title,
           NULL AS provider, NULL AS transport, recipe_id, recipe_label,
           model, started_at, completed_at, match_notes, accepted_count,
           rejected_count, analysis_json, manifest_json, imported_at, imported_by
         FROM video_analysis_runs WHERE run_id = ?
           AND json_valid(analysis_json) AND json_valid(manifest_json)
           AND json_extract(analysis_json, '$.schemaVersion') = 3
           AND json_extract(manifest_json, '$.schemaVersion') = 3`,
      ).get(runId);
      if (meetingRow && videoRow) {
        throw new Error("Run ID exists in multiple projection schema tables.");
      }
      const row = meetingRow ?? videoRow;
      if (!row) return null;
      const input = await validateVersionedRunImport({
        analysis: JSON.parse(row.analysis_json),
        manifest: JSON.parse(row.manifest_json),
      });
      return storedRunFrom(row, input);
    },

    async importRun(input, actor) {
      const validated = await validateVersionedRunImport(input);
      const existingMeeting = database.query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM analysis_runs WHERE run_id = ?",
      ).get(validated.manifest.runId);
      const existingVideo = database.query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM video_analysis_runs WHERE run_id = ?",
      ).get(validated.manifest.runId);
      if (
        (validated.analysis.schemaVersion === 2 && existingVideo)
        || (validated.analysis.schemaVersion === 3 && existingMeeting)
      ) {
        throw new RunProjectionVersionConflictError();
      }
      const write = database.transaction((payload: VersionedRunImport, importedBy?: string) => {
        database.query(
          "INSERT OR IGNORE INTO analysis_run_registry (run_id, schema_version) VALUES (?, ?)",
        ).run(payload.manifest.runId, payload.analysis.schemaVersion);
        const registration = database.query<{ schema_version: number }, [string]>(
          "SELECT schema_version FROM analysis_run_registry WHERE run_id = ?",
        ).get(payload.manifest.runId);
        if (registration?.schema_version !== payload.analysis.schemaVersion) {
          throw new RunProjectionVersionConflictError();
        }
        if (isRunImportV2(payload)) {
          database.query(upsertRunSql).run(...importValues(payload, importedBy));
          database.query(deleteItemsForRunSql).run(payload.manifest.runId);
          for (const batch of itemJsonBatches(payload.manifest.runId, payload.analysis.items)) {
            database.query(insertItemsFromJsonSql).run(batch);
          }
          return;
        }
        if (isRunImportV3(payload)) {
          database.query(upsertVideoRunSql).run(...importVideoValues(payload, importedBy));
          database.query(deleteVideoItemsForRunSql)
            .run(payload.manifest.runId);
          for (const batch of itemJsonBatches(payload.manifest.runId, payload.analysis.items)) {
            database.query(insertVideoItemsFromJsonSql).run(batch);
          }
          return;
        }
        throw new Error("Run contract schema versions do not match.");
      });
      write.immediate(validated, actor);
      return {
        runId: validated.manifest.runId,
        created: !(existingMeeting || existingVideo),
      };
    },
  };
}
