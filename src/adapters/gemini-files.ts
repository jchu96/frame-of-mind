import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { stat } from "node:fs/promises";
import { FileState } from "@google/genai";
import type { File as GeminiFile } from "@google/genai";
import { z } from "zod";
import { classifyProviderError, classifyProviderResponse, providerErrorDescription, type ProviderError } from "./gemini-error-class.js";

const GEMINI_UPLOAD_ENDPOINT =
  "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_UPLOAD_HOST = "generativelanguage.googleapis.com";
const DEFAULT_UPLOAD_TIMEOUT_MS = 20 * 60_000;
const remoteFileNameSchema = z.string()
  .max(1_000)
  .regex(/^files\/[A-Za-z0-9_-]+$/);

const uploadedFileEnvelopeSchema = z.looseObject({
  file: z.looseObject({
    name: remoteFileNameSchema,
    uri: z.url().refine(
      isTrustedGeminiFileUri,
      "file URI must use the trusted Gemini API host",
    ),
    mimeType: z.string().min(1).optional(),
    sizeBytes: z.string().optional(),
    createTime: z.string().optional(),
    expirationTime: z.string().optional(),
    updateTime: z.string().optional(),
    sha256Hash: z.string().optional(),
    state: z.enum([
      "STATE_UNSPECIFIED",
      "PROCESSING",
      "ACTIVE",
      "FAILED",
    ]).optional(),
  }),
});

type FetchRequestInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | NodeJS.ReadableStream;
  duplex?: "half";
};
type FetchLike = (
  input: string | URL | Request,
  init?: FetchRequestInit,
) => Promise<Response>;

export interface GeminiFileUploader {
  upload(path: string, mimeType: string): Promise<GeminiFile>;
}

export type GeminiUploadCleanup =
  | "not_obtained"
  | "confirmed_deleted"
  | "unconfirmed";

export class GeminiFileError extends Error {
  override readonly name = "GeminiFileError";

  constructor(
    message: string,
    readonly remoteFileName?: string,
    readonly uploadCleanup?: GeminiUploadCleanup,
    readonly telemetryCode?: string,
    readonly provider?: ProviderError,
  ) {
    super(message);
  }
}

export interface GeminiFileUploaderDependencies {
  fetch?: FetchLike;
  fileSize?: (path: string) => Promise<number>;
  openFile?: (path: string) => Readable;
  timeoutMs?: number;
}

