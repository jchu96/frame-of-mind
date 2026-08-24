import {
  jobCreateRequestSchema,
  MAX_RETAINED_MEDIA_TTL_SECONDS,
  type ComposerPayload,
  type JobCreateRequest,
  type MediaSession,
} from "../../../../src/domain/studio-schemas.js";
import { StudioJobInputUnavailableError } from "../../../../src/domain/studio-errors.js";

export interface ResolvedComposerRecipe {
  recipe: { id: string };
  custom: boolean;
  sha256: string;
  revision: string;
}

export interface TranslateComposerJobInput {
  payload: ComposerPayload;
  mediaSession: MediaSession | undefined;
  resolvedRecipe: ResolvedComposerRecipe | undefined;
  now: string;
}

/**
 * Converts browser-safe composer choices into the exact immutable receipt the
 * worker validates again at execution. It performs no I/O and never invents a
 * context, recipe digest, media digest, or retention lifetime.
 */
export function translateComposerJob(
  input: TranslateComposerJobInput,
): JobCreateRequest {
  const nowMilliseconds = Date.parse(input.now);
  if (!Number.isFinite(nowMilliseconds) || !input.now.endsWith("Z")) {
    throw new StudioJobInputUnavailableError("invalid_check_time");
  }
  if ("custom" in input.payload.recipe) {
    throw new StudioJobInputUnavailableError(
      "custom_recipe_staging_unavailable",
    );
  }

  const media = input.mediaSession;
  if (!media) {
    throw new StudioJobInputUnavailableError("media_not_found");
  }
  if (
    media.id !== input.payload.mediaSessionId
    || media.status !== "sealed"
    || !media.sha256
  ) {
    throw new StudioJobInputUnavailableError("media_not_usable");
  }
  if (Date.parse(media.retention.expiresAt) <= nowMilliseconds) {
    throw new StudioJobInputUnavailableError("media_retention_expired");
  }
  assertRetentionMatches(input.payload.retention, media);

  const resolved = input.resolvedRecipe;
  if (!resolved) {
    throw new StudioJobInputUnavailableError("recipe_not_found");
  }
  if (
    resolved.custom
    || resolved.recipe.id !== input.payload.recipe.id
    || resolved.revision !== input.payload.recipe.revision
  ) {
    throw new StudioJobInputUnavailableError("recipe_receipt_mismatch");
  }

  return composerJobRequest(input.payload, media, media.sha256, resolved);
}

/**
 * Reconstructs the immutable request for an existing idempotency key without
 * requiring its one-shot media to remain usable. The repository still compares
 * the exact immutable digest and rejects a changed request.
 */
export function translateComposerReplay(
  input: TranslateComposerJobInput,
): JobCreateRequest {
  if ("custom" in input.payload.recipe) {
    throw new StudioJobInputUnavailableError(
      "custom_recipe_staging_unavailable",
    );
  }
  const media = input.mediaSession;
  if (
    !media
    || media.id !== input.payload.mediaSessionId
    || !media.sha256
  ) {
    throw new StudioJobInputUnavailableError("media_not_found");
  }
  assertRetentionMatches(input.payload.retention, media);
  const resolved = input.resolvedRecipe;
  if (!resolved) {
    throw new StudioJobInputUnavailableError("recipe_not_found");
  }
  if (
    resolved.custom
    || resolved.recipe.id !== input.payload.recipe.id
    || resolved.revision !== input.payload.recipe.revision
  ) {
    throw new StudioJobInputUnavailableError("recipe_receipt_mismatch");
  }
  return composerJobRequest(input.payload, media, media.sha256, resolved);
}

function composerJobRequest(
  payload: ComposerPayload,
  media: MediaSession,
  mediaSha256: string,
  resolved: ResolvedComposerRecipe,
): JobCreateRequest {
  return jobCreateRequestSchema.parse({
    idempotencyKey: payload.idempotencyKey,
    input: {
      mediaSessionId: media.id,
      mediaSha256,
      context: payload.context,
      recipe: {
        id: resolved.recipe.id,
        custom: false,
        revision: resolved.revision,
        sha256: resolved.sha256,
      },
      model: payload.model,
      ...(payload.focus ? { focus: payload.focus } : {}),
      ...(payload.transcriptOffsetSeconds === undefined
        ? {}
        : {
            transcriptOffsetSeconds: payload.transcriptOffsetSeconds,
          }),
      retention: media.retention,
    },
  });
}

function assertRetentionMatches(
  request: ComposerPayload["retention"],
  media: MediaSession,
): void {
  if (request.mode !== media.retention.mode) {
    throw new StudioJobInputUnavailableError("media_retention_mismatch");
  }
  if (request.mode === "ephemeral") return;
  const stagedTtlSeconds = (
    Date.parse(media.retention.expiresAt) - Date.parse(media.createdAt)
  ) / 1_000;
  if (
    !Number.isSafeInteger(stagedTtlSeconds)
    || stagedTtlSeconds < 60 * 60
    || stagedTtlSeconds > MAX_RETAINED_MEDIA_TTL_SECONDS
    || stagedTtlSeconds !== request.ttlSeconds
  ) {
    throw new StudioJobInputUnavailableError("media_retention_mismatch");
  }
}
