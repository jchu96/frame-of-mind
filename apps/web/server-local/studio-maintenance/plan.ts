import type { AnalysisJobStage } from "../../../../src/domain/studio-types";
import { isAnalysisJobTerminal } from "../../../../src/domain/studio-state";

const sanitizedIdPattern = /^[A-Za-z][A-Za-z0-9_-]{2,127}$/;

export type MaintenanceOwnership =
  | "studio_staged_copy"
  | "explicit_local_recording";

export interface MaintenanceJobSnapshot {
  id: string;
  stage: AnalysisJobStage;
  updatedAt: string;
  mediaSessionId: string;
  contextFileId?: string;
  runId?: string;
}

export interface MaintenanceMediaSnapshot {
  id: string;
  ownership: MaintenanceOwnership;
  status: string;
  retention: {
    mode: "ephemeral" | "retained";
    expiresAt: string;
  };
  uploadExpiresAt?: string;
  updatedAt: string;
  sha256?: string;
}

export interface MaintenanceContextSnapshot {
  id: string;
  ownership: MaintenanceOwnership;
  expiresAt: string;
  updatedAt: string;
}

export interface MaintenanceHeartbeat {
  jobId: string;
  observedAt: string;
}

export interface StudioMaintenanceInput {
  now: string;
  staleJobHorizonMs: number;
  orphanGraceMs: number;
  jobs: MaintenanceJobSnapshot[];
  media: MaintenanceMediaSnapshot[];
  contextFiles: MaintenanceContextSnapshot[];
  heartbeats: MaintenanceHeartbeat[];
}

export type StudioMaintenanceAction =
  | {
      action: "delete_context";
      id: string;
      reason: "context_expired" | "context_orphaned";
    }
  | {
      action: "delete_media";
      id: string;
      reason: "media_expired" | "media_orphaned";
    }
  | {
      action: "mark_job_stale";
      id: string;
      expectedStage: AnalysisJobStage;
      expectedUpdatedAt: string;
      reason: "stale_without_heartbeat";
    };

export interface StudioMaintenancePlan {
  generatedAt: string;
  actions: StudioMaintenanceAction[];
}

function timestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || !value.endsWith("Z")) {
    throw new Error(`${label} must be a UTC timestamp.`);
  }
  return milliseconds;
}

function sanitizedId(value: string): string {
  if (!sanitizedIdPattern.test(value)) {
    throw new Error("Maintenance identifiers must be sanitized opaque ids.");
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function planStudioMaintenance(
  input: StudioMaintenanceInput,
): StudioMaintenancePlan {
  const now = timestamp(input.now, "Maintenance clock");
  const staleCutoff = now - positiveInteger(
    input.staleJobHorizonMs,
    "Stale-job horizon",
  );
  const orphanCutoff = now - positiveInteger(
    input.orphanGraceMs,
    "Orphan grace",
  );
  const heartbeatByJob = new Map(
    input.heartbeats.map((heartbeat) => [
      sanitizedId(heartbeat.jobId),
      timestamp(heartbeat.observedAt, "Worker heartbeat"),
    ]),
  );
  const staleJobIds = new Set<string>();
  const actions: StudioMaintenanceAction[] = [];

  for (const job of input.jobs) {
    const id = sanitizedId(job.id);
    sanitizedId(job.mediaSessionId);
    if (job.contextFileId) sanitizedId(job.contextFileId);
    const updatedAt = timestamp(job.updatedAt, "Job update");
    const heartbeat = heartbeatByJob.get(id);
    if (
      !isAnalysisJobTerminal(job.stage)
      && !job.runId
      && updatedAt <= staleCutoff
      && (heartbeat === undefined || heartbeat <= staleCutoff)
    ) {
      staleJobIds.add(id);
      actions.push({
        action: "mark_job_stale",
        id,
        expectedStage: job.stage,
        expectedUpdatedAt: job.updatedAt,
        reason: "stale_without_heartbeat",
      });
    }
  }

  const liveJobs = input.jobs.filter((job) =>
    !isAnalysisJobTerminal(job.stage) && !staleJobIds.has(job.id)
  );
  const liveMediaIds = new Set(liveJobs.map((job) => job.mediaSessionId));
  const liveContextIds = new Set(
    liveJobs.flatMap((job) => job.contextFileId ? [job.contextFileId] : []),
  );

  for (const media of input.media) {
    const id = sanitizedId(media.id);
    if (media.ownership !== "studio_staged_copy") continue;
    if (media.status === "deleted" || media.status === "failed") continue;
    const expiresAt = timestamp(
      ["created", "uploading"].includes(media.status)
        && media.uploadExpiresAt
        ? media.uploadExpiresAt
        : media.retention.expiresAt,
      "Media expiry",
    );
    const updatedAt = timestamp(media.updatedAt, "Media update");
    const liveRetained = media.retention.mode === "retained"
      && ["sealed", "retained", "in_use"].includes(media.status)
      && timestamp(media.retention.expiresAt, "Retention expiry") > now;
    const liveLease = liveMediaIds.has(id) && media.status === "in_use";
    if (liveLease || liveRetained) continue;
    if (expiresAt <= now) {
      actions.push({
        action: "delete_media",
        id,
        reason: "media_expired",
      });
    } else if (!liveMediaIds.has(id) && updatedAt <= orphanCutoff) {
      actions.push({
        action: "delete_media",
        id,
        reason: "media_orphaned",
      });
    }
  }

  for (const context of input.contextFiles) {
    const id = sanitizedId(context.id);
    if (context.ownership !== "studio_staged_copy") continue;
    const expiresAt = timestamp(context.expiresAt, "Context expiry");
    const updatedAt = timestamp(context.updatedAt, "Context update");
    if (liveContextIds.has(id)) continue;
    if (expiresAt <= now) {
      actions.push({
        action: "delete_context",
        id,
        reason: "context_expired",
      });
    } else if (updatedAt <= orphanCutoff) {
      actions.push({
        action: "delete_context",
        id,
        reason: "context_orphaned",
      });
    }
  }

  actions.sort((left, right) =>
    left.action.localeCompare(right.action) || left.id.localeCompare(right.id)
  );
  return { generatedAt: input.now, actions };
}
