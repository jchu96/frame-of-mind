export const ANALYSIS_JOB_STAGES = [
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
] as const;

export type AnalysisJobStage = (typeof ANALYSIS_JOB_STAGES)[number];

export const ANALYSIS_JOB_TERMINAL_STAGES = [
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
] as const;

export type AnalysisJobTerminalStage =
  (typeof ANALYSIS_JOB_TERMINAL_STAGES)[number];

export const MEDIA_SESSION_STATES = [
  "created",
  "uploading",
  "sealed",
  "in_use",
  "retained",
  "expired",
  "aborted",
  "deleting",
  "cleanup_failed",
  "deleted",
  "failed",
] as const;

export type MediaSessionState = (typeof MEDIA_SESSION_STATES)[number];

export interface IdempotentJobReference {
  jobId: string;
  idempotencyKey: string;
  inputDigest: string;
}

export interface IdempotentJobRequest {
  idempotencyKey: string;
  inputDigest: string;
}

export type IdempotencyResolution =
  | { kind: "create" }
  | { kind: "replay"; jobId: string };
