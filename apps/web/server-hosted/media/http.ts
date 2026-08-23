import {
  createError,
  getRequestURL,
  getRequestWebStream,
  type H3Event,
} from "h3";
import { z } from "zod";
import {
  HOSTED_MEDIA_MAX_BYTES_DEFAULT,
  HOSTED_MEDIA_OPEN_SESSION_CAP_DEFAULT,
  HOSTED_MEDIA_RETENTION_DAYS_DEFAULT,
  HOSTED_MEDIA_SESSION_TTL_SECONDS_DEFAULT,
} from "../../../workflows/src/media.js";
import { HostedRepositoryError } from "../../../workflows/src/repository.js";
import {
  readLimitedText,
  RequestBodyTooLargeError,
} from "../../server/utils/request-body.js";
import { HostedGeminiFilesError, HostedGeminiFilesClient } from "./provider.js";
import { HostedMediaService, HostedMediaServiceError } from "./service.js";

const MAXIMUM_HOSTED_MEDIA_JSON_BYTES = 16 * 1_024;
const MAXIMUM_PROVIDER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function readHostedMediaJson(event: H3Event): Promise<unknown> {
  try {
    return JSON.parse(await readLimitedText(
      getRequestWebStream(event),
      MAXIMUM_HOSTED_MEDIA_JSON_BYTES,
    ));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw createError({
        statusCode: 413,
        statusMessage: "Hosted media request is too large.",
        data: { code: "hosted_media_request_too_large" },
      });
    }
    throw createError({
      statusCode: 400,
      statusMessage: "Hosted media request must be valid JSON.",
      data: { code: "invalid_hosted_media_json" },
    });
  }
}

export function getHostedMediaRuntime(event: H3Event): {
  service: HostedMediaService;
  principalSub: string;
} {
  const principalSub = getHostedMediaPrincipal(event);
  const config = useRuntimeConfig(event);
  const environment = event.context.cloudflare?.env as
    | Record<string, unknown>
    | undefined;
  const database = environment?.DB;
  const bucket = environment?.RETAINED_MEDIA;
  const apiKey = typeof environment?.GEMINI_API_KEY === "string"
    ? environment.GEMINI_API_KEY.trim()
    : "";
  if (!database || !apiKey) {
    throw createError({
      statusCode: 503,
      statusMessage: "Hosted media bindings are unavailable.",
      data: { code: "hosted_media_bindings_unavailable" },
    });
  }
  const openSessionCap = positiveInteger(
    config.hostedMediaOpenSessionCap,
    HOSTED_MEDIA_OPEN_SESSION_CAP_DEFAULT,
    100,
  );
  const maxBytes = positiveInteger(
    config.hostedMediaMaxBytes,
    HOSTED_MEDIA_MAX_BYTES_DEFAULT,
    HOSTED_MEDIA_MAX_BYTES_DEFAULT,
  );
  const sessionTtlSeconds = positiveInteger(
    config.hostedMediaSessionTtlSeconds,
    HOSTED_MEDIA_SESSION_TTL_SECONDS_DEFAULT,
    MAXIMUM_PROVIDER_SESSION_TTL_SECONDS,
  );
  const retentionDays = positiveInteger(
    config.hostedMediaRetentionDays,
    HOSTED_MEDIA_RETENTION_DAYS_DEFAULT,
    365,
  );
  const origin = typeof environment?.HOSTED_GEMINI_FILES_BASE_URL === "string"
    ? environment.HOSTED_GEMINI_FILES_BASE_URL
    : undefined;
  return {
    principalSub,
    service: new HostedMediaService(
      database as ConstructorParameters<typeof HostedMediaService>[0],
      new HostedGeminiFilesClient(apiKey, origin),
      apiKey,
      bucket as ConstructorParameters<typeof HostedMediaService>[3],
      getRequestURL(event).origin,
      { openSessionCap, maxBytes, sessionTtlSeconds, retentionDays },
    ),
  };
}

export function getHostedMediaPrincipal(event: H3Event): string {
  const config = useRuntimeConfig(event);
  if (config.hostedWorkflowsEnabled !== true) {
    throw createError({ statusCode: 404, statusMessage: "Not found." });
  }
  const principal = event.context.frameOfMindPrincipal;
  if (!principal || principal.principal.startsWith("service:")) {
    throw createError({
      statusCode: 403,
      statusMessage: "A user principal is required.",
      data: { code: "user_principal_required" },
    });
  }
  return principal.principal;
}

export function throwHostedMediaHttpError(error: unknown): never {
  if (error instanceof z.ZodError) {
    throw createError({
      statusCode: 422,
      statusMessage: "Hosted media request is invalid.",
      data: { code: "invalid_hosted_media_request" },
    });
  }
  const code = error instanceof HostedMediaServiceError
      || error instanceof HostedGeminiFilesError
      || error instanceof HostedRepositoryError
    ? error.code
    : undefined;
  if (code) {
    const statusCode = code === "hosted_media_not_found"
      ? 404
      : code === "hosted_media_open_session_cap_exceeded"
        ? 429
        : code === "hosted_media_size_exceeded"
          || code === "hosted_retained_part_size_exceeded"
          || code === "invalid_hosted_media_request"
          ? 422
          : code === "media_seal_mismatch"
            || code === "retained_media_seal_mismatch"
            || code === "hosted_retained_upload_incomplete"
            || code === "hosted_retained_capability_unavailable"
            || code === "hosted_retained_media_in_use"
            || code === "hosted_media_upload_incomplete"
            || code === "hosted_media_seal_conflict"
            || code === "hosted_media_session_expired"
            || code === "hosted_media_already_sealed"
            ? 409
            : 503;
    throw createError({
      statusCode,
      statusMessage: statusCode === 404
        ? "Hosted media was not found."
        : statusCode === 429
          ? "Too many hosted media sessions are open."
          : statusCode === 409
            ? "Hosted media could not be sealed."
            : "Hosted media is unavailable.",
      data: { code },
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
    statusMessage: "Hosted media request failed.",
  });
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}
