import {
  hostedMediaCreateResponseSchema,
  hostedMediaOpenSessionSchema,
  hostedMediaOpenSessionsResponseSchema,
  type HostedMediaCreateResponse,
  type HostedMediaOpenSession,
} from "../../../workflows/src/media.js";
import type { HostedMediaView } from "../../../workflows/src/contracts.js";
import { validateRecordingFile } from "../../app/studio/media-upload.js";

export const HOSTED_MEDIA_DRAFT_KEY = "frame-of-mind:hosted:media-upload:v1";

export interface HostedMediaDraft extends HostedMediaCreateResponse {
  schemaVersion: 1;
  declaredSizeBytes: number;
  declaredSha256: string;
  mimeType: "video/mp4" | "video/quicktime" | "video/webm";
  durationSeconds: number;
  retention: "ephemeral" | "retained";
  offset: number;
}

export class HostedMediaClientError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(messageForCode(code));
    this.name = "HostedMediaClientError";
  }
}

export function loadHostedMediaDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
): HostedMediaDraft | undefined {
  try {
    const raw = storage.getItem(HOSTED_MEDIA_DRAFT_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<HostedMediaDraft>;
    const response = hostedMediaOpenSessionSchema.safeParse({
      mediaId: value.mediaId,
      uploadUrl: value.uploadUrl,
      partBytes: value.partBytes,
      sessionExpiresAt: value.sessionExpiresAt,
      declaredSizeBytes: value.declaredSizeBytes,
      declaredSha256: value.declaredSha256,
      mimeType: value.mimeType,
      durationSeconds: value.durationSeconds,
      retention: value.retention,
    });
    if (
      value.schemaVersion !== 1
      || !response.success
      || !Number.isSafeInteger(value.offset)
      || (value.offset as number) < 0
      || (value.offset as number) > (value.declaredSizeBytes ?? -1)
    ) {
      storage.removeItem(HOSTED_MEDIA_DRAFT_KEY);
      return undefined;
    }
    return {
      schemaVersion: 1,
      ...response.data,
      offset: value.offset as number,
    };
  } catch {
    return undefined;
  }
}

export function persistHostedMediaDraft(
  storage: Pick<Storage, "setItem">,
  draft: HostedMediaDraft,
): void {
  storage.setItem(HOSTED_MEDIA_DRAFT_KEY, JSON.stringify(draft));
}

export function clearHostedMediaDraft(
  storage: Pick<Storage, "removeItem">,
): void {
  storage.removeItem(HOSTED_MEDIA_DRAFT_KEY);
}

export async function hashHostedRecording(
  file: File,
  options: {
    signal?: AbortSignal;
    onProgress?: (bytes: number) => void;
    workerFactory?: () => Worker;
  } = {},
): Promise<string> {
  if (options.signal?.aborted) throw abortError();
  const worker = options.workerFactory?.()
    ?? new Worker(new URL("./hosted-sha256.worker.ts", import.meta.url), {
      type: "module",
    });
  return await new Promise<string>((resolve, reject) => {
    const finish = (callback: () => void) => {
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.onerror = () => finish(() => reject(
      new HostedMediaClientError("hosted_media_hash_failed"),
    ));
    worker.onmessage = (event: MessageEvent<{
      type: "progress" | "complete" | "error";
      bytes?: number;
      sha256?: string;
    }>) => {
      if (event.data.type === "progress" && Number.isSafeInteger(event.data.bytes)) {
        options.onProgress?.(event.data.bytes as number);
      } else if (
        event.data.type === "complete"
        && typeof event.data.sha256 === "string"
        && /^[a-f0-9]{64}$/.test(event.data.sha256)
      ) {
        finish(() => resolve(event.data.sha256 as string));
      } else if (event.data.type === "error") {
        finish(() => reject(
          new HostedMediaClientError("hosted_media_hash_failed"),
        ));
      }
    };
    worker.postMessage({ file });
  });
}

export async function queryHostedUploadOffset(
  draft: HostedMediaDraft,
  signal?: AbortSignal,
): Promise<number> {
  const response = await fetch(draft.uploadUrl, {
    method: "PUT",
    headers: { "x-goog-upload-command": "query" },
    signal,
  });
  if (!response.ok) {
    throw new HostedMediaClientError("hosted_media_offset_query_failed");
  }
  const offset = Number(response.headers.get("x-goog-upload-size-received"));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > draft.declaredSizeBytes) {
    throw new HostedMediaClientError("hosted_media_offset_query_invalid");
  }
  return offset;
}

export async function uploadHostedRecording(input: {
  file: File;
  draft: HostedMediaDraft;
  signal?: AbortSignal;
  onProgress: (bytes: number) => void;
  onConfirmed: (offset: number) => void;
}): Promise<void> {
  let offset = await queryHostedUploadOffset(input.draft, input.signal);
  input.onConfirmed(offset);
  while (offset < input.file.size) {
    if (input.signal?.aborted) throw abortError();
    const end = Math.min(offset + input.draft.partBytes, input.file.size);
    const final = end === input.file.size;
    try {
      await uploadPart({
        url: input.draft.uploadUrl,
        body: input.file.slice(offset, end),
        mimeType: input.draft.mimeType,
        offset,
        final,
        signal: input.signal,
        onProgress: (sent) => input.onProgress(offset + sent),
      });
      offset = end;
      input.onConfirmed(offset);
    } catch (error) {
      if (input.signal?.aborted) throw abortError();
      // Browser finalize is indeterminate. The server-side seal query decides
      // whether the exact final bytes were accepted.
      if (final) return;
      const reconciled = await queryHostedUploadOffset(input.draft, input.signal);
      if (reconciled < offset || reconciled > end) throw error;
      offset = reconciled;
      input.onConfirmed(offset);
      if (offset < end) continue;
    }
  }
}

export async function createHostedMedia(
  declaration: Omit<HostedMediaDraft, keyof HostedMediaCreateResponse | "schemaVersion" | "offset">,
  signal?: AbortSignal,
): Promise<HostedMediaDraft> {
  const response = await sameOriginJson("/api/hosted/media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(declaration),
    signal,
  });
  const session = hostedMediaCreateResponseSchema.parse(response);
  return { schemaVersion: 1, ...declaration, ...session, offset: 0 };
}

