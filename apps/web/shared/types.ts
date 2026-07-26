export interface RunSummary {
  runId: string;
  meetingId: string;
  meetingTitle?: string;
  provider: "bluedot" | "granola" | "file";
  transport: "mcp" | "api" | "file";
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

export interface StoredRun extends RunSummary {
  matchNotes: string;
  analysis: AnalysisRun;
  manifest: RunManifest;
}

export interface RunPage {
  runs: RunSummary[];
  nextCursor?: string;
}

export interface SessionInfo {
  authMode: "off" | "cloudflare-access";
  email?: string;
}
import type { AnalysisRun, RunManifest } from "../../../src/domain/types";
