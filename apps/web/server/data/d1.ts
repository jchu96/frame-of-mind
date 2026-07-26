import type { H3Event } from "h3";
import { validateRunImport } from "../../../../src/domain/integrity";
import type { StoredRun } from "../../shared/types";
import {
  importValues,
  assertD1RunRowSize,
  insertItemsFromJsonSql,
  itemJsonBatches,
  runSummaryColumns,
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
  const supportedRun = `CASE
    WHEN json_valid(analysis_json) AND json_valid(manifest_json)
    THEN json_extract(analysis_json, '$.schemaVersion') = 2
      AND json_extract(manifest_json, '$.schemaVersion') = 2
    ELSE 0
  END`;
  return {
    async listRuns({ limit, cursor }) {
      const decoded = decodeRunCursor(cursor);
      const where = decoded
        ? `WHERE ${supportedRun} AND (
          completed_at < ?
          OR (completed_at = ? AND imported_at < ?)
          OR (completed_at = ? AND imported_at = ? AND run_id < ?)
        )`
        : `WHERE ${supportedRun}`;
      const statement = database.prepare(
        `SELECT ${runSummaryColumns} FROM analysis_runs
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
      const row = await database.prepare(
        `SELECT * FROM analysis_runs WHERE run_id = ? AND ${supportedRun}`,
      ).bind(runId).first<RunRow>();
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
      assertD1RunRowSize(validated, actor);
      const existing = await database.prepare(
        "SELECT 1 AS found FROM analysis_runs WHERE run_id = ?",
      ).bind(validated.manifest.runId).first<{ found: number }>();
      const statements = [
        database.prepare(upsertRunSql).bind(...importValues(validated, actor)),
        database.prepare("DELETE FROM analysis_items WHERE run_id = ?").bind(validated.manifest.runId),
      ];
      for (const batch of itemJsonBatches(validated.manifest.runId, validated.analysis.items)) {
        statements.push(database.prepare(insertItemsFromJsonSql).bind(batch));
      }
      await database.batch(statements);
      return { runId: validated.manifest.runId, created: !existing };
    },
  };
}
