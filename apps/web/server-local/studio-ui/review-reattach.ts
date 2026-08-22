import {
  mediaSessionSchema,
  sha256Schema,
  type MediaSession,
} from "../../../../src/domain/studio-schemas.js";
import {
  createMediaStagingTransport,
  fingerprintRecordingFile,
  MediaUploadClientError,
  uploadMissingMediaParts,
  validateRecordingFile,
  type MediaStagingTransport,
} from "../../app/studio/media-upload.js";

const REATTACHED_MEDIA_TTL_SECONDS = 24 * 60 * 60;

export type ReviewReattachPhase =
  | "fingerprinting"
  | "uploading"
  | "verifying"
  | "binding";

export class ReviewReattachError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReviewReattachError";
  }
}

export interface ReviewReattachInput {
  runId: string;
  expectedSha256: string;
  file: File;
  signal?: AbortSignal;
  transport?: MediaStagingTransport;
  fetchImplementation?: typeof fetch;
  onPhase?: (phase: ReviewReattachPhase) => void;
  onConfirmedBytes?: (bytes: number) => void;
}

function messageFor(code: string): string {
  if (code === "digest_mismatch") {
    return "That file does not match the recording used for this run. The staged copy was deleted.";
  }
  if (code === "reattach_cleanup_failed") {
    return "The mismatched staged copy could not be deleted. Retry cleanup before continuing.";
  }
  if (["empty_file", "file_too_large", "unsupported_extension", "mime_mismatch"].includes(code)) {
    return "Choose the original MP4, MOV, M4V, or WebM recording for this run.";
  }
  return "Studio could not verify and reattach that recording. Try again.";
}

async function bindReviewMedia(
  runId: string,
  mediaSessionId: string,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<MediaSession> {
  const response = await fetchImplementation(
    `/api/runs/${encodeURIComponent(runId)}/media/reattach`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaSessionId }),
      signal,
    },
  );
  if (response.ok) return mediaSessionSchema.parse(await response.json());
  let code = `http_${response.status}`;
  try {
    const body = await response.json() as { data?: { code?: unknown } };
    if (
      typeof body.data?.code === "string"
      && /^[a-z0-9_]{1,80}$/.test(body.data.code)
    ) {
      code = body.data.code;
    }
  } catch {
    // Keep the status-only sanitized code.
  }
  throw new ReviewReattachError(code, messageFor(code));
}

export async function reattachReviewMedia(
  input: ReviewReattachInput,
): Promise<MediaSession> {
  const expectedSha256 = sha256Schema.parse(input.expectedSha256.toLowerCase());
  const validation = validateRecordingFile(input.file);
  if (!validation.ok) {
    throw new ReviewReattachError(validation.code, validation.message);
  }
  const transport = input.transport ?? createMediaStagingTransport(
    input.fetchImplementation,
  );
  let session: MediaSession | undefined;
  try {
    input.onPhase?.("fingerprinting");
    const fileFingerprintSha256 = await fingerprintRecordingFile(
      input.file,
      undefined,
      input.signal,
    );
    session = await transport.create({
      idempotencyKey: crypto.randomUUID(),
      expectedBytes: input.file.size,
      mimeType: validation.mimeType,
      fileFingerprintSha256,
      retention: {
        mode: "retained",
        ttlSeconds: REATTACHED_MEDIA_TTL_SECONDS,
      },
    }, input.signal);
    input.onPhase?.("uploading");
    session = await uploadMissingMediaParts({
      file: input.file,
      session,
      transport,
      signal: input.signal,
      onConfirmed: (confirmed) => {
        session = confirmed;
        input.onConfirmedBytes?.(confirmed.receivedBytes);
      },
    });
    input.onPhase?.("verifying");
    session = await transport.complete(
      session.id,
      input.signal,
      expectedSha256,
    );
    input.onPhase?.("binding");
    return await bindReviewMedia(
      input.runId,
      session.id,
      input.fetchImplementation ?? globalThis.fetch,
      input.signal,
    );
  } catch (error) {
    if (session && !["deleted", "aborted"].includes(session.status)) {
      const deleted = await transport.abort(session.id).catch(() => undefined);
      if (!deleted || !["deleted", "aborted"].includes(deleted.status)) {
        throw new ReviewReattachError(
          "reattach_cleanup_failed",
          messageFor("reattach_cleanup_failed"),
        );
      }
    }
    if (error instanceof ReviewReattachError) throw error;
    if (error instanceof MediaUploadClientError) {
      throw new ReviewReattachError(error.code, messageFor(error.code));
    }
    throw new ReviewReattachError("reattach_failed", messageFor("reattach_failed"));
  }
}
