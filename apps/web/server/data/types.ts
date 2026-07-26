import type { H3Event } from "h3";
import type { RunImport } from "#frame-contracts";
import type { RunPage, RunSummary, StoredRun } from "../../shared/types";

export interface ListRunsOptions {
  limit: number;
  cursor?: string;
}

export interface RunStore {
  listRuns(options: ListRunsOptions): Promise<RunPage>;
  getRun(runId: string): Promise<StoredRun | null>;
  importRun(input: RunImport, actor?: string): Promise<{ runId: string; created: boolean }>;
}

export function encodeRunCursor(row: RunSummaryRow): string {
  return encodeURIComponent(JSON.stringify([row.completed_at, row.imported_at, row.run_id]));
}

export function decodeRunCursor(value: string | undefined): [string, string, string] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed)
      && parsed.length === 3
      && parsed.every((part) => typeof part === "string" && part.length <= 240)
      ? parsed as [string, string, string]
      : undefined;
  } catch {
    return undefined;
  }
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

export type RunSummaryRow = Omit<
  RunRow,
  "match_notes" | "analysis_json" | "manifest_json"
>;

export function rowToSummary(row: RunSummaryRow): RunSummary {
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

export function assertStoredRunConsistency(
  row: RunRow,
  input: RunImport,
): void {
  const accepted = input.analysis.items.filter((item) => item.result.accepted).length;
  const mismatched =
    row.run_id !== input.manifest.runId
    || row.meeting_id !== input.analysis.meeting.id
    || row.meeting_title !== (input.analysis.meeting.title ?? null)
    || row.provider !== input.analysis.meeting.provider
    || row.transport !== input.manifest.contextTransport
    || row.recipe_id !== input.analysis.recipe.id
    || row.recipe_label !== input.analysis.recipe.label
    || row.model !== input.analysis.model
    || row.started_at !== input.manifest.startedAt
    || row.completed_at !== input.manifest.completedAt
    || row.match_notes !== input.analysis.matchNotes
    || row.accepted_count !== accepted
    || row.rejected_count !== input.analysis.items.length - accepted;
  if (mismatched) {
    throw new Error("Stored run projection does not match its authoritative run bundle.");
  }
}
