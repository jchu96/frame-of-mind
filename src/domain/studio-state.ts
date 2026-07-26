import {
  ANALYSIS_JOB_STAGES,
  ANALYSIS_JOB_TERMINAL_STAGES,
  type AnalysisJobStage,
  type IdempotencyResolution,
  type IdempotentJobReference,
  type IdempotentJobRequest,
} from "./studio-types.js";

export {
  ANALYSIS_JOB_STAGES,
  ANALYSIS_JOB_TERMINAL_STAGES,
} from "./studio-types.js";

const terminalStages = new Set<AnalysisJobStage>(
  ANALYSIS_JOB_TERMINAL_STAGES,
);

const forwardStage: Partial<Record<AnalysisJobStage, AnalysisJobStage>> = {
  queued: "fetching_context",
  fetching_context: "uploading_to_gemini",
  uploading_to_gemini: "indexing",
  indexing: "interrogating",
  interrogating: "rendering",
  rendering: "cleaning_up",
};

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
