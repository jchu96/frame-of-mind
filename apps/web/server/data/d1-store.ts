import {
  isRunImportV2,
  isRunImportV3,
} from "../../../../src/domain/schemas.js";
import { validateVersionedRunImport } from "../../../../src/domain/integrity.js";
import {
  importValues,
  importVideoValues,
  deleteItemsForRunSql,
  deleteVideoItemsForRunSql,
  assertD1RunRowSize,
  insertItemsFromJsonSql,
  insertVideoItemsFromJsonSql,
  itemJsonBatches,
  runSummaryColumns,
  supportedRunSummariesSql,
  upsertRunSql,
  upsertVideoRunSql,
} from "./sql.js";
import {
  decodeRunCursor,
  encodeRunCursor,
  storedRunFrom,
  rowToSummary,
  type RunRow,
  type RunSummaryRow,
  type RunPrincipal,
  type RunStore,
  RunPrincipalConflictError,
  RunProjectionVersionConflictError,
} from "./types.js";

export function createD1RunStore(
  database: D1Database,
  principal: RunPrincipal,
): RunStore {
  return {
    async listRuns({ limit, cursor }) {
      const decoded = decodeRunCursor(cursor);
      if (cursor && !decoded) throw new Error("run_cursor_invalid");
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
        ? statement.bind(
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
        : statement.bind(principal.principal, principal.principal, limit + 1)
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
         FROM analysis_runs WHERE principal_sub = ? AND run_id = ?
           AND json_valid(analysis_json) AND json_valid(manifest_json)
           AND json_extract(analysis_json, '$.schemaVersion') = 2
           AND json_extract(manifest_json, '$.schemaVersion') = 2`,
      ).bind(principal.principal, runId).first<RunRow>();
      const videoRow = await database.prepare(
        `SELECT 3 AS schema_version, 'none' AS context_mode,
           principal_sub, principal_email, run_id, NULL AS meeting_id,
           NULL AS meeting_title, NULL AS provider, NULL AS transport,
           recipe_id, recipe_label, model, started_at, completed_at,
           match_notes, accepted_count, rejected_count, analysis_json,
           manifest_json, outcome_json, imported_at, imported_by
         FROM video_analysis_runs WHERE principal_sub = ? AND run_id = ?
           AND json_valid(analysis_json) AND json_valid(manifest_json)
           AND json_extract(analysis_json, '$.schemaVersion') = 3
           AND json_extract(manifest_json, '$.schemaVersion') = 3`,
      ).bind(principal.principal, runId).first<RunRow>();
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
      assertD1RunRowSize(validated, principal.principal, principal.email, actor);
      const conflictingPrincipal = await database.prepare(`
        SELECT principal_sub FROM analysis_run_registry
        WHERE run_id = ? AND principal_sub <> ?
        UNION ALL
        SELECT principal_sub FROM analysis_runs
        WHERE run_id = ? AND principal_sub <> ?
        UNION ALL
        SELECT principal_sub FROM video_analysis_runs
        WHERE run_id = ? AND principal_sub <> ?
        LIMIT 1
      `).bind(
        validated.manifest.runId,
        principal.principal,
        validated.manifest.runId,
        principal.principal,
        validated.manifest.runId,
        principal.principal,
      ).first<{ principal_sub: string }>();
      if (conflictingPrincipal) throw new RunPrincipalConflictError();
      const existingMeeting = await database.prepare(
        "SELECT 1 AS found FROM analysis_runs WHERE principal_sub = ? AND run_id = ?",
      ).bind(principal.principal, validated.manifest.runId)
        .first<{ found: number }>();
      const existingVideo = await database.prepare(
        "SELECT 1 AS found FROM video_analysis_runs WHERE principal_sub = ? AND run_id = ?",
      ).bind(principal.principal, validated.manifest.runId)
        .first<{ found: number }>();
      if (
        (validated.analysis.schemaVersion === 2 && existingVideo)
        || (validated.analysis.schemaVersion === 3 && existingMeeting)
      ) throw new RunProjectionVersionConflictError();

      const statements: D1PreparedStatement[] = [
        database.prepare(
          `INSERT OR IGNORE INTO analysis_run_registry
            (principal_sub, run_id, principal_email, schema_version)
           VALUES (?, ?, ?, ?)`,
        ).bind(
          principal.principal,
          validated.manifest.runId,
          principal.email ?? null,
          validated.analysis.schemaVersion,
        ),
      ];
      if (isRunImportV2(validated)) {
        statements.push(
          database.prepare(upsertRunSql).bind(...importValues(
            validated,
            principal.principal,
            principal.email,
            actor,
          )),
          database.prepare(deleteItemsForRunSql)
            .bind(principal.principal, validated.manifest.runId),
        );
        for (
          const batch of itemJsonBatches(
            validated.manifest.runId,
            validated.analysis.items,
          )
        ) {
          statements.push(database.prepare(insertItemsFromJsonSql).bind(
            principal.principal,
            principal.email ?? null,
            batch,
          ));
        }
      } else if (isRunImportV3(validated)) {
        statements.push(
          database.prepare(upsertVideoRunSql).bind(...importVideoValues(
            validated,
            principal.principal,
            principal.email,
            actor,
          )),
          database.prepare(deleteVideoItemsForRunSql)
            .bind(principal.principal, validated.manifest.runId),
        );
        for (
          const batch of itemJsonBatches(
            validated.manifest.runId,
            validated.analysis.items,
          )
        ) {
          statements.push(database.prepare(insertVideoItemsFromJsonSql).bind(
            principal.principal,
            principal.email ?? null,
            batch,
          ));
        }
      } else {
        throw new Error("Run contract schema versions do not match.");
      }
      await database.batch(statements);
      const registration = await database.prepare(
        `SELECT schema_version FROM analysis_run_registry
         WHERE principal_sub = ? AND run_id = ?`,
      ).bind(principal.principal, validated.manifest.runId)
        .first<{ schema_version: number }>();
      if (registration?.schema_version !== validated.analysis.schemaVersion) {
        const owner = await database.prepare(
          `SELECT principal_sub FROM analysis_run_registry
           WHERE run_id = ? AND principal_sub <> ?`,
        ).bind(validated.manifest.runId, principal.principal)
          .first<{ principal_sub: string }>();
        if (owner) throw new RunPrincipalConflictError();
        throw new RunProjectionVersionConflictError();
      }
      return {
        runId: validated.manifest.runId,
        created: !(existingMeeting || existingVideo),
      };
    },
  };
}
