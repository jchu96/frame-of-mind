import type {
  AnalysisJob,
  AnalysisJobEvent,
  MediaSession,
} from "../../../../src/domain/studio-schemas.js";
import type { AnalysisJobStage } from "../../../../src/domain/studio-types.js";
import type {
  HostedJobView,
  HostedMediaView,
} from "../../../workflows/src/contracts.js";
import type { HostedEventView } from "../../../workflows/src/repository.js";

export type HostedStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function hostedStorage(storage: HostedStorage): HostedStorage {
  const key = (value: string) => `hosted:${value}`;
  return {
    getItem: (value) => storage.getItem(key(value)),
    setItem: (value, content) => storage.setItem(key(value), content),
    removeItem: (value) => storage.removeItem(key(value)),
  };
}

export function hostedMediaSession(
  media: HostedMediaView,
  status: "sealed" | "retained" = "sealed",
): MediaSession {
  return {
    id: media.id as MediaSession["id"],
    status,
    expectedBytes: 1,
    receivedBytes: 1,
    partSizeBytes: 1,
    parts: [{
      part: 0,
      offset: 0,
      bytes: 1,
      sha256: media.sha256,
      receivedAt: media.sealedAt,
    }],
    mimeType: media.mimeType,
    sha256: media.sha256,
    retention: { mode: media.retention, expiresAt: media.expiresAt },
    createdAt: media.sealedAt,
    updatedAt: media.sealedAt,
  };
}

export function hostedJobAsActivity(
  job: HostedJobView,
  media?: HostedMediaView,
): AnalysisJob {
  const stage = hostedStage(job.stage);
  const expiresAt = media?.expiresAt
    ?? new Date(Date.parse(job.createdAt) + 86_400_000).toISOString();
  const terminal = isTerminal(stage)
    ? {
        outcome: stage,
        at: job.updatedAt,
        ...(job.errorCode ? { code: job.errorCode } : {}),
      }
    : undefined;
  return {
    id: job.id,
    rootJobId: job.rootJobId,
    ...(job.retryOfAttemptId ? { retryOfJobId: job.retryOfAttemptId } : {}),
    attempt: job.attempt,
    idempotencyKey: `hosted-view:${job.id}`,
    inputDigest: "0".repeat(64),
    stage,
    ...(job.cancellationRequestedAt
      ? { cancellationRequestedAt: job.cancellationRequestedAt }
      : {}),
    input: {
      mediaSessionId: media?.id ?? job.id,
      mediaSha256: media?.sha256 ?? "0".repeat(64),
      context: job.receipt.context.mode === "none"
        ? { mode: "none" }
        : {
            provider: job.receipt.context.provider!,
            transport: job.receipt.context.transport!,
            meetingId: "principal-bound-receipt",
          },
      recipe: {
        id: job.receipt.recipe.id,
        revision: job.receipt.recipe.revision,
        sha256: "0".repeat(64),
      },
      model: job.receipt.model,
      retention: { mode: job.receipt.retention, expiresAt },
    },
    ...(terminal ? { terminal } : {}),
    ...(job.runId ? { runId: job.runId } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  } as AnalysisJob;
}

export function hostedEventsAsActivity(
  job: HostedJobView,
  events: readonly HostedEventView[],
): AnalysisJobEvent[] {
  let previous: AnalysisJobStage = "queued";
  return events.flatMap((event) => {
    const stage = hostedStage(event.stage as HostedJobView["stage"]);
    if (event.kind === "stage") {
      const mapped = {
        jobId: job.id,
        attempt: job.attempt,
        sequence: event.sequence,
        stage,
        occurredAt: event.occurredAt,
        kind: "transition" as const,
        previousStage: previous,
        message: stageMessage(stage),
      };
      previous = stage;
      return [mapped as AnalysisJobEvent];
    }
    if (event.kind === "cancellation_requested") {
      return [{
        jobId: job.id,
        attempt: job.attempt,
        sequence: event.sequence,
        stage,
        occurredAt: event.occurredAt,
        kind: "cancellation_requested" as const,
        message: "Cancellation requested.",
      } as AnalysisJobEvent];
    }
    return [];
  });
}

export function hostedStage(stage: HostedJobView["stage"]): AnalysisJobStage {
  if (stage === "fetch_context") return "fetching_context";
  if (stage === "ensure_gemini_file" || stage === "transcribe") {
    return "uploading_to_gemini";
  }
  if (stage === "index") return "indexing";
  if (stage === "interrogate") return "interrogating";
  if (stage === "cleanup" || stage === "publish") return "cleaning_up";
  if (stage === "indeterminate") return "interrupted";
  return stage;
}

function isTerminal(stage: AnalysisJobStage): stage is
  "succeeded" | "failed" | "canceled" | "interrupted" {
  return ["succeeded", "failed", "canceled", "interrupted"].includes(stage);
}

function stageMessage(stage: AnalysisJobStage): string {
  const messages: Record<AnalysisJobStage, string> = {
    queued: "Waiting for analysis to begin.",
    fetching_context: "Checking the selected sources.",
    uploading_to_gemini: "Sending the recording securely.",
    indexing: "Finding the moments that match the selected goal.",
    interrogating: "Reviewing the selected moments in detail.",
    rendering: "Preparing the results.",
    cleaning_up: "Removing the Gemini upload and publishing results.",
    succeeded: "Results are ready.",
    failed: "Analysis stopped before results were ready.",
    canceled: "Analysis was canceled.",
    interrupted: "Analysis was interrupted.",
  };
  return messages[stage];
}
