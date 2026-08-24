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
  type RunPrincipal,
  type RunStore,
  LOCAL_SINGLE_USER_PRINCIPAL,
  RunPrincipalConflictError,
  RunProjectionVersionConflictError,
} from "./types";

const stores = new Map<string, RunStore>();

export async function getRunStore(event: H3Event): Promise<RunStore> {
  const config = useRuntimeConfig(event);
  const path = resolve(String(config.sqlitePath));
  const existing = stores.get(path);
  if (existing) return existing;
  const store = createLocalRunStore(path, LOCAL_SINGLE_USER_PRINCIPAL);
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

export function createLocalRunStore(
  path: string,
  principal: RunPrincipal,
): RunStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true });
  chmodSync(path, 0o600);
  return createLocalRunStoreFromDatabase(database, principal);
}

export function createLocalRunStoreFromDatabase(
  database: Database,
  principal: RunPrincipal,
): RunStore {
  migrateLegacyLocalProjection(database, principal);
  database.exec(schemaSql);
  ensureOutcomeColumn(database, "analysis_runs");
  ensureOutcomeColumn(database, "video_analysis_runs");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  return {
    async listRuns({ limit, cursor }) {
      const decoded = decodeRunCursor(cursor);
      if (cursor && !decoded) {
        throw createError({ statusCode: 400, statusMessage: "Run cursor is invalid." });
      }
      const rows = decoded
        ? database.query<RunSummaryRow, [string, string, string, string, string, string, string, string, number]>(
          `SELECT ${runSummaryColumns} FROM (${supportedRunSummariesSql}) AS supported_runs
           WHERE (
             completed_at < ?
             OR (completed_at = ? AND imported_at < ?)
             OR (completed_at = ? AND imported_at = ? AND run_id < ?)
           )
           ORDER BY completed_at DESC, imported_at DESC, run_id DESC LIMIT ?`,
        ).all(
          principal.principal,
          principal.principal,
          decoded[0],
          decoded[0],
          decoded[1],
          decoded[0],
          decoded[1],
          decoded[2],
          limit + 1,
        )
        : database.query<RunSummaryRow, [string, string, number]>(
          `SELECT ${runSummaryColumns} FROM (${supportedRunSummariesSql}) AS supported_runs
           ORDER BY completed_at DESC, imported_at DESC, run_id DESC LIMIT ?`,
        ).all(principal.principal, principal.principal, limit + 1);
      const page = rows.slice(0, limit);
      return {
        runs: page.map(rowToSummary),
        ...(rows.length > limit && page.length
          ? { nextCursor: encodeRunCursor(page[page.length - 1]!) }
          : {}),
      };
    },

    async getRun(runId) {
      const meetingRow = database.query<RunRow, [string, string]>(
        `SELECT 2 AS schema_version, 'meeting' AS context_mode, *
         FROM analysis_runs WHERE principal_sub = ? AND run_id = ?
           AND json_valid(analysis_json) AND json_valid(manifest_json)
           AND json_extract(analysis_json, '$.schemaVersion') = 2
           AND json_extract(manifest_json, '$.schemaVersion') = 2`,
      ).get(principal.principal, runId);
      const videoRow = database.query<RunRow, [string, string]>(
        `SELECT 3 AS schema_version, 'none' AS context_mode,
           run_id, NULL AS meeting_id, NULL AS meeting_title,
           NULL AS provider, NULL AS transport, recipe_id, recipe_label,
           model, started_at, completed_at, match_notes, accepted_count,
           rejected_count, analysis_json, manifest_json, outcome_json,
           imported_at, imported_by
         FROM video_analysis_runs WHERE principal_sub = ? AND run_id = ?
           AND json_valid(analysis_json) AND json_valid(manifest_json)
           AND json_extract(analysis_json, '$.schemaVersion') = 3
           AND json_extract(manifest_json, '$.schemaVersion') = 3`,
      ).get(principal.principal, runId);
      if (meetingRow && videoRow) {
        throw new Error("Run ID exists in multiple projection schema tables.");
      }
      const row = meetingRow ?? videoRow;
      if (!row) return null;
      const input = await validateVersionedRunImport({
        analysis: JSON.parse(row.analysis_json),
        manifest: JSON.parse(row.manifest_json),
        ...(row.outcome_json ? { outcome: JSON.parse(row.outcome_json) } : {}),
      });
      return storedRunFrom(row, input);
    },

    async importRun(input, actor) {
      const validated = await validateVersionedRunImport(input);
      const conflictingPrincipal = database.query<{ principal_sub: string }, [string, string, string, string, string, string]>(`
        SELECT principal_sub FROM analysis_run_registry
        WHERE run_id = ? AND principal_sub <> ?
        UNION ALL
        SELECT principal_sub FROM analysis_runs
        WHERE run_id = ? AND principal_sub <> ?
        UNION ALL
        SELECT principal_sub FROM video_analysis_runs
        WHERE run_id = ? AND principal_sub <> ?
        LIMIT 1
      `).get(
        validated.manifest.runId,
        principal.principal,
        validated.manifest.runId,
        principal.principal,
        validated.manifest.runId,
        principal.principal,
      );
      if (conflictingPrincipal) throw new RunPrincipalConflictError();
      const existingMeeting = database.query<{ found: number }, [string, string]>(
        "SELECT 1 AS found FROM analysis_runs WHERE principal_sub = ? AND run_id = ?",
      ).get(principal.principal, validated.manifest.runId);
      const existingVideo = database.query<{ found: number }, [string, string]>(
        "SELECT 1 AS found FROM video_analysis_runs WHERE principal_sub = ? AND run_id = ?",
      ).get(principal.principal, validated.manifest.runId);
      if (
        (validated.analysis.schemaVersion === 2 && existingVideo)
        || (validated.analysis.schemaVersion === 3 && existingMeeting)
      ) {
        throw new RunProjectionVersionConflictError();
      }
      const write = database.transaction((payload: VersionedRunImport, importedBy?: string) => {
        database.query(
          `INSERT OR IGNORE INTO analysis_run_registry
            (principal_sub, run_id, principal_email, schema_version)
           VALUES (?, ?, ?, ?)`,
        ).run(
          principal.principal,
          payload.manifest.runId,
          principal.email ?? null,
          payload.analysis.schemaVersion,
        );
        const registration = database.query<{ schema_version: number }, [string, string]>(
          `SELECT schema_version FROM analysis_run_registry
           WHERE principal_sub = ? AND run_id = ?`,
        ).get(principal.principal, payload.manifest.runId);
        if (registration?.schema_version !== payload.analysis.schemaVersion) {
          const owner = database.query<{ principal_sub: string }, [string, string]>(
            `SELECT principal_sub FROM analysis_run_registry
             WHERE run_id = ? AND principal_sub <> ?`,
          ).get(payload.manifest.runId, principal.principal);
          if (owner) throw new RunPrincipalConflictError();
          throw new RunProjectionVersionConflictError();
        }
        if (isRunImportV2(payload)) {
          database.query(upsertRunSql).run(...importValues(
            payload,
            principal.principal,
            principal.email,
            importedBy,
          ));
          database.query(deleteItemsForRunSql).run(principal.principal, payload.manifest.runId);
          for (const batch of itemJsonBatches(payload.manifest.runId, payload.analysis.items)) {
            database.query(insertItemsFromJsonSql).run(
              principal.principal,
              principal.email ?? null,
              batch,
            );
          }
          return;
        }
        if (isRunImportV3(payload)) {
          database.query(upsertVideoRunSql).run(...importVideoValues(
            payload,
            principal.principal,
            principal.email,
            importedBy,
          ));
          database.query(deleteVideoItemsForRunSql)
            .run(principal.principal, payload.manifest.runId);
          for (const batch of itemJsonBatches(payload.manifest.runId, payload.analysis.items)) {
            database.query(insertVideoItemsFromJsonSql).run(
              principal.principal,
              principal.email ?? null,
              batch,
            );
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

function migrateLegacyLocalProjection(
  database: Database,
  principal: RunPrincipal,
): void {
  const analysisTable = database.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analysis_runs'",
  ).get();
  if (!analysisTable) return;
  const columns = database.query<{ name: string }, []>(
    "PRAGMA table_info(analysis_runs)",
  ).all();
  if (columns.some((column) => column.name === "principal_sub")) return;

  database.exec(`
    CREATE TABLE IF NOT EXISTS analysis_run_registry (
      run_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version IN (2, 3))
    ) STRICT;
    INSERT OR IGNORE INTO analysis_run_registry (run_id, schema_version)
      SELECT run_id, 2 FROM analysis_runs;
    CREATE TABLE IF NOT EXISTS video_analysis_runs (
      run_id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      recipe_label TEXT NOT NULL,
      model TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      match_notes TEXT NOT NULL,
      accepted_count INTEGER NOT NULL,
      rejected_count INTEGER NOT NULL,
      analysis_json TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      imported_by TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS video_analysis_items (
      run_id TEXT NOT NULL REFERENCES video_analysis_runs(run_id) ON DELETE CASCADE,
      item_index INTEGER NOT NULL,
      accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      importance TEXT CHECK (importance IN ('high', 'medium', 'low')),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      screenshot TEXT,
      candidate_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (run_id, item_index)
    ) STRICT;
  `);

  const quotedPrincipal = `'${principal.principal.replaceAll("'", "''")}'`;
  database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE analysis_items RENAME TO analysis_items_legacy;
      ALTER TABLE analysis_runs RENAME TO analysis_runs_legacy;
      ALTER TABLE analysis_run_registry RENAME TO analysis_run_registry_legacy;
      ALTER TABLE video_analysis_items RENAME TO video_analysis_items_legacy;
      ALTER TABLE video_analysis_runs RENAME TO video_analysis_runs_legacy;
      DROP INDEX IF EXISTS analysis_runs_completed_at_idx;
      DROP INDEX IF EXISTS analysis_runs_meeting_id_idx;
      DROP INDEX IF EXISTS analysis_items_kind_idx;
      DROP INDEX IF EXISTS analysis_items_accepted_idx;
      DROP INDEX IF EXISTS video_analysis_runs_completed_at_idx;
      DROP INDEX IF EXISTS video_analysis_items_kind_idx;
      DROP INDEX IF EXISTS video_analysis_items_accepted_idx;
      ${schemaSql}
      INSERT INTO analysis_runs (
        principal_sub, run_id, principal_email, meeting_id, meeting_title,
        provider, transport, recipe_id, recipe_label, model, started_at,
        completed_at, match_notes, accepted_count, rejected_count,
        analysis_json, manifest_json, imported_at, imported_by
      ) SELECT
        ${quotedPrincipal}, run_id, NULL, meeting_id, meeting_title, provider,
        transport, recipe_id, recipe_label, model, started_at, completed_at,
        match_notes, accepted_count, rejected_count, analysis_json,
        manifest_json, imported_at, imported_by
      FROM analysis_runs_legacy;
      INSERT INTO analysis_items (
        principal_sub, run_id, principal_email, item_index, accepted, kind,
        title, summary, importance, start_time, end_time, screenshot,
        candidate_json, result_json
      ) SELECT
        ${quotedPrincipal}, run_id, NULL, item_index, accepted, kind, title,
        summary, importance, start_time, end_time, screenshot, candidate_json,
        result_json
      FROM analysis_items_legacy;
      INSERT INTO analysis_run_registry (
        principal_sub, run_id, principal_email, schema_version
      ) SELECT ${quotedPrincipal}, run_id, NULL, schema_version
        FROM analysis_run_registry_legacy;
      INSERT INTO video_analysis_runs (
        principal_sub, run_id, principal_email, recipe_id, recipe_label, model,
        started_at, completed_at, match_notes, accepted_count, rejected_count,
        analysis_json, manifest_json, imported_at, imported_by
      ) SELECT
        ${quotedPrincipal}, run_id, NULL, recipe_id, recipe_label, model,
        started_at, completed_at, match_notes, accepted_count, rejected_count,
        analysis_json, manifest_json, imported_at, imported_by
      FROM video_analysis_runs_legacy;
      INSERT INTO video_analysis_items (
        principal_sub, run_id, principal_email, item_index, accepted, kind,
        title, summary, importance, start_time, end_time, screenshot,
        candidate_json, result_json
      ) SELECT
        ${quotedPrincipal}, run_id, NULL, item_index, accepted, kind, title,
        summary, importance, start_time, end_time, screenshot, candidate_json,
        result_json
      FROM video_analysis_items_legacy;
      DROP TABLE analysis_items_legacy;
      DROP TABLE analysis_runs_legacy;
      DROP TABLE analysis_run_registry_legacy;
      DROP TABLE video_analysis_items_legacy;
      DROP TABLE video_analysis_runs_legacy;
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // The failing statement may already have rolled the transaction back.
    }
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

// Additive projection migration: older local databases predate the
// outcome_json column (CREATE TABLE IF NOT EXISTS cannot add columns to an
// existing table). The projection stays disposable; rows imported before the
// column simply carry NULL until their run is re-projected.
function ensureOutcomeColumn(
  database: Database,
  table: "analysis_runs" | "video_analysis_runs",
): void {
  const columns = database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  if (columns.some((column) => column.name === "outcome_json")) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN outcome_json TEXT;`);
}
