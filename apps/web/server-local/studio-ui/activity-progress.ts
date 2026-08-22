import type {
  AnalysisJob,
  AnalysisJobEvent,
} from "../../../../src/domain/studio-schemas";
import type { AnalysisJobStage } from "../../../../src/domain/studio-types";
import { activityStageLabel, formatRelativeActivity } from "./activity-state";

const activeStageOrder = [
  "queued",
  "fetching_context",
  "uploading_to_gemini",
  "indexing",
  "interrogating",
  "rendering",
  "cleaning_up",
] as const satisfies readonly AnalysisJobStage[];

const activeStageIndexes = new Map<AnalysisJobStage, number>(
  activeStageOrder.map((stage, index) => [stage, index + 1]),
);

export interface ActivityElapsedValue {
  seconds: number;
  text: string;
  accessibleText: string;
}

export type ActivityProgressDescriptor =
  | {
      kind: "indeterminate";
      text: "In progress";
      detail: string;
      accessibleText: string;
    }
  | {
      kind: "determinate";
      text: string;
      detail: string;
      accessibleText: string;
      completed: number;
      total: number;
    }
  | {
      kind: "terminal";
      text: string;
      accessibleText: string;
    };

export interface ActivityProgress {
  elapsed: ActivityElapsedValue;
  lastActivityAt: string;
  lastActivityText: string;
  lastActivityAccessibleText: string;
  currentStageStartedAt: string;
  descriptor: ActivityProgressDescriptor;
}

export function deriveActivityProgress(
  job: AnalysisJob,
  events: readonly AnalysisJobEvent[],
  now: string | number | Date,
): ActivityProgress {
  const nowMs = toMilliseconds(now);
  const terminalTransition = latestEvent(events, (event) =>
    event.kind === "transition" && event.stage === job.stage
      && isTerminalStage(event.stage)
  );
  const elapsedEnd = terminalTransition?.occurredAt
    ?? job.terminal?.at
    ?? new Date(nowMs).toISOString();
  const elapsedSeconds = durationSeconds(job.createdAt, elapsedEnd);
  const lastActivityAt = latestEvent(events)?.occurredAt ?? job.updatedAt;
  const lastActivityText = formatRelativeActivity(lastActivityAt, nowMs);
  const currentStageStartedAt = latestEvent(events, (event) =>
    event.kind === "transition" && event.stage === job.stage
  )?.occurredAt
    ?? (job.stage === "queued" ? job.createdAt : job.terminal?.at ?? job.updatedAt);

  return {
    elapsed: formatElapsed(elapsedSeconds),
    lastActivityAt,
    lastActivityText,
    lastActivityAccessibleText: `${lastActivityText} since the last activity`,
    currentStageStartedAt,
    descriptor: deriveProgressDescriptor(job.stage, events),
  };
}

function deriveProgressDescriptor(
  stage: AnalysisJobStage,
  events: readonly AnalysisJobEvent[],
): ActivityProgressDescriptor {
  const step = activeStageIndexes.get(stage);
  if (!step) {
    const text = activityStageLabel(stage);
    return { kind: "terminal", text, accessibleText: text };
  }

  const detail = `Step ${step} of ${activeStageOrder.length}`;
  const progress = latestEvent(events, (event) =>
    event.kind === "progress" && event.stage === stage
  );
  if (!progress || progress.kind !== "progress") {
    return {
      kind: "indeterminate",
      text: "In progress",
      detail,
      accessibleText: `In progress, ${detail.toLowerCase()}`,
    };
  }

  const { completed, total, unit } = progress.progress;
  const [completedLabel, totalLabel] = unit === "bytes"
    ? formatMegabytePair(completed, total)
    : [formatCount(completed), formatCount(total)];
  const text = unit === "bytes"
    ? `${completedLabel} MB of ${totalLabel} MB`
    : `${completedLabel} of ${totalLabel}`;
  const countedUnit = unit === "bytes" ? "megabytes" : unit;
  const accessibleCount = unit === "bytes"
    ? `${completedLabel} ${countedUnit} of ${totalLabel} ${countedUnit}`
    : `${completedLabel} of ${totalLabel} ${countedUnit}`;
  return {
    kind: "determinate",
    text,
    detail,
    accessibleText: `${accessibleCount}, ${detail.toLowerCase()}`,
    completed,
    total,
  };
}

function formatElapsed(seconds: number): ActivityElapsedValue {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  const shortParts = [
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    remainingSeconds || (!hours && !minutes) ? `${remainingSeconds}s` : "",
  ].filter(Boolean);
  const fullParts = [
    hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    minutes ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
    remainingSeconds || (!hours && !minutes)
      ? `${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);
  return {
    seconds,
    text: shortParts.join(" "),
    accessibleText: `${fullParts.join(" ")} elapsed`,
  };
}

// Honest labels: the displayed numerator and denominator may only read as
// equal when the counts are actually equal. Rounding to 0.1 MB would otherwise
// print "5 MB of 5 MB" for 4,950,000 of 5,000,000 bytes, so precision grows
// until the two labels differ (or the raw byte counts are shown).
function formatMegabytePair(completed: number, total: number): [string, string] {
  if (completed === total) {
    const label = formatMegabytes(total, 1);
    return [label, label];
  }
  for (const decimals of [1, 2, 3]) {
    const pair: [string, string] = [
      formatMegabytes(completed, decimals),
      formatMegabytes(total, decimals),
    ];
    if (pair[0] !== pair[1]) return pair;
  }
  return [`${completed / 1_000_000}`, `${total / 1_000_000}`];
}

function formatMegabytes(bytes: number, decimals: number): string {
  const scale = 10 ** decimals;
  return formatCount(Math.round((bytes / 1_000_000) * scale) / scale);
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function durationSeconds(start: string, end: string): number {
  return Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1_000));
}

function toMilliseconds(value: string | number | Date): number {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : Date.now();
}

function latestEvent(
  events: readonly AnalysisJobEvent[],
  matches: (event: AnalysisJobEvent) => boolean = () => true,
): AnalysisJobEvent | undefined {
  let latest: AnalysisJobEvent | undefined;
  for (const event of events) {
    if (!matches(event)) continue;
    if (
      !latest
      || Date.parse(event.occurredAt) > Date.parse(latest.occurredAt)
      || (
        event.occurredAt === latest.occurredAt
        && event.sequence > latest.sequence
      )
    ) latest = event;
  }
  return latest;
}

function isTerminalStage(stage: AnalysisJobStage): boolean {
  return stage === "succeeded"
    || stage === "failed"
    || stage === "canceled"
    || stage === "interrupted";
}
