import { isMeetingRunImport, isVideoRunImport, type VersionedRunImport } from "./schemas.js";
import { validateVersionedRunImport } from "./integrity.js";

import type {
  AnalysisRun,
  AnalysisRunV3, AnalysisRunV4, AnalysisRunV5,
  RunManifest,
  RunManifestV3,
} from "./types.js";
import type { AnalysisOutcome } from "./analysis-outcome.js";

interface RunSummaryBase {
  runId: string;
  recipeId: string;
  recipeLabel: string;
  model: string;
  startedAt: string;
  completedAt: string;
  acceptedCount: number;
  rejectedCount: number;
  importedAt: string;
  importedBy?: string;
}

export type RunSummary = RunSummaryBase & (
  | {
      schemaVersion: 2 | 4;
      contextMode: "meeting";
      meetingId: string;
      meetingTitle?: string;
      provider: "bluedot" | "granola" | "file";
      transport: "mcp" | "api" | "file";
    }
  | {
      schemaVersion: 3 | 5;
      contextMode: "none";
    }
);

export type StoredRun = RunSummaryBase & ({
  schemaVersion: 2 | 4;
  contextMode: "meeting";
  meetingId: string;
  meetingTitle?: string;
  provider: "bluedot" | "granola" | "file";
  transport: "mcp" | "api" | "file";
  matchNotes: string;
  analysis: AnalysisRun | AnalysisRunV4;
  manifest: RunManifest;
  outcome?: AnalysisOutcome;
} | {
  schemaVersion: 3 | 5;
  contextMode: "none";
  matchNotes: string;
  analysis: AnalysisRunV3 | AnalysisRunV5;
  manifest: RunManifestV3;
  outcome?: AnalysisOutcome;
});

export interface RunPage {
  runs: RunSummary[];
  nextCursor?: string;
}

export interface ListRunsOptions {
  limit: number;
  cursor?: string;
}

export interface RunStore {
  listRuns(options: ListRunsOptions): Promise<RunPage>;
  getRun(runId: string): Promise<StoredRun | null>;
  importRun(input: VersionedRunImport, actor?: string): Promise<{ runId: string; created: boolean }>;
}

export interface RunPrincipal {
  principal: string;
  email?: string;
}

export const LOCAL_SINGLE_USER_PRINCIPAL: RunPrincipal = {
  principal: "local:single-user",
};

export interface RunRow {
  principal_sub: string;
  principal_email: string | null;
  schema_version: 2 | 3 | 4 | 5;
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
  outcome_json: string | null;
  imported_at: string;
  imported_by: string | null;
}

export type RunSummaryRow = Omit<
  RunRow,
  | "principal_sub"
  | "principal_email"
  | "match_notes"
  | "analysis_json"
  | "manifest_json"
  | "outcome_json"
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
  if ((row.schema_version === 3 || row.schema_version === 5) && row.context_mode === "none") {
    return { ...common, schemaVersion: row.schema_version, contextMode: "none" };
  }
  if (
    (row.schema_version !== 2 && row.schema_version !== 4)
    || row.context_mode !== "meeting"
    || !row.meeting_id
    || !row.provider
    || !row.transport
  ) {
    throw new Error("Stored run projection has invalid context columns.");
  }
  return {
    ...common,
    schemaVersion: row.schema_version,
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
  const contextMismatch = isMeetingRunImport(input)
    ? row.schema_version !== input.analysis.schemaVersion
      || row.context_mode !== "meeting"
      || row.meeting_id !== input.analysis.meeting.id
      || row.meeting_title !== (input.analysis.meeting.title ?? null)
      || row.provider !== input.analysis.meeting.provider
      || row.transport !== input.manifest.contextTransport
    : row.schema_version !== input.analysis.schemaVersion
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
  if (summary.contextMode === "meeting" && isMeetingRunImport(input)) {
    return {
      ...summary,
      matchNotes: row.match_notes,
      analysis: input.analysis,
      manifest: input.manifest,
      ...(input.outcome ? { outcome: input.outcome } : {}),
    };
  }
  if (summary.contextMode === "none" && isVideoRunImport(input)) {
    return {
      ...summary,
      matchNotes: row.match_notes,
      analysis: input.analysis,
      manifest: input.manifest,
      ...(input.outcome ? { outcome: input.outcome } : {}),
    };
  }
  throw new Error("Stored run projection schema does not match its bundle.");
}

export async function validatedStoredRun(row: RunRow): Promise<StoredRun> {
  const input = await validateVersionedRunImport({
    analysis: JSON.parse(row.analysis_json),
    manifest: JSON.parse(row.manifest_json),
    ...(row.outcome_json !== null ? { outcome: JSON.parse(row.outcome_json) } : {}),
  });
  return storedRunFrom(row, input);
}
