import type {
  AnalysisJob,
  AnalysisJobEvent,
  ComposerPayload,
  ConfigurationStatus,
  MediaSession,
} from "./studio-schemas.js";
import type {
  AnalysisJobStage,
  MediaSessionState,
} from "./studio-types.js";

export type BinaryChunkSource = AsyncIterable<Uint8Array>;

export interface MediaSessionCreateInput {
  expectedBytes: number;
  mimeType: string;
  retention: ComposerPayload["retention"];
}

export interface MediaPartInput {
  part: number;
  offset: number;
  bytes: Uint8Array;
}

export interface MediaSealReceipt {
  mediaSessionId: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  sealedAt: string;
}

export interface MediaStagingAdapter {
  create(
    input: MediaSessionCreateInput,
    options?: { signal?: AbortSignal },
  ): Promise<MediaSession>;
  get(id: string): Promise<MediaSession | undefined>;
  writePart(
    id: string,
    input: MediaPartInput,
    options?: { signal?: AbortSignal },
  ): Promise<MediaSession>;
  seal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<MediaSealReceipt>;
  transition(
    id: string,
    expected: MediaSessionState,
    next: MediaSessionState,
  ): Promise<MediaSession>;
  abort(id: string): Promise<MediaSession>;
  delete(id: string): Promise<void>;
}

export type ContextFileFormat = "json" | "text" | "markdown" | "srt" | "vtt";

export interface ContextFileCreateInput {
  format: ContextFileFormat;
  expectedBytes: number;
  bytes: BinaryChunkSource;
}

export interface ContextFileReceipt {
  id: string;
  format: ContextFileFormat;
  bytes: number;
  sha256: string;
  expiresAt: string;
}

export interface ContextFileStagingAdapter {
  stage(
    input: ContextFileCreateInput,
    options?: { signal?: AbortSignal },
  ): Promise<ContextFileReceipt>;
  get(id: string): Promise<ContextFileReceipt | undefined>;
  delete(id: string): Promise<void>;
}

export interface JobListQuery {
  cursor?: string;
  limit: number;
  stages?: AnalysisJobStage[];
}

export interface JobListPage {
  jobs: AnalysisJob[];
  nextCursor?: string;
}

export interface JobTransitionInput {
  jobId: string;
  expectedStage: AnalysisJobStage;
  nextStage: AnalysisJobStage;
  occurredAt: string;
  message?: string;
}

export interface JobRepository {
  create(job: AnalysisJob): Promise<AnalysisJob>;
  get(id: string): Promise<AnalysisJob | undefined>;
  findByIdempotencyKey(key: string): Promise<AnalysisJob | undefined>;
  list(query: JobListQuery): Promise<JobListPage>;
  events(jobId: string, afterSequence?: number): Promise<AnalysisJobEvent[]>;
  appendEvent(
    event: Omit<AnalysisJobEvent, "sequence">,
  ): Promise<AnalysisJobEvent>;
  transition(input: JobTransitionInput): Promise<AnalysisJob>;
  requestCancellation(jobId: string, requestedAt: string): Promise<AnalysisJob>;
  createRetry(job: AnalysisJob): Promise<AnalysisJob>;
}

export interface ProgressEventInput {
  jobId: string;
  attempt: number;
  kind: AnalysisJobEvent["kind"];
  stage: AnalysisJobStage;
  previousStage?: AnalysisJobStage;
  occurredAt: string;
  message?: string;
  progress?: AnalysisJobEvent["progress"];
}

export interface ProgressReporter {
  report(event: ProgressEventInput): Promise<void>;
}

export interface AnalysisJobExecutionResult {
  runId: string;
  projectionWarning?: string;
}

export interface AnalysisJobExecutor {
  execute(
    job: AnalysisJob,
    options: {
      signal: AbortSignal;
      progress: ProgressReporter;
    },
  ): Promise<AnalysisJobExecutionResult>;
}

export type RuntimeSecretName = "gemini-api-key" | "granola-api-key";
export type RuntimeSecretSource = "environment" | "session" | "none";

export interface RuntimeSecretPresence {
  name: RuntimeSecretName;
  present: boolean;
  source: RuntimeSecretSource;
}

export interface RuntimeSecretResolver {
  resolve(name: RuntimeSecretName): Promise<string | undefined>;
  status(name: RuntimeSecretName): Promise<RuntimeSecretPresence>;
  setSession(name: RuntimeSecretName, value: string): Promise<void>;
  clearSession(name: RuntimeSecretName): Promise<void>;
}

export interface MeetingCatalogItem {
  id: string;
  title?: string;
  createdAt?: string;
}

export interface MeetingCatalogPage {
  items: MeetingCatalogItem[];
  nextCursor?: string;
}

export interface MeetingCatalogSource {
  search(input: {
    query?: string;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<MeetingCatalogPage>;
}

export interface StudioConfigurationReader {
  status(): Promise<ConfigurationStatus>;
}
