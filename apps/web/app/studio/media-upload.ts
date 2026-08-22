import {
  DEFAULT_MEDIA_PART_SIZE_BYTES,
  MAX_MEDIA_BYTES,
  mediaSessionSchema,
  type MediaCreateRequest,
  type MediaSession,
} from "../../../../src/domain/studio-schemas.js";
import type {
  MediaPartWriteResult,
} from "../../../../src/domain/studio-ports.js";
import { opaqueIdSchema } from "../../../../src/domain/studio-identifiers.js";

export const MEDIA_RESUME_STORAGE_KEY = "frame-of-mind:studio:media-upload";

type SupportedMediaMimeType = MediaCreateRequest["mimeType"];
type RecordingFileMetadata = Pick<File, "name" | "size" | "type">;
type RecordingFile = RecordingFileMetadata & Pick<File, "slice">;
type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const extensionMimeTypes: Record<string, {
  mimeType: SupportedMediaMimeType;
  compatibleDeclaredTypes: readonly string[];
}> = {
  ".mp4": {
    mimeType: "video/mp4",
    compatibleDeclaredTypes: ["video/mp4"],
  },
  ".m4v": {
    mimeType: "video/mp4",
    compatibleDeclaredTypes: ["video/mp4", "video/x-m4v"],
  },
  ".mov": {
    mimeType: "video/quicktime",
    compatibleDeclaredTypes: ["video/quicktime"],
  },
  ".webm": {
    mimeType: "video/webm",
    compatibleDeclaredTypes: ["video/webm"],
  },
};

export class MediaUploadClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MediaUploadClientError";
  }
}

export type RecordingValidation =
  | { ok: true; mimeType: SupportedMediaMimeType }
  | { ok: false; code: string; message: string };

function extensionOf(name: string): string {
  const finalDot = name.lastIndexOf(".");
  return finalDot >= 0 ? name.slice(finalDot).toLowerCase() : "";
}

export function validateRecordingFile(
  file: RecordingFileMetadata,
): RecordingValidation {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return {
      ok: false,
      code: "empty_file",
      message: "Choose a recording with at least one byte.",
    };
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return {
      ok: false,
      code: "file_too_large",
      message: "Choose a recording no larger than 2 GB.",
    };
  }

  const descriptor = extensionMimeTypes[extensionOf(file.name)];
  if (!descriptor) {
    return {
      ok: false,
      code: "unsupported_extension",
      message: "Choose an MP4, MOV, M4V, or WebM recording.",
    };
  }

  const declaredType = file.type.trim().toLowerCase();
  if (
    declaredType
    && declaredType !== "application/octet-stream"
    && !descriptor.compatibleDeclaredTypes.includes(declaredType)
  ) {
    return {
      ok: false,
      code: "mime_mismatch",
      message: "The recording extension and browser-reported type do not agree.",
    };
  }

  return { ok: true, mimeType: descriptor.mimeType };
}

function parseResumeReceipt(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as {
      schemaVersion?: unknown;
      mediaSessionId?: unknown;
    };
    if (parsed.schemaVersion !== 1) return undefined;
    const mediaSessionId = opaqueIdSchema.safeParse(parsed.mediaSessionId);
    return mediaSessionId.success ? mediaSessionId.data : undefined;
  } catch {
    return undefined;
  }
}

export function persistMediaResumeReceipt(
  storage: BrowserStorage,
  mediaSessionId: string,
): boolean {
  try {
    const id = opaqueIdSchema.parse(mediaSessionId);
    storage.setItem(MEDIA_RESUME_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      mediaSessionId: id,
    }));
    return true;
  } catch {
    return false;
  }
}

export function loadMediaResumeReceipt(
  storage: BrowserStorage,
): { mediaSessionId?: string; storageAvailable: boolean } {
  try {
    const id = parseResumeReceipt(storage.getItem(MEDIA_RESUME_STORAGE_KEY));
    if (!id) storage.removeItem(MEDIA_RESUME_STORAGE_KEY);
    return { mediaSessionId: id, storageAvailable: true };
  } catch {
    return { storageAvailable: false };
  }
}

