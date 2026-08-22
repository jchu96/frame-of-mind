import { z } from "zod";
import {
  analysisJobSchema,
  mediaSessionSchema,
  type AnalysisJob,
  type MediaSession,
} from "../../../../src/domain/studio-schemas";
import type { JobCreateResult } from "../../../../src/domain/studio-ports";
import type { RunProjectionState } from "./activity-actions";

const jobCreateResultSchema = z.object({
  kind: z.enum(["created", "replayed"]),
  job: analysisJobSchema,
}).strict();

export interface ActivityActionSnapshot {
  media: MediaSession | null | undefined;
  projection: RunProjectionState;
}

export class ActivityActionRequestError extends Error {
  constructor(readonly code?: string) {
    super("Activity action was rejected.");
    this.name = "ActivityActionRequestError";
  }
}

export interface ActivityActionTransport {
  cancel(jobId: string): Promise<AnalysisJob>;
  retry(jobId: string, idempotencyKey: string): Promise<JobCreateResult>;
  reimport(jobId: string): Promise<{ runId: string; created: boolean }>;
  retryCleanup(mediaId: string): Promise<MediaSession>;
}

export function createActivityActionTransport(
  fetchImplementation: typeof fetch = fetch,
): ActivityActionTransport {
  async function post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImplementation(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ActivityActionRequestError();
    }
    const value = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new ActivityActionRequestError(responseCode(value));
    }
    return value;
  }

  return {
    async cancel(jobId) {
      return analysisJobSchema.parse(await post(
        `/api/studio/jobs/${encodeURIComponent(jobId)}/cancel`,
        {},
      ));
    },
    async retry(jobId, idempotencyKey) {
      return jobCreateResultSchema.parse(await post(
        `/api/studio/jobs/${encodeURIComponent(jobId)}/retry`,
        { idempotencyKey },
      ));
    },
    async reimport(jobId) {
      return z.object({
        runId: z.string().min(1),
        created: z.boolean(),
      }).strict().parse(await post(
        `/api/studio/jobs/${encodeURIComponent(jobId)}/reimport`,
        {},
      ));
    },
    async retryCleanup(mediaId) {
      return mediaSessionSchema.parse(await post(
        `/api/studio/media/${encodeURIComponent(mediaId)}/cleanup-retry`,
        {},
      ));
    },
  };
}

export async function loadActivityActionSnapshot(
  job: AnalysisJob,
  fetchImplementation: typeof fetch = fetch,
): Promise<ActivityActionSnapshot> {
  const [media, projection] = await Promise.all([
    loadMedia(job.input.mediaSessionId, fetchImplementation),
    loadProjection(job, fetchImplementation),
  ]);
  return { media, projection };
}

async function loadMedia(
  mediaId: string,
  fetchImplementation: typeof fetch,
): Promise<MediaSession | null | undefined> {
  try {
    const response = await fetchImplementation(
      `/api/studio/media/${encodeURIComponent(mediaId)}`,
      { credentials: "same-origin", headers: { accept: "application/json" } },
    );
    if (response.status === 404) return null;
    if (!response.ok) return undefined;
    return mediaSessionSchema.parse(await response.json());
  } catch {
    return undefined;
  }
}

async function loadProjection(
  job: AnalysisJob,
  fetchImplementation: typeof fetch,
): Promise<RunProjectionState> {
  if (job.stage !== "succeeded" || !job.runId) return "unknown";
  try {
    const response = await fetchImplementation(
      `/api/runs/${encodeURIComponent(job.runId)}`,
      { credentials: "same-origin", headers: { accept: "application/json" } },
    );
    if (response.status === 404) return "missing";
    return response.ok ? "present" : "unknown";
  } catch {
    return "unknown";
  }
}

function responseCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function activityActionErrorMessage(
  action: "cancel" | "retry" | "reimport-results" | "retry-cleanup",
  code?: string,
): string {
  if (code === "idempotency_conflict") {
    return "That retry request belongs to different work. Try again with a fresh request.";
  }
  if (code === "job_not_cancelable") {
    return "This analysis has already finished and cannot be canceled.";
  }
  if (code === "job_not_retryable") {
    return "This attempt cannot be retried from its current state.";
  }
  if (code === "media_not_retained" || code === "media_not_reusable") {
    return "Retry needs the matching recording to still be kept locally.";
  }
  if (code === "media_retention_expired") {
    return "The kept recording expired before the retry could start.";
  }
  if (code === "media_digest_mismatch") {
    return "The kept recording no longer matches this attempt.";
  }
  if (code === "job_not_succeeded") {
    return "Results can be re-imported only after analysis completes.";
  }
  if (code?.startsWith("run_bundle_")) {
    return "The completed result files are missing or no longer match this job.";
  }
  if (code === "media_cleanup_not_retryable") {
    return "Cleanup no longer needs another attempt.";
  }
  if (action === "cancel") return "Studio could not confirm cancellation. Refresh and try again.";
  if (action === "retry") return "Studio could not confirm the new attempt. Try again with the same request.";
  if (action === "reimport-results") return "Studio could not add the completed results. Refresh and try again.";
  return "Studio could not confirm cleanup. Refresh and try again.";
}
