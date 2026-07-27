import type {
  AnalysisJob,
  AnalysisJobEvent,
  ConfigurationStatus,
  MediaCreateRequest,
  MediaPartReceipt,
  MediaSession,
  VerifiedImmutableJobInput,
} from "./studio-schemas.js";
import type {
  AnalysisJobStage,
} from "./studio-types.js";
import type { ValidatedMediaTransition } from "./studio-state.js";

export type BinaryChunkSource = AsyncIterable<Uint8Array>;

export type MediaSessionCreateInput = MediaCreateRequest;

export interface MediaPartInput {
  part: number;
  offset: number;
  contentLength: number;
  bytes: BinaryChunkSource;
}

export interface MediaPartWriteResult {
  session: MediaSession;
  receipt: MediaPartReceipt;
  replayed: boolean;
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
  ): Promise<MediaPartWriteResult>;
  seal(
    id: string,
    options?: { expectedSha256?: string; signal?: AbortSignal },
  ): Promise<MediaSealReceipt>;
  transition(
    transition: ValidatedMediaTransition,
  ): Promise<MediaSession>;
  abort(id: string): Promise<MediaSession>;
  delete(id: string): Promise<MediaSession>;
  expire(): Promise<MediaSession[]>;
  reconcile(): Promise<{
    repaired: string[];
    deleted: string[];
    failed: string[];
  }>;
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
  order?: "newest" | "oldest";
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
  code?: string;
  runId?: string;
  projectionWarning?: string;
}

export interface InitialJobCreateInput {
  idempotencyKey: string;
  verifiedInput: VerifiedImmutableJobInput;
  createdAt: string;
}

export interface LinkedRetryCreateInput {
  parentJobId: string;
  idempotencyKey: string;
  createdAt: string;
}

export type JobCreateResult =
  | { kind: "created"; job: AnalysisJob }
  | { kind: "replayed"; job: AnalysisJob };

export interface JobRepository {
  /**
   * Atomically creates an initial attempt or replays the existing job for the
   * same idempotency key and verified immutable input. Reusing a key for
   * different input must fail as an idempotency conflict.
   */
  createOrReplay(input: InitialJobCreateInput): Promise<JobCreateResult>;
  get(id: string): Promise<AnalysisJob | undefined>;
  list(query: JobListQuery): Promise<JobListPage>;
  events(jobId: string, afterSequence?: number): Promise<AnalysisJobEvent[]>;
  appendEvent(
    event: Omit<AnalysisJobEvent, "sequence">,
  ): Promise<AnalysisJobEvent>;
  transition(input: JobTransitionInput): Promise<AnalysisJob>;
  requestCancellation(jobId: string, requestedAt: string): Promise<AnalysisJob>;
  /**
   * Atomically loads the parent and derives retryOfJobId, rootJobId, attempt,
   * and immutable input. Callers cannot submit a fabricated retry job.
   */
  createLinkedRetry(input: LinkedRetryCreateInput): Promise<JobCreateResult>;
}

export type ProgressEventInput = AnalysisJobEvent extends infer Event
  ? Event extends AnalysisJobEvent
    ? Omit<Event, "sequence">
    : never
  : never;

export interface ProgressReporter {
  report(event: ProgressEventInput): Promise<void>;
}

export interface AnalysisJobExecutionResult {
  runId: string;
  projectionWarning?: string;
}

export class AnalysisExecutionIndeterminateError extends Error {
  constructor() {
    super(
      "Analysis execution completed without a trustworthy publication receipt.",
    );
    this.name = "AnalysisExecutionIndeterminateError";
  }
}

export interface AnalysisJobExecutor {
  /**
   * Executes a job after the local worker has atomically claimed it by moving
   * it from queued to fetching_context. Progress events must remain bound to
   * this job and must not repeat that initial claim or emit terminal stages.
   */
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
