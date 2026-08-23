import type {
  AnalysisRun,
  AnalysisRunV3,
  RunManifest,
  RunManifestV3,
} from "../../../src/domain/types.js";

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
      schemaVersion: 2;
      contextMode: "meeting";
      meetingId: string;
      meetingTitle?: string;
      provider: "bluedot" | "granola" | "file";
      transport: "mcp" | "api" | "file";
    }
  | {
      schemaVersion: 3;
      contextMode: "none";
    }
);

export type StoredRun = RunSummaryBase & ({
  schemaVersion: 2;
  contextMode: "meeting";
  meetingId: string;
  meetingTitle?: string;
  provider: "bluedot" | "granola" | "file";
  transport: "mcp" | "api" | "file";
  matchNotes: string;
  analysis: AnalysisRun;
  manifest: RunManifest;
} | {
  schemaVersion: 3;
  contextMode: "none";
  matchNotes: string;
  analysis: AnalysisRunV3;
  manifest: RunManifestV3;
});

export interface RunPage {
  runs: RunSummary[];
  nextCursor?: string;
}

export interface SessionInfo {
  authMode:
    | "off"
    | "cloudflare-access"
    | "better-auth"
    | "cloudflare-access+better-auth";
  email?: string;
}
