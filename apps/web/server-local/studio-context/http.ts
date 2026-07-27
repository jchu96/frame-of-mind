import {
  createError,
  getHeader,
  type H3Event,
} from "h3";
import {
  contextFileFormatSchema,
  MAX_CONTEXT_FILE_BYTES,
} from "../../../../src/domain/studio-schemas.js";
import type {
  ContextFileFormat,
} from "../../../../src/domain/studio-ports.js";
import { ContextFileStagingError } from "./local-context-staging.js";

const acceptedMimeTypes: Readonly<Record<ContextFileFormat, readonly string[]>> = {
  json: ["application/json"],
  text: ["text/plain"],
  markdown: ["text/markdown", "text/plain"],
  srt: ["application/x-subrip", "text/plain"],
  vtt: ["text/vtt"],
};

const statusByContextError: Readonly<Record<string, number>> = {
  invalid_context_id: 404,
  context_not_found: 404,
  context_in_use: 409,
  context_id_collision: 409,
  unsupported_context_format: 415,
  invalid_context_chunk: 422,
  invalid_context_content: 422,
  context_byte_count_mismatch: 422,
  invalid_context_bounds: 422,
  context_too_large: 413,
  disk_exhausted: 507,
  unsafe_staging_root: 500,
  unsafe_context_file: 500,
  corrupt_context_receipt: 500,
  context_digest_mismatch: 409,
  context_write_failed: 500,
  aborted: 499,
};

function positiveIntegerHeader(
  value: string | undefined,
  label: string,
): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw createError({
      statusCode: 411,
      statusMessage: `${label} must be a positive integer.`,
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw createError({
      statusCode: 413,
      statusMessage: `${label} is outside the supported range.`,
    });
  }
  return parsed;
}

export function parseContextUploadHeaders(event: H3Event): {
  format: ContextFileFormat;
  expectedBytes: number;
} {
  const format = contextFileFormatSchema.safeParse(
    getHeader(event, "x-context-format")?.trim().toLowerCase(),
  );
  if (!format.success) {
    throw createError({
      statusCode: 415,
      statusMessage: "X-Context-Format must name a supported text format.",
    });
  }
  const mimeType = getHeader(event, "content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!mimeType || !acceptedMimeTypes[format.data].includes(mimeType)) {
    throw createError({
      statusCode: 415,
      statusMessage: "Content-Type does not match the context-file format.",
    });
  }
  const expectedBytes = positiveIntegerHeader(
    getHeader(event, "content-length"),
    "Content-Length",
  );
  if (expectedBytes > MAX_CONTEXT_FILE_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: "Context file exceeds the 8 MiB limit.",
    });
  }
  return { format: format.data, expectedBytes };
}

export function throwContextHttpError(error: unknown): never {
  if (error instanceof ContextFileStagingError) {
    throw createError({
      statusCode: statusByContextError[error.code] ?? 500,
      statusMessage: error.message,
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
    statusMessage: "Context-file staging request failed.",
  });
}
