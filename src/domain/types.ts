import type { RunClock } from "./clock.js";
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
  | "repo-plan"
  | "communication-coaching"
  | "teaching-points";

export interface RecipeExemplar {
  verdict: "accepted" | "rejected";
  candidate: string;
  reason: string;
}

export interface RecipeCharter {
  stance: string;
  allowedQuestions: string[];
  acceptance: string;
  labelVocabulary: string[];
  exemplars: RecipeExemplar[];
  rejection: string;
  boundaries: string;
  phaseFocus?: {
    index?: string;
    interrogation?: string;
  };
}

export interface AnalysisRecipe {
  id: string;
  label: string;
  description: string;
  indexInstruction: string;
  interrogationInstruction: string;
  revision?: string;
  charter?: RecipeCharter;
  /**
   * Built-in recipes only; recipe files cannot set it (their schemas are
   * strict). "settled" lets the screenshot step prefer a steadier nearby frame;
   * absent means the direct seek to the cited time.
   */
  screenshotStrategy?: "settled";
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

export interface DerivedTranscriptionSegment {
  start: string;
  end: string;
  speaker: string;
  text: string;
}

export interface DerivedTranscriptProvenance {
  requestedLanguage?: string;
  origin: "gemini-audio";
  model: string;
  sha256: string;
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

export const THINKING_LEVELS = ["low", "medium", "high"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

interface RunManifestBase {
  clock?: RunClock;
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
  thinkingLevel?: ThinkingLevel;
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
  derivedTranscript?: DerivedTranscriptProvenance;
  promptProvenance?: PromptProvenance;
  /** Operator-supplied human label (`--label`). */
  label?: string;
  artifacts: string[];
}

export interface PromptProvenance {
  indexPrefixSha256: string;
  interrogationPrefixSha256: string;
  modelRouting: {
    requestedModel: string;
    reason: "operator-selected" | "default-flash" | "environment-or-dependency-override";
  };
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