export function createGeminiFileUploader(
  apiKey: string,
  dependencies: GeminiFileUploaderDependencies = {},
): GeminiFileUploader {
  const fetchImpl = dependencies.fetch ?? fetchWithStreamingBody;
  const fileSize = dependencies.fileSize ??
    (async (path: string) => (await stat(path)).size);
  const openFile = dependencies.openFile ?? openFileStream;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;

  return {
    async upload(path: string, mimeType: string): Promise<GeminiFile> {
      const size = await fileSize(path);
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw new GeminiFileError(
          "Gemini upload requires a non-empty file with a safe byte size.",
          undefined,
          "not_obtained",
        );
      }

      let startResponse: Response;
      try {
        startResponse = await fetchImpl(GEMINI_UPLOAD_ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(size),
            "X-Goog-Upload-Header-Content-Type": mimeType,
          },
          body: JSON.stringify({
            file: {
              display_name: "frame-of-mind-upload",
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new GeminiFileError(
          `Gemini resumable upload start failed: ${providerErrorDescription(classifyProviderError(error))}.`,
          undefined,
          "not_obtained",
          undefined,
          classifyProviderError(error),
        );
      }
      await assertSuccessfulResponse(startResponse, "resumable upload start");

      const uploadUrl = validateUploadUrl(
        startResponse.headers.get("x-goog-upload-url"),
      );
      let uploadResponse: Response;
      let body: Readable | undefined;
      let bodySettled: Promise<void> | undefined;
      try {
        body = openFile(path);
        // A transport may reject before consuming/opening the file. Own the
        // stream until close, so callers may safely delete temporary media.
        bodySettled = finished(body, { cleanup: true }).catch(() => undefined);
        uploadResponse = await fetchImpl(uploadUrl, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Length": String(size),
            "Content-Type": mimeType,
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
          },
          body,
          duplex: "half",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new GeminiFileError(
          `Gemini upload finalize failed: ${providerErrorDescription(classifyProviderError(error))}; remote cleanup cannot be confirmed.`,
          undefined,
          "unconfirmed",
          undefined,
          classifyProviderError(error),
        );
      } finally {
        body?.destroy();
        await bodySettled;
      }
      if (!uploadResponse.ok) {
        const provider = await classifyProviderResponse(uploadResponse);
        throw new GeminiFileError(
          `Gemini upload finalize failed: ${providerErrorDescription(provider)}; remote cleanup cannot be confirmed.`,
          undefined,
          "unconfirmed",
          `gemini_http_${uploadResponse.status}`,
          provider,
        );
      }

      let payload: unknown;
      try {
        payload = await uploadResponse.json();
      } catch {
        throw new GeminiFileError(
          "Gemini upload finalize returned invalid JSON; remote cleanup cannot be confirmed.",
          undefined,
          "unconfirmed",
        );
      }
      const parsed = uploadedFileEnvelopeSchema.safeParse(payload);
      if (!parsed.success) {
        const namedFile = z.looseObject({
          file: z.looseObject({ name: remoteFileNameSchema }),
        }).safeParse(payload);
        const remoteFileName = namedFile.success
          ? namedFile.data.file.name
          : undefined;
        throw new GeminiFileError(
          remoteFileName
            ? "Gemini upload finalize returned an invalid file record."
            : "Gemini upload finalize returned an invalid file record; remote cleanup cannot be confirmed.",
          remoteFileName,
          "unconfirmed",
        );
      }

      const remote = parsed.data.file;
      return {
        name: remote.name,
        uri: remote.uri,
        mimeType: remote.mimeType ?? mimeType,
        ...(remote.sizeBytes ? { sizeBytes: remote.sizeBytes } : {}),
        ...(remote.createTime ? { createTime: remote.createTime } : {}),
        ...(remote.expirationTime
          ? { expirationTime: remote.expirationTime }
          : {}),
        ...(remote.updateTime ? { updateTime: remote.updateTime } : {}),
        ...(remote.sha256Hash ? { sha256Hash: remote.sha256Hash } : {}),
        ...(remote.state ? { state: toFileState(remote.state) } : {}),
      };
    },
  };
}

function openFileStream(path: string): Readable {
  return createReadStream(path);
}

function fetchWithStreamingBody(
  input: string | URL | Request,
  init?: FetchRequestInit,
): Promise<Response> {
  return globalThis.fetch(input, init as RequestInit);
}

async function assertSuccessfulResponse(response: Response, phase: string): Promise<void> {
  if (!response.ok) {
    const provider = await classifyProviderResponse(response);
    throw new GeminiFileError(
      `Gemini ${phase} failed: ${providerErrorDescription(provider)}.`,
      undefined,
      "not_obtained",
      `gemini_http_${response.status}`,
      provider,
    );
  }
}

function validateUploadUrl(value: string | null): URL {
  if (!value) {
    throw new GeminiFileError(
      "Gemini upload start did not return a resumable URL.",
      undefined,
      "not_obtained",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GeminiFileError(
      "Gemini upload start returned an invalid resumable URL.",
      undefined,
      "not_obtained",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== GEMINI_UPLOAD_HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new GeminiFileError(
      "Gemini upload start returned an untrusted resumable URL.",
      undefined,
      "not_obtained",
    );
  }
  return url;
}

function isTrustedGeminiFileUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === GEMINI_UPLOAD_HOST
      && !url.port
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function toFileState(
  state: z.infer<typeof uploadedFileEnvelopeSchema>["file"]["state"],
): FileState {
  switch (state) {
    case "PROCESSING":
      return FileState.PROCESSING;
    case "ACTIVE":
      return FileState.ACTIVE;
    case "FAILED":
      return FileState.FAILED;
    case "STATE_UNSPECIFIED":
    case undefined:
      return FileState.STATE_UNSPECIFIED;
  }
}
