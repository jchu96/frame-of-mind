import {
  createError,
  getRequestWebStream,
  type H3Event,
} from "h3";
import { z } from "zod";
import { StudioJobInputUnavailableError } from "../../../../src/domain/studio-errors.js";
import {
  readLimitedText,
  RequestBodyTooLargeError,
} from "../../server/utils/request-body.js";
import {
  HostedRepositoryError,
} from "../../../workflows/src/repository.js";
import { HostedWorkflowDispatchError } from "./executor.js";

const MAXIMUM_HOSTED_JOB_JSON_BYTES = 32 * 1_024;

export async function readHostedJobJson(event: H3Event): Promise<unknown> {
  try {
    return JSON.parse(await readLimitedText(
      getRequestWebStream(event),
      MAXIMUM_HOSTED_JOB_JSON_BYTES,
    ));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw createError({
        statusCode: 413,
        statusMessage: "Hosted job request is too large.",
        data: { code: "hosted_job_request_too_large" },
      });
    }
    throw createError({
      statusCode: 400,
      statusMessage: "Hosted job request must be valid JSON.",
      data: { code: "invalid_hosted_job_json" },
    });
  }
}

export function hostedReservationUnits(event: H3Event): number {
  const value = Number(useRuntimeConfig(event).hostedWorkflowReservationUnits);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    throw createError({
      statusCode: 503,
      statusMessage: "Hosted spend reservation is unavailable.",
      data: { code: "principal_spend_cap_unavailable" },
    });
  }
  return value;
}

export function throwHostedJobHttpError(error: unknown): never {
  if (error instanceof z.ZodError) {
    throw createError({
      statusCode: 422,
      statusMessage: "Hosted job request is invalid.",
      data: { code: "invalid_hosted_job_request" },
    });
  }
  if (error instanceof HostedRepositoryError) {
    const statusCode = error.code === "hosted_attempt_not_found"
      || error.code === "hosted_media_not_found"
      ? 404
      : error.code === "hosted_idempotency_conflict"
        || error.code === "hosted_attempt_create_conflict"
        ? 409
        : error.code === "principal_spend_cap_exceeded"
          ? 429
          : error.code.includes("missing") || error.code.includes("expired")
            ? 422
            : 409;
    throw createError({
      statusCode,
      statusMessage: "Hosted job request could not be completed.",
      data: { code: error.code },
    });
  }
  if (error instanceof StudioJobInputUnavailableError) {
    throw createError({
      statusCode: 422,
      statusMessage: "Hosted composer receipt is invalid.",
      data: { code: error.code },
    });
  }
  if (error instanceof HostedWorkflowDispatchError) {
    throw createError({
      statusCode: 503,
      statusMessage: "Hosted Workflow dispatch is unavailable.",
      data: { code: error.code },
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
  throw createError({
    statusCode: 500,
    statusMessage: "Hosted job request failed.",
  });
}

export function newHostedOpaqueId(prefix: "job" | "attempt" | "workflow"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
