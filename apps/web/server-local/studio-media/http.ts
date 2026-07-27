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
import { MediaStagingError } from "./local-media-staging.js";

const maximumMediaJsonBytes = 16 * 1_024;

const statusByMediaError: Readonly<Record<string, number>> = {
  invalid_media_id: 404,
  media_not_found: 404,
  idempotency_conflict: 409,
  media_id_collision: 409,
  concurrent_writer: 409,
  part_conflict: 409,
  part_out_of_order: 409,
  media_not_uploadable: 409,
  media_in_use: 409,
  media_execution_lease_mismatch: 409,
  media_state_conflict: 409,
  retention_not_requested: 409,
  media_terminal_failure: 409,
  media_incomplete: 409,
  media_expired: 410,
  invalid_part: 422,
  invalid_part_chunk: 422,
  invalid_part_size: 422,
  invalid_upload_ttl: 422,
  part_size_mismatch: 422,
  digest_mismatch: 422,
  mime_mismatch: 422,
  too_many_parts: 413,
  insufficient_disk: 507,
  disk_exhausted: 507,
  cleanup_failed: 503,
  unsafe_staging_root: 500,
  unsafe_staging_file: 500,
  staging_inconsistent: 500,
  corrupt_media_receipt: 500,
  part_write_failed: 500,
  aborted: 499,
};

export async function readMediaJson(
  event: H3Event,
): Promise<unknown> {
  try {
    return JSON.parse(await readLimitedText(
      getRequestWebStream(event),
      maximumMediaJsonBytes,
    ));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw createError({
        statusCode: 413,
        statusMessage: "Media request is too large.",
      });
    }
    throw createError({
      statusCode: 400,
      statusMessage: "Media request must be valid JSON.",
    });
  }
}

export function throwMediaHttpError(error: unknown): never {
  if (error instanceof MediaStagingError) {
    throw createError({
      statusCode: statusByMediaError[error.code] ?? 500,
      statusMessage: error.message,
    });
  }
  if (error instanceof z.ZodError) {
    throw createError({
      statusCode: 422,
      statusMessage: "Media request is invalid.",
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
    statusMessage: "Media staging request failed.",
  });
}
