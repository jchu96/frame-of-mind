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
  analysis: {
    schemaVersion: 1;
    recipe: { id: string; label: string };
    meeting: {
      id: string;
      provider: "bluedot" | "granola" | "file";
      title?: string;
      createdAt?: string;
      sourceUrl?: string;
    };
    model: string;
    matchNotes: string;
    items: Array<{
      candidate: {
        start: string;
        end: string;
        speaker?: string;
        surface?: string;
        summary: string;
        kind: string;
        importance: "high" | "medium" | "low";
      };
      result: {
        accepted: boolean;
        kind: string;
        title: string;
        summary: string;
        details?: Array<{ label: string; value: string }>;
        where?: { appUrl?: string; step?: string; surface?: string };
        evidence?: {
          timestamp?: string;
          verbatimUiText?: string;
          reporterQuote?: string;
          speaker?: string;
        };
        steps?: string[];
        importance?: "high" | "medium" | "low";
        confidenceNotes?: string;
      };
      screenshot?: string;
    }>;
  };
  manifest: Record<string, unknown>;
}

export interface SessionInfo {
  authMode: "off" | "cloudflare-access";
  email?: string;
}
