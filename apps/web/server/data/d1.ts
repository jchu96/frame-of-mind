import type { H3Event } from "h3";
import {
  isRunImportV2,
  isRunImportV3,
} from "../../../../src/domain/schemas";
import { validateVersionedRunImport } from "../../../../src/domain/integrity";
import {
  importValues,
  importVideoValues,
  assertD1RunRowSize,
  insertItemsFromJsonSql,
  insertVideoItemsFromJsonSql,
  itemJsonBatches,
  runSummaryColumns,
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
} from "./types";

export async function getRunStore(event: H3Event): Promise<RunStore> {
  const database = event.context.cloudflare?.env.DB;
  if (!database) {
    throw createError({
      statusCode: 503,
      statusMessage: "D1 binding DB is required for hosted mode.",
    });
  }
  return createD1RunStore(database);
}

export function createD1RunStore(database: D1Database): RunStore {
  return {
    async listRuns({ limit, cursor }) {
      const decoded = decodeRunCursor(cursor);
      const where = decoded
        ? `WHERE (
          completed_at < ?
          OR (completed_at = ? AND imported_at < ?)
          OR (completed_at = ? AND imported_at = ? AND run_id < ?)
        )`
        : "";
      const statement = database.prepare(
        `SELECT ${runSummaryColumns} FROM (${supportedRunSummariesSql}) AS supported_runs
         ${where}
         ORDER BY completed_at DESC, imported_at DESC, run_id DESC LIMIT ?`,
      );
      const result = await (decoded
        ? statement.bind(decoded[0], decoded[0], decoded[1], decoded[0], decoded[1], decoded[2], limit + 1)
        : statement.bind(limit + 1)
      ).all<RunSummaryRow>();
      const page = result.results.slice(0, limit);
      return {
        runs: page.map(rowToSummary),
        ...(result.results.length > limit && page.length
          ? { nextCursor: encodeRunCursor(page[page.length - 1]!) }
          : {}),
      };
    },

    async getRun(runId) {
      const meetingRow = await database.prepare(
        `SELECT 2 AS schema_version, 'meeting' AS context_mode, *
         FROM analysis_runs WHERE run_id = ?
           AND json_valid(analysis_json) AND json_valid(manifest_json)
           AND json_extract(analysis_json, '$.schemaVersion') = 2
           AND json_extract(manifest_json, '$.schemaVersion') = 2`,
      ).bind(runId).first<RunRow>();
      const videoRow = await database.prepare(
        `SELECT 3 AS schema_version, 'none' AS context_mode,
           run_id, NULL AS meeting_id, NULL AS meeting_title,
           NULL AS provider, NULL AS transport, recipe_id, recipe_label,
           model, started_at, completed_at, match_notes, accepted_count,
           rejected_count, analysis_json, manifest_json, imported_at, imported_by
         FROM video_analysis_runs WHERE run_id = ?
           AND json_valid(analysis_json) AND json_valid(manifest_json)
           AND json_extract(analysis_json, '$.schemaVersion') = 3
           AND json_extract(manifest_json, '$.schemaVersion') = 3`,
      ).bind(runId).first<RunRow>();
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
      assertD1RunRowSize(validated, actor);
      const existingMeeting = await database.prepare(
        "SELECT 1 AS found FROM analysis_runs WHERE run_id = ?",
      ).bind(validated.manifest.runId).first<{ found: number }>();
      const existingVideo = await database.prepare(
        "SELECT 1 AS found FROM video_analysis_runs WHERE run_id = ?",
      ).bind(validated.manifest.runId).first<{ found: number }>();
      if (
        (validated.analysis.schemaVersion === 2 && existingVideo)
        || (validated.analysis.schemaVersion === 3 && existingMeeting)
      ) {
        throw new Error("Run ID is already projected under another schema version.");
      }
      const statements: D1PreparedStatement[] = [
        database.prepare(
          "INSERT OR IGNORE INTO analysis_run_registry (run_id, schema_version) VALUES (?, ?)",
        ).bind(validated.manifest.runId, validated.analysis.schemaVersion),
      ];
      if (isRunImportV2(validated)) {
        statements.push(
          database.prepare(upsertRunSql).bind(...importValues(validated, actor)),
          database.prepare("DELETE FROM analysis_items WHERE run_id = ?")
            .bind(validated.manifest.runId),
        );
        for (const batch of itemJsonBatches(validated.manifest.runId, validated.analysis.items)) {
          statements.push(database.prepare(insertItemsFromJsonSql).bind(batch));
        }
      } else if (isRunImportV3(validated)) {
        statements.push(
          database.prepare(upsertVideoRunSql).bind(...importVideoValues(validated, actor)),
          database.prepare("DELETE FROM video_analysis_items WHERE run_id = ?")
            .bind(validated.manifest.runId),
        );
        for (const batch of itemJsonBatches(validated.manifest.runId, validated.analysis.items)) {
          statements.push(database.prepare(insertVideoItemsFromJsonSql).bind(batch));
        }
      } else {
        throw new Error("Run contract schema versions do not match.");
      }
      await database.batch(statements);
      const registration = await database.prepare(
        "SELECT schema_version FROM analysis_run_registry WHERE run_id = ?",
      ).bind(validated.manifest.runId).first<{ schema_version: number }>();
      if (registration?.schema_version !== validated.analysis.schemaVersion) {
        throw new Error("Run ID is already projected under another schema version.");
      }
      return {
        runId: validated.manifest.runId,
        created: !(existingMeeting || existingVideo),
      };
    },
  };
}
