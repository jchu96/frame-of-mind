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

interface AnalysisRunBase {
  runId: string;
  recipe: {
    id: string;
    label: string;
  };
  model: string;
  matchNotes: string;
  items: AnalysisItem[];
}

export interface AnalysisRun extends AnalysisRunBase {
  schemaVersion: 2;
  meeting: {
    id: string;
    provider: ContextProvider;
    title?: string;
    createdAt?: string;
    sourceUrl?: string;
  };
}

export interface AnalysisRunV3 extends AnalysisRunBase {
  schemaVersion: 3;
  context: {
    mode: "none";
  };
}

export type VersionedAnalysisRun = AnalysisRun | AnalysisRunV3;

interface RunManifestBase {
  toolVersion: string;
  promptRevision: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  recipe: {
    id: string;
    label: string;
    custom: boolean;
    revision: string;
    sha256: string;
  };
  model: string;
  recordingSha256: string;
  analysisSha256: string;
  recordingMimeType: string;
  mediaSource: "bluedot-mcp" | "signed-url" | "local-file";
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

export interface RunManifest extends RunManifestBase {
  schemaVersion: 2;
  meetingId: string;
  transcriptSha256: string;
  contextProvider: ContextProvider;
  contextTransport: "mcp" | "api" | "file";
  transcriptAlignment: {
    offsetSeconds: number;
    method: "explicit" | "model" | "none";
    confidence: "high" | "medium" | "low" | "none";
    rationale?: string;
  };
}

export interface RunManifestV3 extends RunManifestBase {
  schemaVersion: 3;
  context: {
    mode: "none";
  };
  mediaSource: "local-file";
}

export type VersionedRunManifest = RunManifest | RunManifestV3;
