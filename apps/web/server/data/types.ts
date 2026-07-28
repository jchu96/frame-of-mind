import type { H3Event } from "h3";
import {
  isRunImportV2,
  isRunImportV3,
  type VersionedRunImport,
} from "../../../../src/domain/schemas";
import type { RunPage, RunSummary, StoredRun } from "../../shared/types";

export interface ListRunsOptions {
  limit: number;
  cursor?: string;
}

export interface RunStore {
  listRuns(options: ListRunsOptions): Promise<RunPage>;
  getRun(runId: string): Promise<StoredRun | null>;
  importRun(input: VersionedRunImport, actor?: string): Promise<{ runId: string; created: boolean }>;
}

export class RunProjectionVersionConflictError extends Error {
  readonly code = "run_projection_version_conflict";

  constructor() {
    super("Run ID is already projected under another schema version.");
    this.name = "RunProjectionVersionConflictError";
  }
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
  schema_version: 2 | 3;
  context_mode: "meeting" | "none";
  run_id: string;
  meeting_id: string | null;
  meeting_title: string | null;
  provider: "bluedot" | "granola" | "file" | null;
  transport: "mcp" | "api" | "file" | null;
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
  const common = {
    runId: row.run_id,
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
  if (row.schema_version === 3 && row.context_mode === "none") {
    return { ...common, schemaVersion: 3, contextMode: "none" };
  }
  if (
    row.schema_version !== 2
    || row.context_mode !== "meeting"
    || !row.meeting_id
    || !row.provider
    || !row.transport
  ) {
    throw new Error("Stored run projection has invalid context columns.");
  }
  return {
    ...common,
    schemaVersion: 2,
    contextMode: "meeting",
    meetingId: row.meeting_id,
    ...(row.meeting_title ? { meetingTitle: row.meeting_title } : {}),
    provider: row.provider,
    transport: row.transport,
  };
}

export function assertStoredRunConsistency(
  row: RunRow,
  input: VersionedRunImport,
): void {
  const accepted = input.analysis.items.filter((item) => item.result.accepted).length;
  const commonMismatch =
    row.run_id !== input.manifest.runId
    || row.recipe_id !== input.analysis.recipe.id
    || row.recipe_label !== input.analysis.recipe.label
    || row.model !== input.analysis.model
    || row.started_at !== input.manifest.startedAt
    || row.completed_at !== input.manifest.completedAt
    || row.match_notes !== input.analysis.matchNotes
    || row.accepted_count !== accepted
    || row.rejected_count !== input.analysis.items.length - accepted;
  const contextMismatch = isRunImportV2(input)
    ? row.schema_version !== 2
      || row.context_mode !== "meeting"
      || row.meeting_id !== input.analysis.meeting.id
      || row.meeting_title !== (input.analysis.meeting.title ?? null)
      || row.provider !== input.analysis.meeting.provider
      || row.transport !== input.manifest.contextTransport
    : row.schema_version !== 3
      || row.context_mode !== "none"
      || row.meeting_id !== null
      || row.meeting_title !== null
      || row.provider !== null
      || row.transport !== null;
  if (commonMismatch || contextMismatch) {
    throw new Error("Stored run projection does not match its authoritative run bundle.");
  }
}

export function storedRunFrom(
  row: RunRow,
  input: VersionedRunImport,
): StoredRun {
  assertStoredRunConsistency(row, input);
  const summary = rowToSummary(row);
  if (summary.schemaVersion === 2 && isRunImportV2(input)) {
    return {
      ...summary,
      matchNotes: row.match_notes,
      analysis: input.analysis,
      manifest: input.manifest,
    };
  }
  if (summary.schemaVersion === 3 && isRunImportV3(input)) {
    return {
      ...summary,
      matchNotes: row.match_notes,
      analysis: input.analysis,
      manifest: input.manifest,
    };
  }
  throw new Error("Stored run projection schema does not match its bundle.");
}
