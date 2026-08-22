import type {
  AnalysisJob,
  AnalysisJobEvent,
  MediaSession,
} from "../../../../src/domain/studio-schemas.js";
import type { AnalysisJobStage } from "../../../../src/domain/studio-types.js";

const SUPPORT_RECEIPT_FORMAT_VERSION = 1 as const;
const safeStages = new Set<AnalysisJobStage>([
  "queued",
  "fetching_context",
  "uploading_to_gemini",
  "indexing",
  "interrogating",
  "rendering",
  "cleaning_up",
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
]);

export type ActivityTechnicalStage = AnalysisJobStage | "unknown";
export type ActivityCleanupState =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "retained"
  | "not_found"
  | "unavailable";

export interface ActivityStageDuration {
  stage: AnalysisJobStage;
  seconds: number;
}

export interface ActivityTechnicalDetails {
  formatVersion: typeof SUPPORT_RECEIPT_FORMAT_VERSION;
  jobId: string;
  stage: ActivityTechnicalStage;
  terminalCode: string;
  timestamps: {
    createdAt: string | null;
    updatedAt: string | null;
    terminalAt: string | null;
    cancellationRequestedAt: string | null;
  };
  stageDurations: ActivityStageDuration[];
  providerId: string;
  recipeId: string;
  mediaRetentionState: "ephemeral" | "retained" | "unknown";
  mediaRetentionExpiresAt: string | null;
  cleanupState: ActivityCleanupState;
}

export interface ActivityTechnicalDetailsInput {
  job: AnalysisJob;
  events: readonly AnalysisJobEvent[];
  media: MediaSession | null | undefined;
}

export function buildActivityTechnicalDetails(
  input: ActivityTechnicalDetailsInput,
): ActivityTechnicalDetails {
  const { job } = input;
  const createdAt = normalizeTimestamp(job.createdAt);
  const updatedAt = normalizeTimestamp(job.updatedAt);

  // Construct a fresh closed projection. Never spread a job, event, media
  // receipt, or provider-shaped object into operator-visible diagnostics.
  return {
    formatVersion: SUPPORT_RECEIPT_FORMAT_VERSION,
    jobId: safeIdentifier(job.id),
    stage: safeStage(job.stage),
    terminalCode: safeTerminalCode(job.terminal?.code),
    timestamps: {
      createdAt,
      updatedAt,
      terminalAt: normalizeTimestamp(job.terminal?.at),
      cancellationRequestedAt: normalizeTimestamp(job.cancellationRequestedAt),
    },
    stageDurations: deriveStageDurations(
      job,
      input.events,
      createdAt,
      updatedAt,
    ),
    providerId: safeProviderId(job),
    recipeId: safeIdentifier(job.input.recipe.id),
    mediaRetentionState: safeRetentionState(job.input.retention.mode),
    mediaRetentionExpiresAt: normalizeTimestamp(job.input.retention.expiresAt),
    cleanupState: cleanupState(input.media),
  };
}

export function formatActivitySupportReceipt(
  details: ActivityTechnicalDetails,
): string {
  const lines = [
    `Frame of Mind support receipt v${details.formatVersion}`,
    `job_id=${details.jobId}`,
    `stage=${details.stage}`,
    `terminal_code=${details.terminalCode}`,
    `created_at=${timestampValue(details.timestamps.createdAt)}`,
    `updated_at=${timestampValue(details.timestamps.updatedAt)}`,
    `terminal_at=${timestampValue(details.timestamps.terminalAt)}`,
    `cancellation_requested_at=${timestampValue(details.timestamps.cancellationRequestedAt)}`,
    `provider_id=${details.providerId}`,
    `recipe_id=${details.recipeId}`,
    `media_retention_state=${details.mediaRetentionState}`,
    `media_retention_expires_at=${timestampValue(details.mediaRetentionExpiresAt)}`,
    `cleanup_state=${details.cleanupState}`,
    ...details.stageDurations.map(({ stage, seconds }) =>
      `stage_duration.${stage}_seconds=${seconds}`
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function deriveStageDurations(
  job: AnalysisJob,
  events: readonly AnalysisJobEvent[],
  createdAt: string | null,
  updatedAt: string | null,
): ActivityStageDuration[] {
  if (!createdAt || !updatedAt) return [];
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (end < start) return [];

  const transitions = events
    .filter((event): event is Extract<AnalysisJobEvent, { kind: "transition" }> =>
      event.kind === "transition"
      && event.jobId === job.id
      && event.attempt === job.attempt
      && safeStages.has(event.previousStage)
      && safeStages.has(event.stage)
      && normalizeTimestamp(event.occurredAt) !== null
    )
    .slice()
    .sort((left, right) =>
      Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
      || left.sequence - right.sequence
    );

  const durations: ActivityStageDuration[] = [];
  let currentStage: AnalysisJobStage = "queued";
  let currentStart = start;
  for (const transition of transitions) {
    const occurredAt = Date.parse(transition.occurredAt);
    if (
      transition.previousStage !== currentStage
      || occurredAt < currentStart
      || occurredAt > end
    ) continue;
    durations.push({
      stage: currentStage,
      seconds: wholeSeconds(currentStart, occurredAt),
    });
    currentStage = transition.stage;
    currentStart = occurredAt;
  }
  durations.push({
    stage: currentStage,
    seconds: wholeSeconds(currentStart, end),
  });
  return durations;
}

function wholeSeconds(start: number, end: number): number {
  return Math.max(0, Math.floor((end - start) / 1_000));
}

function safeStage(value: unknown): ActivityTechnicalStage {
  return typeof value === "string" && safeStages.has(value as AnalysisJobStage)
    ? value as AnalysisJobStage
    : "unknown";
}

function safeIdentifier(value: unknown): string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value)
    ? value
    : "unknown";
}

function safeTerminalCode(value: unknown): string {
  return typeof value === "string"
    && /^[a-z0-9_:-]{1,120}$/.test(value)
    ? value
    : "none";
}

function safeProviderId(job: AnalysisJob): string {
  const context = job.input.context as unknown;
  if (!context || typeof context !== "object") return "unknown";
  if ((context as { mode?: unknown }).mode === "none") return "none";
  const provider = (context as { provider?: unknown }).provider;
  return provider === "bluedot" || provider === "granola" || provider === "file"
    ? provider
    : "unknown";
}

function safeRetentionState(
  value: unknown,
): ActivityTechnicalDetails["mediaRetentionState"] {
  return value === "ephemeral" || value === "retained" ? value : "unknown";
}

function cleanupState(
  media: MediaSession | null | undefined,
): ActivityCleanupState {
  if (media === undefined) return "unavailable";
  if (media === null) return "not_found";
  if (media.status === "cleanup_failed" || media.status === "failed") return "failed";
  if (media.status === "deleted" || media.status === "aborted") {
    return "completed";
  }
  if (media.status === "expired" || media.status === "deleting") return "in_progress";
  if (media.status === "retained") return "retained";
  return "pending";
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function timestampValue(value: string | null): string {
  return value ?? "none";
}
