import type {
  AnalysisJob,
  MediaSession,
} from "../../../../src/domain/studio-schemas";
import { isAnalysisJobTerminal } from "../../../../src/domain/studio-state";

export type ActivityActionId =
  | "cancel"
  | "retry"
  | "reconnect-provider"
  | "reimport-results"
  | "retry-cleanup";

export type RunProjectionState = "present" | "missing" | "unknown";

export interface ActivityActionContext {
  job: AnalysisJob;
  media: MediaSession | null | undefined;
  projection: RunProjectionState;
  now: string;
}

export interface PermittedActivityAction {
  id: ActivityActionId;
  label: string;
  description: string;
  provider?: "bluedot" | "granola";
}

export interface ActivityActionDecision {
  actions: PermittedActivityAction[];
  retryDeniedCode?: string;
  whyNot?: string;
}

export function derivePermittedActivityActions(
  input: ActivityActionContext,
): ActivityActionDecision {
  const actions: PermittedActivityAction[] = [];
  const { job, media } = input;

  if (
    !isAnalysisJobTerminal(job.stage)
    && !job.cancellationRequestedAt
    && !job.runId
  ) {
    actions.push({
      id: "cancel",
      label: "Cancel",
      description: "Stop this analysis after its current safe step.",
    });
  }

  const reconnectProvider = providerForAuthCode(job);
  if (reconnectProvider) {
    actions.push({
      id: "reconnect-provider",
      label: `Reconnect ${displayProvider(reconnectProvider)}`,
      description:
        `Open Connections for ${displayProvider(reconnectProvider)}, then return here to retry.`,
      provider: reconnectProvider,
    });
  }

  const retryDeniedCode = retryDenialCode(job, media, input.now);
  if (!retryDeniedCode) {
    actions.push({
      id: "retry",
      label: "Retry",
      description: "Start a new attempt with the retained recording.",
    });
  }

  if (
    job.stage === "succeeded"
    && job.runId
    && (Boolean(job.projectionWarning) || input.projection === "missing")
  ) {
    actions.push({
      id: "reimport-results",
      label: "Re-import results",
      description: "Add the completed results back to the review workspace.",
    });
  }

  if (media?.status === "cleanup_failed") {
    actions.push({
      id: "retry-cleanup",
      label: "Retry cleanup",
      description: "Try deleting the local staged recording again.",
    });
  }

  const whyNot =
    (job.stage === "failed" || job.stage === "interrupted")
      && retryDeniedCode
      ? retryWhyNot(retryDeniedCode)
      : actions.length === 0
        ? whyNoAction(job, retryDeniedCode)
        : undefined;

  return {
    actions,
    ...(retryDeniedCode ? { retryDeniedCode } : {}),
    ...(whyNot ? { whyNot } : {}),
  };
}

export function retryDenialCode(
  job: AnalysisJob,
  media: MediaSession | null | undefined,
  checkedAt: string,
): string | undefined {
  if (job.stage !== "failed" && job.stage !== "interrupted") {
    return "job_not_retryable";
  }
  if (job.input.retention.mode !== "retained") {
    return "media_not_retained";
  }
  if (media === undefined) return "media_status_unavailable";
  if (media === null) return "media_not_found";
  if (
    media.id !== job.input.mediaSessionId
    || media.status !== "retained"
    || media.retention.mode !== "retained"
  ) {
    return "media_not_reusable";
  }
  if (!media.sha256 || media.sha256 !== job.input.mediaSha256) {
    return "media_digest_mismatch";
  }
  if (
    media.retention.expiresAt !== job.input.retention.expiresAt
    || !Number.isFinite(Date.parse(checkedAt))
    || Date.parse(media.retention.expiresAt) <= Date.parse(checkedAt)
  ) {
    return "media_retention_expired";
  }
  return undefined;
}

function providerForAuthCode(
  job: AnalysisJob,
): "bluedot" | "granola" | undefined {
  if (job.stage !== "failed" || !("provider" in job.input.context)) {
    return undefined;
  }
  const provider = job.input.context.provider;
  const code = job.terminal?.code;
  if (provider === "bluedot" && code === "bluedot_oauth_not_configured") {
    return provider;
  }
  if (
    provider === "granola"
    && (
      code === "granola_api_not_configured"
      || code === "granola_oauth_not_configured"
    )
  ) {
    return provider;
  }
  return undefined;
}

function whyNoAction(job: AnalysisJob, retryDeniedCode?: string): string {
  if (job.cancellationRequestedAt && !isAnalysisJobTerminal(job.stage)) {
    return "Cancellation is already in progress.";
  }
  if (job.stage === "canceled") {
    return "Canceled work stays stopped. Start a new analysis to run it again.";
  }
  if (
    (job.stage === "failed" || job.stage === "interrupted")
    && retryDeniedCode
  ) {
    return retryWhyNot(retryDeniedCode);
  }
  return "No recovery action is needed.";
}

export function retryWhyNot(code: string): string {
  if (code === "media_not_retained") {
    return "Retry needs a recording that was kept after the first attempt.";
  }
  if (code === "media_retention_expired") {
    return "The kept recording expired, so this attempt cannot be retried.";
  }
  if (code === "media_not_found") {
    return "The kept recording could not be found.";
  }
  if (code === "media_status_unavailable") {
    return "Recording status could not be checked. Refresh and try again.";
  }
  return "The kept recording no longer matches this attempt.";
}

function displayProvider(provider: "bluedot" | "granola"): string {
  return provider === "bluedot" ? "Bluedot" : "Granola";
}
