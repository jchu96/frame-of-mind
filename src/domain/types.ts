export type JsonObject = Record<string, unknown>;

export interface MeetingEvidence {
  id: string;
  provider: ContextProvider;
  transport: "mcp" | "api" | "file";
  title?: string;
  createdAt?: string;
  sourceUrl?: string;
  summary?: string;
  transcript: string;
  raw: unknown;
}

export type ContextProvider = "bluedot" | "granola" | "file";

export type BuiltInRecipeId =
  | "issue-review"
  | "decisions"
  | "requirements"
  | "action-items"
  | "repo-plan";

export interface AnalysisRecipe {
  id: string;
  label: string;
  description: string;
  indexInstruction: string;
  interrogationInstruction: string;
  revision?: string;
}

export interface MeetingContextSource {
  readonly provider: ContextProvider;
  connect(): Promise<void>;
  close(): Promise<void>;
  meeting(meetingId: string): Promise<MeetingEvidence>;
}

export interface MediaSource {
  url: string;
  mimeType?: string;
  source: "mcp" | "override";
}

export interface IndexedMoment {
  start: string;
  end: string;
  speaker?: string;
  surface?: string;
  summary: string;
  kind: string;
  importance: "high" | "medium" | "low";
}

export interface AnalysisDetail {
  accepted: boolean;
  kind: string;
  title: string;
  summary: string;
  details?: Array<{
    label: string;
    value: string;
  }>;
  where?: {
    appUrl?: string;
    step?: string;
    surface?: string;
  };
  evidence?: {
    timestamp?: string;
    verbatimUiText?: string;
    reporterQuote?: string;
    speaker?: string;
  };
  steps?: string[];
  importance?: "high" | "medium" | "low";
  confidenceNotes?: string;
}

export interface AnalysisItem {
  candidate: IndexedMoment;
  result: AnalysisDetail;
  screenshot?: string;
}

export interface AnalysisRun {
  schemaVersion: 2;
  runId: string;
  recipe: {
    id: string;
    label: string;
  };
  meeting: {
    id: string;
    provider: ContextProvider;
    title?: string;
    createdAt?: string;
    sourceUrl?: string;
  };
  model: string;
  matchNotes: string;
  items: AnalysisItem[];
}

export interface RunManifest {
  schemaVersion: 2;
  toolVersion: string;
  promptRevision: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  meetingId: string;
  recipe: {
    id: string;
    label: string;
    custom: boolean;
    revision: string;
    sha256: string;
  };
  model: string;
  recordingSha256: string;
  transcriptSha256: string;
  analysisSha256: string;
  recordingMimeType: string;
  contextProvider: ContextProvider;
  contextTransport: "mcp" | "api" | "file";
  mediaSource: "bluedot-mcp" | "signed-url" | "local-file";
  transcriptAlignment: {
    offsetSeconds: number;
    method: "explicit" | "model" | "none";
    confidence: "high" | "medium" | "low" | "none";
    rationale?: string;
  };
  remoteFile?: {
    name?: string;
    expirationTime?: string;
    deleted: boolean;
  };
  analysis: {
    focus?: string;
    maxIncidents: number;
    indexFps: number;
    indexResolution: "low";
    interrogationResolution: "medium";
  };
  artifacts: string[];
}
