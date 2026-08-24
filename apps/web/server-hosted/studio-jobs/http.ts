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
import {
  hostedSpendEstimator,
  hostedSpendPolicyConfigSchema,
  HostedSpendPolicyError,
  type HostedSpendPlan,
  type HostedSpendPolicyConfig,
} from "../../../workflows/src/spend.js";

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

export function hostedSpendPolicy(event: H3Event): HostedSpendPolicyConfig {
  const config = useRuntimeConfig(event);
  const parsed = hostedSpendPolicyConfigSchema.safeParse({
    principalCapUnits: Number(config.hostedSpendPrincipalCapUnits),
    videoTokensPerSecond: Number(config.hostedSpendVideoTokensPerSecond),
    promptOutputHeadroomPerCall: Number(
      config.hostedSpendPromptOutputHeadroomPerCall,
    ),
    maxInterrogationCalls: Number(config.hostedSpendMaxInterrogationCalls),
  });
  if (!parsed.success) {
    throw new HostedSpendPolicyError("spend_policy_unavailable");
  }
  return parsed.data;
}

export function hostedSpendPlan(
  event: H3Event,
  durationSeconds: number,
): HostedSpendPlan {
  return hostedSpendEstimator.estimate(durationSeconds, hostedSpendPolicy(event));
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
    // A foreign media id and a missing one are the same query for the caller's
    // principal, so both answer 404: a 422 would confirm another principal's
    // media exists.
    const statusCode = error.code === "hosted_attempt_not_found"
      || error.code === "hosted_media_not_found"
      || error.code === "sealed_media_receipt_missing"
      ? 404
      : error.code === "hosted_idempotency_conflict"
        || error.code === "hosted_attempt_create_conflict"
        ? 409
        : error.code === "principal_spend_cap_exceeded"
          || error.code === "spend_estimate_exceeds_remaining_allowance"
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
  if (error instanceof HostedSpendPolicyError) {
    throw createError({
      statusCode: 503,
      statusMessage: "Hosted spend policy is unavailable.",
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

export function hostedJobErrorCode(error: unknown): string {
  if (
    error instanceof HostedRepositoryError
    || error instanceof HostedSpendPolicyError
    || error instanceof StudioJobInputUnavailableError
    || error instanceof HostedWorkflowDispatchError
  ) {
    return error.code;
  }
  return error instanceof z.ZodError
    ? "invalid_hosted_job_request"
    : "hosted_job_request_failed";
}

export function newHostedOpaqueId(prefix: "job" | "attempt" | "workflow"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