export async function listOpenHostedMedia(): Promise<HostedMediaOpenSession[]> {
  const value = await sameOriginJson("/api/hosted/media?state=open", {
    method: "GET",
  });
  return hostedMediaOpenSessionsResponseSchema.parse(value).sessions;
}

export async function resumeHostedMedia(
  session: HostedMediaOpenSession,
  signal?: AbortSignal,
): Promise<HostedMediaDraft> {
  const draft: HostedMediaDraft = {
    schemaVersion: 1,
    ...session,
    offset: 0,
  };
  return {
    ...draft,
    offset: await queryHostedUploadOffset(draft, signal),
  };
}

export async function sealHostedMedia(
  mediaId: string,
  signal?: AbortSignal,
): Promise<HostedMediaView> {
  const value = await sameOriginJson(
    `/api/hosted/media/${encodeURIComponent(mediaId)}/seal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal,
    },
  ) as { media?: HostedMediaView };
  if (!value.media) throw new HostedMediaClientError("hosted_media_seal_invalid");
  return value.media;
}

export async function cancelHostedMedia(mediaId: string): Promise<void> {
  await sameOriginJson(`/api/hosted/media/${encodeURIComponent(mediaId)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function abandonHostedMediaOnExit(mediaId: string): boolean {
  try {
    void fetch(`/api/hosted/media/${encodeURIComponent(mediaId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}",
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function mediaDurationSeconds(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number>((resolve, reject) => {
      const documentApi = (globalThis as unknown as {
        document: {
          createElement(name: "video"): {
            preload: string;
            duration: number;
            src: string;
            onloadedmetadata: (() => void) | null;
            onerror: (() => void) | null;
          };
        };
      }).document;
      const video = documentApi.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        const duration = video.duration;
        if (Number.isFinite(duration) && duration > 0 && duration <= 86_400) {
          resolve(duration);
        } else {
          reject(new HostedMediaClientError("hosted_media_duration_invalid"));
        }
      };
      video.onerror = () => reject(
        new HostedMediaClientError("hosted_media_duration_invalid"),
      );
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function withHostedUploadLock<T>(
  mediaId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks) return await work();
  let acquired = false;
  const result = await navigator.locks.request(
    `frame-of-mind:hosted-upload:${mediaId}`,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) return undefined;
      acquired = true;
      return await work();
    },
  );
  if (!acquired) {
    throw new HostedMediaClientError("hosted_media_upload_locked");
  }
  return result as T;
}

export function validateHostedRecording(file: File) {
  return validateRecordingFile(file);
}

async function uploadPart(input: {
  url: string;
  body: Blob;
  mimeType: string;
  offset: number;
  final: boolean;
  signal?: AbortSignal;
  onProgress: (sent: number) => void;
}): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("PUT", input.url);
    xhr.setRequestHeader("content-type", input.mimeType);
    xhr.setRequestHeader("x-goog-upload-offset", String(input.offset));
    xhr.setRequestHeader(
      "x-goog-upload-command",
      input.final ? "upload, finalize" : "upload",
    );
    xhr.upload.onprogress = (event) => input.onProgress(event.loaded);
    xhr.onload = () => {
      input.signal?.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new HostedMediaClientError("hosted_media_upload_failed", xhr.status));
    };
    xhr.onerror = () => reject(new HostedMediaClientError("hosted_media_upload_failed"));
    xhr.ontimeout = () => reject(new HostedMediaClientError("hosted_media_upload_timeout"));
    xhr.onabort = () => reject(abortError());
    xhr.timeout = 60_000;
    input.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(input.body);
  });
}

async function sameOriginJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => undefined) as
    | { data?: { code?: unknown } }
    | undefined;
  if (!response.ok) {
    const code = typeof body?.data?.code === "string"
      && /^[a-z0-9_]{1,120}$/.test(body.data.code)
      ? body.data.code
      : `http_${response.status}`;
    throw new HostedMediaClientError(code, response.status);
  }
  return body;
}

function abortError(): DOMException {
  return new DOMException("Upload paused.", "AbortError");
}

function messageForCode(code: string): string {
  if (code === "hosted_media_upload_locked") {
    return "This upload is already active in another tab.";
  }
  if (code === "hosted_media_open_session_cap_exceeded") {
    return "Finish or cancel an existing upload before starting another.";
  }
  if (code === "media_seal_mismatch") {
    return "The uploaded file did not match the recording you chose. Choose it again.";
  }
  if (code === "hosted_media_duration_invalid") {
    return "The browser could not read a valid recording duration.";
  }
  if (code === "hosted_media_size_exceeded") {
    return "This recording is larger than the upload limit.";
  }
  return "Could not upload this recording. Try again.";
}