export function clearMediaResumeReceipt(storage: BrowserStorage): boolean {
  try {
    storage.removeItem(MEDIA_RESUME_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Upload paused.", "AbortError");
  }
}

async function sha256Blob(
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  abortIfRequested(signal);
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  abortIfRequested(signal);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function fingerprintRecordingFile(
  file: RecordingFile,
  partSizeBytes = DEFAULT_MEDIA_PART_SIZE_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const partDigests: string[] = [];
  for (let offset = 0; offset < file.size; offset += partSizeBytes) {
    abortIfRequested(signal);
    partDigests.push(await sha256Blob(
      file.slice(offset, Math.min(offset + partSizeBytes, file.size)),
      signal,
    ));
  }
  return sha256Blob(
    new Blob([new TextEncoder().encode(partDigests.join(""))]),
    signal,
  );
}

export async function verifyRecordingForResume(
  file: RecordingFile,
  session: MediaSession,
  signal?: AbortSignal,
  fingerprint: (
    file: RecordingFile,
    partSizeBytes: number,
    signal?: AbortSignal,
  ) => Promise<string> = fingerprintRecordingFile,
): Promise<void> {
  const validation = validateRecordingFile(file);
  if (
    !validation.ok
    || file.size !== session.expectedBytes
    || validation.mimeType !== session.mimeType
  ) {
    throw new MediaUploadClientError(
      "file_metadata_mismatch",
      "Choose the same recording used to start this upload.",
    );
  }

  if (!session.fileFingerprintSha256) {
    throw new MediaUploadClientError(
      "resume_identity_unavailable",
      "This older upload cannot be safely resumed. Delete it and start again.",
    );
  }
  if (
    await fingerprint(file, session.partSizeBytes, signal)
      !== session.fileFingerprintSha256
  ) {
    throw new MediaUploadClientError(
      "file_fingerprint_mismatch",
      "This recording does not match the file selected when staging began.",
    );
  }
}

interface JsonErrorBody {
  statusMessage?: unknown;
  message?: unknown;
}

function safeErrorMessage(
  body: JsonErrorBody | undefined,
  fallback: string,
): string {
  const candidate = typeof body?.statusMessage === "string"
    ? body.statusMessage
    : typeof body?.message === "string"
      ? body.message
      : undefined;
  if (!candidate || candidate.length > 500) return fallback;
  return candidate.replace(
    /[\u0000-\u001F\u007F]/g,
    " ",
  );
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.ok) return await response.json();
  let body: JsonErrorBody | undefined;
  try {
    body = await response.json() as JsonErrorBody;
  } catch {
    body = undefined;
  }
  throw new MediaUploadClientError(
    `http_${response.status}`,
    safeErrorMessage(body, "The local Studio could not complete that request."),
    response.status,
  );
}

export interface MediaStagingTransport {
  create(
    input: MediaCreateRequest,
    signal?: AbortSignal,
  ): Promise<MediaSession>;
  status(id: string, signal?: AbortSignal): Promise<MediaSession>;
  uploadPart(
    id: string,
    part: number,
    offset: number,
    body: Blob,
    mimeType: SupportedMediaMimeType,
    signal?: AbortSignal,
  ): Promise<MediaPartWriteResult>;
  complete(id: string, signal?: AbortSignal): Promise<MediaSession>;
  abort(id: string, signal?: AbortSignal): Promise<MediaSession>;
}

export function createMediaStagingTransport(
  fetchImplementation: typeof fetch = globalThis.fetch,
): MediaStagingTransport {
  async function jsonRequest(
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    return responseJson(await fetchImplementation(path, {
      credentials: "same-origin",
      ...init,
    }));
  }

  return {
    async create(input, signal) {
      return mediaSessionSchema.parse(await jsonRequest("/api/studio/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
      }));
    },
    async status(id, signal) {
      return mediaSessionSchema.parse(await jsonRequest(
        `/api/studio/media/${encodeURIComponent(id)}`,
        { method: "GET", signal },
      ));
    },
    async uploadPart(id, part, offset, body, mimeType, signal) {
      const value = await jsonRequest(
        `/api/studio/media/${encodeURIComponent(id)}/parts/${part}`,
        {
          method: "PUT",
          headers: {
            "content-type": mimeType,
            "upload-offset": String(offset),
          },
          body,
          signal,
        },
      ) as MediaPartWriteResult;
      return {
        ...value,
        session: mediaSessionSchema.parse(value.session),
      };
    },
    async complete(id, signal) {
      await jsonRequest(
        `/api/studio/media/${encodeURIComponent(id)}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal,
        },
      );
      return this.status(id, signal);
    },
    async abort(id, signal) {
      return mediaSessionSchema.parse(await jsonRequest(
        `/api/studio/media/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal,
        },
      ));
    },
  };
}

export async function uploadMissingMediaParts(input: {
  file: RecordingFile;
  session: MediaSession;
  transport: Pick<MediaStagingTransport, "uploadPart">;
  signal?: AbortSignal;
  onConfirmed?: (session: MediaSession) => void;
}): Promise<MediaSession> {
  await verifyRecordingForResume(input.file, input.session, input.signal);
  let session = mediaSessionSchema.parse(input.session);
  const partCount = Math.ceil(
    session.expectedBytes / session.partSizeBytes,
  );

  for (let part = session.parts.length; part < partCount; part += 1) {
    if (input.signal?.aborted) {
      throw new DOMException("Upload paused.", "AbortError");
    }
    const offset = part * session.partSizeBytes;
    const end = Math.min(offset + session.partSizeBytes, session.expectedBytes);
    const result = await input.transport.uploadPart(
      session.id,
      part,
      offset,
      input.file.slice(offset, end),
      session.mimeType,
      input.signal,
    );
    session = mediaSessionSchema.parse(result.session);
    input.onConfirmed?.(session);
  }

  return session;
}
