import type { H3Event } from "h3";
import type { RunImport } from "#frame-contracts";
import type { RunSummary, StoredRun } from "../../shared/types";

export interface RunStore {
  listRuns(): Promise<RunSummary[]>;
  getRun(runId: string): Promise<StoredRun | null>;
  importRun(input: RunImport, actor?: string): Promise<{ runId: string; created: boolean }>;
}

export type RunStoreFactory = (event: H3Event) => Promise<RunStore>;

export interface RunRow {
  run_id: string;
  meeting_id: string;
  meeting_title: string | null;
  provider: "bluedot" | "granola" | "file";
  transport: "mcp" | "api" | "file";
  recipe_id: string;
  recipe_label: string;
  model: string;
  started_at: string;
  completed_at: string;
  match_notes: string;
  accepted_count: number;
  rejected_count: number;
  analysis_json: string;
  manifest_json: string;
  imported_at: string;
  imported_by: string | null;
}

export function rowToSummary(row: RunRow): RunSummary {
  return {
    runId: row.run_id,
    meetingId: row.meeting_id,
    ...(row.meeting_title ? { meetingTitle: row.meeting_title } : {}),
    provider: row.provider,
    transport: row.transport,
    recipeId: row.recipe_id,
    recipeLabel: row.recipe_label,
    model: row.model,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    acceptedCount: row.accepted_count,
    rejectedCount: row.rejected_count,
    importedAt: row.imported_at,
    ...(row.imported_by ? { importedBy: row.imported_by } : {}),
  };
}
