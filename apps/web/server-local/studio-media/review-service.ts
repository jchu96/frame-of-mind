import type { AnalysisJob } from "../../../../src/domain/studio-schemas.js";
import { publishedRunIdSchema } from "../../../../src/domain/studio-schemas.js";
import { MediaStagingError, type LocalMediaStagingAdapter } from "./local-media-staging.js";
import { parseReviewByteRange } from "./review-range.js";

export interface ReviewMediaResponse {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  mimeType: "video/mp4" | "video/quicktime" | "video/webm";
  range?: { start: number; end: number; total: number };
}

export interface ReviewRunJobLookup {
  getSucceededByRunId(runId: string): Promise<AnalysisJob | undefined>;
}

export type ReviewMediaOpenResult =
  | { kind: "available"; response: ReviewMediaResponse }
  | { kind: "not_found" }
  | { kind: "range_not_satisfiable"; size: number };

export class LocalStudioReviewMediaService {
  constructor(
    private readonly jobs: ReviewRunJobLookup,
    private readonly media: LocalMediaStagingAdapter,
  ) {}

  async available(runIdValue: string): Promise<boolean> {
    return Boolean(await this.retainedSession(runIdValue));
  }

  private async retainedSession(runIdValue: string) {
    const runId = publishedRunIdSchema.safeParse(runIdValue);
    if (!runId.success) return undefined;
    const job = await this.jobs.getSucceededByRunId(runId.data);
    if (!job?.runId || job.stage !== "succeeded") return undefined;

    try {
      const session = await this.media.get(job.input.mediaSessionId);
      if (
        !session
        || session.status !== "retained"
        || session.retention.mode !== "retained"
        || session.sha256 !== job.input.mediaSha256
        || Date.parse(session.retention.expiresAt) <= Date.now()
      ) {
        return undefined;
      }
      return { job, session };
    } catch (error) {
      if (error instanceof MediaStagingError) return undefined;
      throw error;
    }
  }

  async open(
    runIdValue: string,
    rangeHeader?: string,
  ): Promise<ReviewMediaOpenResult> {
    const resolved = await this.retainedSession(runIdValue);
    if (!resolved) return { kind: "not_found" };
    const { job, session } = resolved;

    const range = parseReviewByteRange(rangeHeader, session.expectedBytes);
    if (rangeHeader && !range) {
      return { kind: "range_not_satisfiable", size: session.expectedBytes };
    }

    try {
      const opened = await this.media.openRetainedReviewMedia(
        session.id,
        job.input.mediaSha256,
        range,
      );
      return {
        kind: "available",
        response: {
          body: opened.body,
          contentLength: opened.contentLength,
          mimeType: opened.mimeType,
          ...(range
            ? { range: { ...range, total: opened.totalBytes } }
            : {}),
        },
      };
    } catch (error) {
      if (error instanceof MediaStagingError && [
        "invalid_media_id",
        "media_not_found",
        "media_review_unavailable",
      ].includes(error.code)) {
        return { kind: "not_found" };
      }
      throw error;
    }
  }
}

let configuredReviewMedia: LocalStudioReviewMediaService | undefined;

export function configureStudioReviewMedia(
  service: LocalStudioReviewMediaService,
): void {
  if (configuredReviewMedia && configuredReviewMedia !== service) {
    throw new Error("Local Studio review media is already configured.");
  }
  configuredReviewMedia = service;
}

export function clearStudioReviewMedia(
  service: LocalStudioReviewMediaService,
): void {
  if (configuredReviewMedia === service) configuredReviewMedia = undefined;
}

export function getStudioReviewMedia(): LocalStudioReviewMediaService {
  if (!configuredReviewMedia) {
    throw new Error("Local Studio review media is unavailable.");
  }
  return configuredReviewMedia;
}

export function resetStudioReviewMediaForTests(): void {
  configuredReviewMedia = undefined;
}
