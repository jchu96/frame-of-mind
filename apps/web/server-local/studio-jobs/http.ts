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
  media_retention_mismatch: 409,
  media_digest_mismatch: 409,
  media_lease_unavailable: 409,
  media_lease_invalid: 409,
  media_initial_guard_required: 500,
  media_retention_expired: 410,
  gemini_not_configured: 409,
  granola_api_not_configured: 409,
  bluedot_oauth_not_configured: 409,
  granola_oauth_not_configured: 409,
  context_file_staging_unavailable: 409,
  context_file_not_found: 409,
  context_file_receipt_mismatch: 409,
  custom_recipe_staging_unavailable: 409,
  recipe_not_found: 422,
  recipe_receipt_mismatch: 409,
  unsafe_output_root: 500,
  invalid_runtime_bounds: 500,
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
        data: { code: "job_request_too_large" },
      });
    }
    throw createError({
      statusCode: 400,
      statusMessage: "Job request must be valid JSON.",
      data: { code: "invalid_job_json" },
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
      data: { code: "invalid_job_request" },
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
    const statusCode = statusByJobError[error.code];
    throw createError({
      statusCode: statusCode ?? 500,
      statusMessage: statusCode
        ? "Job operation was rejected."
        : "Local Studio job state is inconsistent.",
      ...(statusCode ? { data: { code: error.code } } : {}),
    });
  }
  throw createError({
    statusCode: 500,
    statusMessage: "Local Studio job request failed.",
  });
}
