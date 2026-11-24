import type { Database } from "bun:sqlite";
import { validatedStoredRun, type RunPrincipal, type RunRow, type RunStore } from "../domain/run-store.js";

export const sharedRunColumns = "principal_sub, principal_email, run_id, recipe_id, recipe_label, model, started_at, completed_at, match_notes, accepted_count, rejected_count, analysis_json, manifest_json, outcome_json, imported_at, imported_by";
export const meetingColumns = "meeting_id, meeting_title, provider, transport";

// The web store hides unsupported legacy rows. A snapshot must resolve every verified registration.
export function sqliteRunLookup(database: Database, { principal }: RunPrincipal,
  registrations?: ReadonlyMap<string, number>): Pick<RunStore, "getRun"> {
  function statement(version: 2 | 3) {
    const meeting = version === 2;
    const context = meeting ? meetingColumns : "NULL AS meeting_id, NULL AS meeting_title, NULL AS provider, NULL AS transport";
    const table = meeting ? "analysis_runs" : "video_analysis_runs";
    return database.query<RunRow, [string, string]>(
      `SELECT ${version} AS schema_version, '${meeting ? "meeting" : "none"}' AS context_mode, ${sharedRunColumns}, ${context}
       FROM main.${table} WHERE principal_sub COLLATE BINARY = ? AND run_id COLLATE BINARY = ?
       AND json_valid(analysis_json) AND json_valid(manifest_json)
       AND json_extract(analysis_json, '$.schemaVersion') = ${version}
       AND json_extract(manifest_json, '$.schemaVersion') = ${version}`,
    );
  }
  const meeting = statement(2);
  const video = statement(3);
  return {
    async getRun(runId) {
      const version = registrations?.get(runId);
      const meetingRow = !registrations || version === 2 ? meeting.get(principal, runId) : null;
      const videoRow = !registrations || version === 3 ? video.get(principal, runId) : null;
      if (meetingRow && videoRow) throw new Error("Run ID exists in multiple projection schema tables.");
      const row = meetingRow ?? videoRow;
      if (!row) return null;
      if (row.principal_sub !== principal || row.run_id !== runId) throw new Error("Stored run identity mismatch.");
      return validatedStoredRun(row);
    },
  };
}
