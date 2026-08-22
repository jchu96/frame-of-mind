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
import { jobErrorResponse } from "./job-error-response.js";
import { StudioJobQueryError } from "./query.js";

const MAXIMUM_JOB_JSON_BYTES = 32 * 1_024;

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
  const mapped = jobErrorResponse(error);
  if (mapped) {
    throw createError(mapped);
  }
  throw createError({
    statusCode: 500,
    statusMessage: "Local Studio job request failed.",
  });
}
