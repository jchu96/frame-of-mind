const statusByJobError: Readonly<Record<string, number>> = {
  invalid_job_cursor: 400,
  invalid_event_cursor: 400,
  invalid_event_limit: 400,
  invalid_page_size: 400,
  invalid_check_time: 422,
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
  job_not_succeeded: 409,
  run_bundle_not_found: 409,
  run_bundle_invalid: 409,
  run_bundle_job_mismatch: 409,
  run_projection_version_conflict: 409,
};

export interface JobErrorResponse {
  statusCode: number;
  statusMessage: string;
  data?: { code: string };
}

export function jobErrorResponse(error: unknown): JobErrorResponse | undefined {
  if (
    !error
    || typeof error !== "object"
    || !("code" in error)
    || typeof error.code !== "string"
  ) {
    return undefined;
  }
  const statusCode = statusByJobError[error.code];
  return {
    statusCode: statusCode ?? 500,
    statusMessage: statusCode
      ? "Job operation was rejected."
      : "Local Studio job state is inconsistent.",
    ...(statusCode && statusCode < 500
      ? { data: { code: error.code } }
      : {}),
  };
}
