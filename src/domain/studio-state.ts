import {
  ANALYSIS_JOB_STAGES,
  ANALYSIS_JOB_TERMINAL_STAGES,
  type AnalysisJobStage,
  type IdempotencyResolution,
  type IdempotentJobReference,
  type IdempotentJobRequest,
  type MediaSessionState,
} from "./studio-types.js";
import {
  parseOpaqueResourceId,
  type OpaqueResourceId,
} from "./studio-identifiers.js";

export {
  ANALYSIS_JOB_STAGES,
  ANALYSIS_JOB_TERMINAL_STAGES,
} from "./studio-types.js";

const terminalStages = new Set<AnalysisJobStage>(
  ANALYSIS_JOB_TERMINAL_STAGES,
);

const terminalMediaStates = new Set<MediaSessionState>(["deleted", "failed"]);

const forwardStage: Partial<Record<AnalysisJobStage, AnalysisJobStage>> = {
  queued: "fetching_context",
  fetching_context: "uploading_to_gemini",
  uploading_to_gemini: "indexing",
  indexing: "interrogating",
  interrogating: "rendering",
  rendering: "cleaning_up",
};

const mediaTransitions: Partial<
  Record<MediaSessionState, readonly MediaSessionState[]>
> = {
  created: ["uploading", "aborted", "expired", "failed"],
  uploading: ["sealed", "aborted", "expired", "failed"],
  sealed: ["in_use", "expired", "deleting", "failed"],
  in_use: ["retained", "deleting", "failed"],
  retained: ["in_use", "expired", "deleting", "failed"],
  expired: ["deleting", "failed"],
  aborted: ["deleting", "failed"],
  deleting: ["deleted", "cleanup_failed", "failed"],
  cleanup_failed: ["deleting"],
};

const validatedMediaTransitionBrand: unique symbol = Symbol(
  "validatedMediaTransition",
);

export interface ValidatedMediaTransition {
  id: OpaqueResourceId;
  expected: MediaSessionState;
  next: MediaSessionState;
  readonly [validatedMediaTransitionBrand]: true;
}

export function isAnalysisJobTerminal(
  stage: AnalysisJobStage,
): stage is (typeof ANALYSIS_JOB_TERMINAL_STAGES)[number] {
  return terminalStages.has(stage);
}

export function canTransitionAnalysisJob(
  from: AnalysisJobStage,
  to: AnalysisJobStage,
): boolean {
  if (isAnalysisJobTerminal(from) || from === to) return false;
  if (from === "cleaning_up") return isAnalysisJobTerminal(to);
  if (to === "cleaning_up" || to === "interrupted") return true;
  return forwardStage[from] === to;
}

export function assertAnalysisJobTransition(
  from: AnalysisJobStage,
  to: AnalysisJobStage,
): void {
  if (!canTransitionAnalysisJob(from, to)) {
    throw new Error(`Forbidden analysis-job transition: ${from} -> ${to}`);
  }
}

export function canTransitionMediaSession(
  from: MediaSessionState,
  to: MediaSessionState,
): boolean {
  if (terminalMediaStates.has(from) || from === to) return false;
  return mediaTransitions[from]?.includes(to) ?? false;
}

export function assertMediaSessionTransition(
  from: MediaSessionState,
  to: MediaSessionState,
): void {
  if (!canTransitionMediaSession(from, to)) {
    throw new Error(`Forbidden media-session transition: ${from} -> ${to}`);
  }
}

export function validateMediaSessionTransition(input: {
  id: string;
  expected: MediaSessionState;
  next: MediaSessionState;
}): ValidatedMediaTransition {
  assertMediaSessionTransition(input.expected, input.next);
  return {
    ...input,
    id: parseOpaqueResourceId(input.id),
    [validatedMediaTransitionBrand]: true,
  };
}

export function resolveIdempotencyReplay(
  existing: IdempotentJobReference | undefined,
  request: IdempotentJobRequest,
): IdempotencyResolution {
  if (!existing) return { kind: "create" };
  if (existing.idempotencyKey !== request.idempotencyKey) {
    throw new Error("Existing job does not match the requested idempotency key.");
  }
  if (existing.inputDigest !== request.inputDigest) {
    throw new Error(
      "The idempotency key was already used for different immutable input.",
    );
  }
  return { kind: "replay", jobId: existing.jobId };
}
