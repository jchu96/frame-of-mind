import type {
  AnalysisJob,
  AnalysisJobEvent,
} from "../../../../src/domain/studio-schemas.js";
import type { AnalysisJobStage } from "../../../../src/domain/studio-types.js";

export type ActivityGroup = "active" | "finished" | "needs-attention";
export type ActivityDisplayState =
  | "active"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

export interface TimelineProgressItem {
  sequence: number;
  occurredAt: string;
  label: string;
}

export interface TimelineTransitionRow {
  type: "transition";
  key: string;
  sequence: number;
  stage: AnalysisJobStage;
  occurredAt: string;
  label: string;
  message: string;
  progress: TimelineProgressItem[];
}

export interface TimelineNoticeRow {
  type: "notice";
  key: string;
  sequence: number;
  stage: AnalysisJobStage;
  occurredAt: string;
  kind: "cancellation_requested" | "warning" | "cleanup";
  label: string;
  message: string;
}

export type TimelineRow = TimelineTransitionRow | TimelineNoticeRow;

const stageOrder = [
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
] as const satisfies readonly AnalysisJobStage[];

const stageRanks = new Map<AnalysisJobStage, number>(
  stageOrder.map((stage, index) => [stage, index]),
);

const activeStages = new Set<AnalysisJobStage>([
  "queued",
  "fetching_context",
  "uploading_to_gemini",
  "indexing",
  "interrogating",
  "rendering",
  "cleaning_up",
]);

const stageLabels: Record<AnalysisJobStage, string> = {
  queued: "Waiting to start",
  fetching_context: "Reading context",
  uploading_to_gemini: "Sending recording to Gemini",
  indexing: "Finding relevant moments",
  interrogating: "Reviewing selected moments",
  rendering: "Preparing the run",
  cleaning_up: "Cleaning up",
  succeeded: "Completed",
  failed: "Failed",
  canceled: "Canceled",
  interrupted: "Interrupted",
};

export function activityGroupForStage(stage: AnalysisJobStage): ActivityGroup {
  if (activeStages.has(stage)) return "active";
  return stage === "succeeded" ? "finished" : "needs-attention";
}

export function activityDisplayState(
  stage: AnalysisJobStage,
): ActivityDisplayState {
  return activeStages.has(stage) ? "active" : stage;
}

export function activityStageLabel(stage: AnalysisJobStage): string {
  return stageLabels[stage];
}

export function groupActivityJobs(
  jobs: readonly AnalysisJob[],
): Record<ActivityGroup, AnalysisJob[]> {
  const grouped: Record<ActivityGroup, AnalysisJob[]> = {
    active: [],
    finished: [],
    "needs-attention": [],
  };
  for (const job of jobs) grouped[activityGroupForStage(job.stage)].push(job);
  return grouped;
}

export function formatRelativeActivity(
  value: string,
  now: string | number | Date,
): string {
  const then = Date.parse(value);
  const current = now instanceof Date
    ? now.getTime()
    : typeof now === "number"
      ? now
      : Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return "unknown";
  const seconds = Math.max(0, Math.floor((current - then) / 1_000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function recipeDisplayLabel(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function activityStageChangeAnnouncement(
  previous: readonly AnalysisJob[],
  current: readonly AnalysisJob[],
): string | undefined {
  if (previous.length === 0) return undefined;
  const previousStages = new Map(previous.map((job) => [job.id, job.stage]));
  const changes = current.flatMap((job) => {
    const previousStage = previousStages.get(job.id);
    if (!previousStage || previousStage === job.stage) return [];
    return [
      `${recipeDisplayLabel(job.input.recipe.id)} moved to ${activityStageLabel(job.stage)}.`,
    ];
  });
  return changes.length ? changes.join(" ") : undefined;
}

export function deriveActivityTimeline(
  input: readonly AnalysisJobEvent[],
): TimelineRow[] {
  const events = deduplicateEvents(input);
  const transitions = new Map<AnalysisJobStage, TimelineTransitionRow>();

  for (const event of events) {
    if (event.kind !== "transition" || transitions.has(event.stage)) continue;
    transitions.set(event.stage, {
      type: "transition",
      key: `transition:${event.stage}:${event.sequence}`,
      sequence: event.sequence,
      stage: event.stage,
      occurredAt: event.occurredAt,
      label: activityStageLabel(event.stage),
      message: event.message,
      progress: [],
    });
  }

  for (const event of events) {
    if (event.kind !== "progress") continue;
    const transition = transitions.get(event.stage);
    if (!transition) continue;
    transition.progress.push({
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      label: event.message ?? "Work updated",
    });
  }

  const notices: TimelineNoticeRow[] = events.flatMap((event) => {
    if (
      event.kind !== "cancellation_requested"
      && event.kind !== "warning"
      && event.kind !== "cleanup"
    ) return [];
    return [{
      type: "notice" as const,
      key: `${event.kind}:${event.sequence}`,
      sequence: event.sequence,
      stage: event.stage,
      occurredAt: event.occurredAt,
      kind: event.kind,
      label: event.kind === "warning"
        ? "Warning"
        : event.kind === "cleanup"
          ? "Cleanup"
          : "Cancellation requested",
      message: event.message,
    }];
  });

  return [...transitions.values(), ...notices].sort((left, right) => {
    const stageDifference = rank(left.stage) - rank(right.stage);
    if (stageDifference !== 0) return stageDifference;
    if (left.type !== right.type) return left.type === "transition" ? -1 : 1;
    return left.sequence - right.sequence;
  });
}

function deduplicateEvents(
  events: readonly AnalysisJobEvent[],
): AnalysisJobEvent[] {
  const unique = new Map<string, AnalysisJobEvent>();
  for (const event of events) {
    const key = `${event.jobId}:${event.attempt}:${event.sequence}:${event.kind}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()].sort((left, right) => left.sequence - right.sequence);
}

function rank(stage: AnalysisJobStage): number {
  return stageRanks.get(stage) ?? Number.MAX_SAFE_INTEGER;
}
