import {
  createError,
  getRequestWebStream,
  type H3Event,
} from "h3";
import { z } from "zod";
import {
  readLimitedText,
  RequestBodyTooLargeError,
} from "../../server/utils/request-body.js";
import { StudioJobApiUnavailableError } from "./api-service.js";
import { StudioJobQueryError } from "./query.js";

const MAXIMUM_JOB_JSON_BYTES = 32 * 1_024;

const statusByJobError: Readonly<Record<string, number>> = {
  invalid_job_cursor: 400,
  invalid_event_cursor: 400,
  invalid_event_limit: 400,
  invalid_page_size: 400,
  job_not_found: 404,
  invalid_media_id: 404,
  media_not_found: 404,
  idempotency_conflict: 409,
  job_not_cancelable: 409,
  job_not_retryable: 409,
  media_not_retained: 409,
  media_not_reusable: 409,
  media_not_usable: 409,
  media_digest_mismatch: 409,
  media_lease_unavailable: 409,
  media_lease_invalid: 409,
  media_initial_guard_required: 500,
  media_retention_expired: 410,
  corrupt_job: 500,
};

export async function readJobJson(event: H3Event): Promise<unknown> {
  try {
    return JSON.parse(await readLimitedText(
      getRequestWebStream(event),
      MAXIMUM_JOB_JSON_BYTES,
    ));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw createError({
        statusCode: 413,
        statusMessage: "Job request is too large.",
      });
    }
    throw createError({
      statusCode: 400,
      statusMessage: "Job request must be valid JSON.",
    });
  }
}

export function throwJobHttpError(error: unknown): never {
  if (error instanceof StudioJobApiUnavailableError) {
    throw createError({
      statusCode: 503,
      statusMessage: "Local Studio job runtime is starting.",
    });
  }
  if (error instanceof z.ZodError) {
    throw createError({
      statusCode: 422,
      statusMessage: "Job request is invalid.",
    });
  }
  if (error instanceof StudioJobQueryError) {
    throw createError({
      statusCode: 400,
      statusMessage: "Job query is invalid.",
    });
  }
  if (
    error
    && typeof error === "object"
    && "statusCode" in error
    && typeof error.statusCode === "number"
  ) {
    throw error;
  }
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    throw createError({
      statusCode: statusByJobError[error.code] ?? 500,
      statusMessage: statusByJobError[error.code]
        ? "Job operation was rejected."
        : "Local Studio job state is inconsistent.",
    });
  }
  throw createError({
    statusCode: 500,
    statusMessage: "Local Studio job request failed.",
  });
}
