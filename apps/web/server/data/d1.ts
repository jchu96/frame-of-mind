import type { H3Event } from "h3";
import { analysisRunSchema, runManifestSchema } from "../../../../src/domain/schemas";
import type { StoredRun } from "../../shared/types";
import { importValues, insertItemSql, itemValues, upsertRunSql } from "./sql";
import { rowToSummary, type RunRow, type RunStore } from "./types";

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
    async listRuns() {
      const result = await database.prepare(
        "SELECT * FROM analysis_runs ORDER BY completed_at DESC, imported_at DESC",
      ).all<RunRow>();
      return result.results.map(rowToSummary);
    },

    async getRun(runId) {
      const row = await database.prepare(
        "SELECT * FROM analysis_runs WHERE run_id = ?",
      ).bind(runId).first<RunRow>();
      if (!row) return null;
      return {
        ...rowToSummary(row),
        matchNotes: row.match_notes,
        analysis: analysisRunSchema.parse(JSON.parse(row.analysis_json)),
        manifest: runManifestSchema.parse(JSON.parse(row.manifest_json)),
      } satisfies StoredRun;
    },

    async importRun(input, actor) {
      const existing = await database.prepare(
        "SELECT 1 AS found FROM analysis_runs WHERE run_id = ?",
      ).bind(input.manifest.runId).first<{ found: number }>();
      const statements = [
        database.prepare(upsertRunSql).bind(...importValues(input, actor)),
        database.prepare("DELETE FROM analysis_items WHERE run_id = ?").bind(input.manifest.runId),
        ...input.analysis.items.map((item, index) =>
          database.prepare(insertItemSql).bind(
            ...itemValues(input.manifest.runId, item, index),
          )),
      ];
      await database.batch(statements);
      return { runId: input.manifest.runId, created: !existing };
    },
  };
}
